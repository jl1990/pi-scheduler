const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { resolve } = require("node:path");
const { harness, until } = require("./helpers/runtime-harness.cjs");

const ROOT = resolve(__dirname, "..");

test("runtime interval backoff advances timers and survives scheduler restart", async () => {
	const starts = [];
	const h = await harness(ROOT, async () => {
		starts.push(Date.now());
		return { code: 0, stdout: "ok", stderr: "" };
	});
	try {
		await h.start();
		await h.call("schedule_task", {
			action: "shell", type: "interval", schedule: "0.05s", command: "true",
			backoff: { factor: 2, maxInterval: "0.2s" }, maxRuns: 4, scope: "session",
		});
		await until(async () => (await h.tasks())[0]?.runCount === 1, "first backoff run");
		let task = (await h.tasks())[0];
		assert.equal(task.backoff.currentIntervalMs, 100);
		assert.ok(Date.parse(task.nextRun) - Date.parse(task.lastRun) >= 90);
		await until(async () => (await h.tasks())[0]?.runCount === 2, "second backoff run");
		task = (await h.tasks())[0];
		assert.equal(task.backoff.currentIntervalMs, 200);
		assert.ok(Date.parse(task.nextRun) - Date.parse(task.lastRun) >= 180);
		assert.ok(starts.length >= 2);

		await h.events.session_shutdown({}, h.context);
		await h.start();
		task = (await h.tasks())[0];
		assert.equal(task.runCount, 2);
		assert.equal(task.backoff.currentIntervalMs, 200);
		await until(async () => (await h.tasks())[0]?.runCount === 3, "post-restart backoff run");
	} finally {
		await h.close();
	}
});

test("malformed persisted backoff is isolated and does not create unbounded scheduling", async () => {
	const h = await harness(ROOT, async () => ({ code: 0, stdout: "ok", stderr: "" }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.05s", command: "true", scope: "session" });
		const state = JSON.parse(await fs.readFile(h.stateFile, "utf8"));
		state.tasks[0].backoff = { factor: Infinity, maxInterval: Number.MAX_SAFE_INTEGER };
		await fs.writeFile(h.stateFile, JSON.stringify(state));
		await h.events.session_shutdown({}, h.context);
		await h.start();
		const [task] = await h.tasks();
		assert.equal(task.status, "failed");
		assert.equal(task.enabled, false);
		assert.equal(task.backoff, undefined);
	} finally {
		await h.close();
	}
});
