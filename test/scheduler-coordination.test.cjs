"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const core = require("../extensions/scheduler/scheduler-core.cjs");
const {
	createRefreshLoop,
	reconcileSnapshot,
	refreshSchedulerState,
} = require("../extensions/scheduler/scheduler-coordination.cjs");
const { createTaskStore } = require("../extensions/scheduler/task-store.cjs");

const NOW = new Date("2026-07-05T12:00:00.000Z");

async function temporaryStore(t) {
	const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-coordination-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return createTaskStore({ stateFile: join(dir, "tasks.json"), sanitize: core.sanitizeTasks });
}

test("listing a newly discovered external task also reconciles its timer", async (t) => {
	const store = await temporaryStore(t);
	let revision = 0;
	let tasks = [];
	const armed = [];

	await store.transact((current) => {
		current.push(
			core.createScheduledTask(
				{ action: "notify", type: "once", schedule: "1m", message: "external", scope: "cwd", cwd: "/project" },
				NOW,
				() => "external-task",
			),
		);
	});

	// This is the same changed-state load used by /schedules and list_scheduled_tasks.
	const changed = reconcileSnapshot(
		await store.read(),
		revision,
		(nextTasks, nextRevision) => {
			tasks = nextTasks;
			revision = nextRevision;
		},
		() => armed.push(...core.pendingTasks(tasks).map((task) => task.id)),
	);
	assert.equal(changed, true);
	assert.deepEqual(armed, ["external-task"]);

	// A later periodic refresh sees no new revision, but the task is already armed.
	assert.equal(reconcileSnapshot(await store.read(), revision, () => assert.fail("must not reinstall"), () => assert.fail("must not reconcile")), false);
});

test("a surviving process refresh recovers a dead owner and re-arms the recurring task", async (t) => {
	const store = await temporaryStore(t);
	await store.transact((tasks) => {
		const task = core.createScheduledTask(
			{ action: "notify", type: "interval", schedule: "1m", message: "shared", scope: "cwd", cwd: "/project" },
			NOW,
			() => "abandoned-running",
		);
		tasks.push(task);
		core.markScheduledTaskRunning(tasks, task.id, NOW, { runOwner: { pid: 99999999, attemptId: "dead" } });
	});

	const initial = await store.read();
	let revision = initial.revision;
	let tasks = initial.tasks;
	let intervalCallback;
	let intervalDelay;
	let cleared = false;
	let unrefed = false;
	const armed = [];

	const loop = createRefreshLoop({
		intervalMs: 5_000,
		run: () =>
			refreshSchedulerState({
				store,
				currentRevision: () => revision,
				isOwnerActive: () => false,
				recoverInterrupted: core.recoverInterruptedTasks,
				now: () => new Date(NOW.getTime() + 2_000),
				install: (nextTasks, nextRevision) => {
					tasks = nextTasks;
					revision = nextRevision;
				},
				reconcile: () => armed.push(...core.pendingTasks(tasks).map((task) => task.id)),
			}),
		setInterval: (callback, delay) => {
			intervalCallback = callback;
			intervalDelay = delay;
			return { unref: () => (unrefed = true) };
		},
		clearInterval: () => (cleared = true),
	});

	loop.start(1);
	assert.equal(intervalDelay, 5_000);
	assert.equal(unrefed, true);
	await intervalCallback();

	assert.equal(revision, initial.revision + 1);
	assert.equal(tasks[0].status, "pending");
	assert.equal(tasks[0].runOwner, undefined);
	assert.deepEqual(armed, ["abandoned-running"]);
	assert.equal((await store.read()).tasks[0].status, "pending");

	const recoveredRevision = revision;
	await intervalCallback();
	assert.equal(revision, recoveredRevision, "ordinary refreshes must not rewrite unchanged state");
	assert.deepEqual(armed, ["abandoned-running"]);

	loop.stop();
	assert.equal(cleared, true);
});

test("recovery clears a dead owner while preserving a disabled recurring task", async (t) => {
	const store = await temporaryStore(t);
	await store.transact((tasks) => {
		const task = core.createScheduledTask(
			{ action: "notify", type: "interval", schedule: "1m", message: "shared" },
			NOW,
			() => "disabled-running",
		);
		tasks.push(task);
		core.markScheduledTaskRunning(tasks, task.id, NOW, { runOwner: { pid: 99999999, attemptId: "dead" } });
		core.disableScheduledTask(tasks, task.id, new Date(NOW.getTime() + 1_000));
	});

	const recovered = await store.transact((tasks) =>
		core.recoverInterruptedTasks(tasks, new Date(NOW.getTime() + 2_000), { isOwnerActive: () => false }),
	);
	assert.equal(recovered.result.length, 1);
	let task = recovered.tasks[0];
	assert.equal(task.enabled, false);
	assert.equal(task.status, "pending");
	assert.equal(task.runOwner, undefined);
	assert.equal(task.nextRun, undefined);

	const enabled = await store.transact((tasks) => core.enableScheduledTask(tasks, task.id, new Date(NOW.getTime() + 3_000)));
	task = enabled.result;
	assert.equal(task.enabled, true);
	assert.equal(task.status, "pending");
	assert.ok(task.nextRun);
});
