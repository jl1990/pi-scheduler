"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extensions/scheduler/scheduler-core.cjs");

const NOW = new Date("2026-07-05T12:00:00.000Z");

test("completion does not re-enable a recurring task disabled while running", () => {
	const task = core.createScheduledTask(
		{ action: "notify", type: "interval", schedule: "1m", message: "check" },
		NOW,
		() => "task-disable-race",
	);
	const tasks = [task];
	core.markScheduledTaskRunning(tasks, task.id, NOW, { runOwner: { pid: 1, attemptId: "attempt" } });
	core.disableScheduledTask(tasks, task.id, new Date(NOW.getTime() + 1_000));
	assert.equal(task.status, "running");
	core.markScheduledTaskCompleted(tasks, task.id, new Date(NOW.getTime() + 2_000), { ok: true });
	assert.equal(task.enabled, false);
	assert.equal(task.status, "pending");
	assert.equal(task.nextRun, undefined);
	assert.equal(task.runCount, 1);
});

test("completion of a cancelled in-flight task clears ownership", () => {
	const task = core.createScheduledTask(
		{ action: "shell", type: "once", schedule: "1m", command: "true" },
		NOW,
		() => "task-cancel-race",
	);
	const tasks = [task];
	core.markScheduledTaskRunning(tasks, task.id, NOW, { runOwner: { pid: 1, attemptId: "attempt" } });
	core.cancelScheduledTask(tasks, task.id, new Date(NOW.getTime() + 1_000));
	core.markScheduledTaskCompleted(tasks, task.id, new Date(NOW.getTime() + 2_000), { ok: true });
	assert.equal(task.status, "cancelled");
	assert.equal(task.runOwner, undefined);
	assert.equal(task.startedAt, undefined);
});

for (const type of ["once", "interval"]) {
	test(`failure of a cancelled in-flight ${type} task preserves cancellation`, () => {
		const task = core.createScheduledTask(
			{ action: "shell", type, schedule: "1m", command: "false" },
			NOW,
			() => `task-cancel-failure-${type}`,
		);
		const tasks = [task];
		core.markScheduledTaskRunning(tasks, task.id, NOW, { runOwner: { pid: 1, attemptId: "attempt" } });
		core.cancelScheduledTask(tasks, task.id, new Date(NOW.getTime() + 1_000));
		core.markScheduledTaskFailed(tasks, task.id, new Date(NOW.getTime() + 2_000), new Error("execution failed"));
		assert.equal(task.enabled, false);
		assert.equal(task.status, "cancelled");
		assert.equal(task.runOwner, undefined);
		assert.equal(task.startedAt, undefined);
		assert.equal(task.runCount, 0);
		assert.equal(task.lastError, undefined);
	});
}
