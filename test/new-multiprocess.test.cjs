"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createMultiprocessHarness } = require("./helpers/multiprocess-harness.cjs");

const ROOT = path.resolve(__dirname, "..");
const waitFor = async (predicate, label, timeout = 8_000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out: ${label}`);
};
const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const shellCommand = (file, body = "run") => `echo ${shQuote(body)} >> ${shQuote(file)}`;

test("two OS processes atomically claim one due occurrence and retain stop-on-success history", async () => {
	const h = await createMultiprocessHarness(ROOT);
	try {
		const first = h.worker("first");
		const second = h.worker("second");
		await first.call("start");
		await first.call("schedule", { action: "shell", type: "interval", schedule: "1s", scope: "cwd", command: shellCommand(h.markerFile, "claimed"), stopOn: "success", wakeOn: "never" });
		await Promise.all([second.call("start")]);
		assert.ok(Date.parse((await h.tasks()).tasks[0].nextRun) > Date.now());
		await waitFor(async () => (await h.tasks()).tasks[0]?.status === "fired", "stop-on-success completion");
		const state = await h.tasks();
		assert.equal((await fs.readFile(h.markerFile, "utf8")).trim().split("\n").length, 1);
		assert.equal(state.tasks[0].runCount, 1);
		assert.equal(state.tasks[0].history.length, 1);
		assert.equal(state.tasks[0].history[0].outcome.status, "success");
	} finally { await h.close(); }
});

test("backoff interval is persisted and honored after another process reloads the state", async () => {
	const h = await createMultiprocessHarness(ROOT);
	try {
		const first = h.worker("first");
		const second = h.worker("second");
		await first.call("start");
		await first.call("schedule", { action: "shell", type: "interval", schedule: "0.3s", scope: "cwd", command: shellCommand(h.markerFile, "backoff"), backoff: { factor: 2, maxInterval: "1s" }, maxRuns: 2 });
		await waitFor(async () => (await h.tasks()).tasks[0]?.runCount === 1, "first run");
		let state = await h.tasks();
		assert.equal(state.tasks[0].backoff.currentIntervalMs, 600);
		assert.ok(Date.parse(state.tasks[0].nextRun) - Date.parse(state.tasks[0].lastRun) >= 550);
		await first.call("shutdown");
		await second.call("start");
		await waitFor(async () => (await h.tasks()).tasks[0]?.runCount === 2, "reloaded second run");
		state = await h.tasks();
		assert.equal(state.tasks[0].backoff.currentIntervalMs, 600);
		assert.equal(state.tasks[0].history.length, 2);
		assert.ok(Date.parse(state.tasks[0].history[1].startedAt) - Date.parse(state.tasks[0].history[0].completedAt) >= 550,
			"reloaded worker must wait for the backed-off delay, not the 300ms base interval");
	} finally { await h.close(); }
});

test("surviving process refresh recovers a crashed owner and an expired deadline prevents restart", async () => {
		{
			const h = await createMultiprocessHarness(ROOT);
			try {
				const owner = h.worker("owner");
				const survivor = h.worker("survivor");
				await owner.call("start");
				await owner.call("schedule", { action: "shell", type: "once", schedule: "0.1s", scope: "cwd", command: `sleep 2; ${shellCommand(h.markerFile, "execution")}`, expiresIn: "0.3s" });
				await waitFor(async () => (await h.tasks()).tasks[0]?.runOwner?.pid === owner.child.pid, "owner claim");
				await survivor.call("start");
				h.crash(owner);
				await owner.exitPromise;
				await waitFor(async () => {
					const task = (await h.tasks()).tasks[0];
					return task.status === "expired";
				}, "deadline expiry", 12_000);
				const state = await h.tasks();
				assert.equal(state.tasks[0].status, "expired");
				assert.equal(state.tasks[0].runCount, 1);
				assert.equal(state.tasks[0].history?.[0]?.outcome.status, "interrupted");
				await assert.rejects(fs.access(h.markerFile));
			} finally { await h.close(); }
		}
});
