"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { harness, until } = require("./helpers/runtime-harness.cjs");

const ROOT = __dirname + "/..";

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

test("an edited in-flight command cannot let its old success stop the replacement job", async () => {
	const gate = deferred();
	let started = false;
	const h = await harness(ROOT, () => { started = true; return gate.promise; });
	try {
		await h.start();
		const created = await h.call("schedule_task", {
			action: "shell", type: "interval", schedule: "0.02s", command: "old-command",
			wakeOn: "never", stopOn: "success",
		});
		await until(() => started, "old command started");
		await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, command: "replacement-command", schedule: "1h" });
		gate.resolve({ code: 0, stdout: "old result", stderr: "", killed: false });
		await until(async () => (await h.tasks())[0]?.runCount === 1, "stale completion recorded");
		const task = (await h.tasks())[0];
		assert.equal(task.status, "pending");
		assert.equal(task.enabled, true, "old result must not stop the replacement command");
		assert.equal(task.stopReason, undefined);
	} finally { await h.close(); }
});

test("an edited in-flight command cannot let its old exception stop the replacement job", async () => {
	const gate = deferred();
	let started = false;
	const h = await harness(ROOT, async () => { started = true; await gate.promise; throw new Error("old execution failed"); });
	try {
		await h.start();
		const created = await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.02s", command: "old-command", wakeOn: "never", stopOn: "failure" });
		await until(() => started, "old command started");
		await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, command: "replacement-command", schedule: "1h" });
		gate.resolve();
		await until(async () => (await h.tasks())[0]?.runCount === 1, "old exception recorded");
		const [task] = await h.tasks();
		assert.equal(task.status, "pending");
		assert.equal(task.enabled, true);
		assert.equal(task.stopReason, undefined);
	} finally { await h.close(); }
});

test("cancel, disable, and remove make in-flight wakes inert", async (t) => {
	for (const action of ["cancel", "disable", "remove"]) for (const wakeOn of ["change", "always", "success", "failure"]) {
		await t.test(`${action}/${wakeOn}`, async () => {
			let calls = 0;
			const gate = deferred();
			const h = await harness(ROOT, () => {
				calls += 1;
				return calls === 1 ? Promise.resolve({ code: 1, stdout: "baseline", stderr: "", killed: false }) : gate.promise;
			});
			try {
				await h.start();
				const created = await h.call("schedule_task", {
					action: "shell", type: "interval", schedule: "0.02s", command: "check",
					wakeOn, followUpPrompt: "do not wake",
				});
				await until(async () => {
					const [task] = await h.tasks();
					return task?.history?.[0] && task.history[0].wakeDisposition !== "pending";
				}, "baseline settled including any wake");
				h.wakes.length = 0;
				await until(() => calls === 2, "second shell started");
				if (action === "remove") await h.call("manage_scheduled_task", { action, id: created.details.task.id });
				else await h.call(action === "cancel" ? "cancel_scheduled_task" : "manage_scheduled_task", action === "cancel" ? { id: created.details.task.id } : { action, id: created.details.task.id });
				gate.resolve({ code: wakeOn === "failure" ? 1 : 0, stdout: "changed", stderr: "", killed: false });
				if (action !== "remove") await until(async () => !(await h.tasks())[0]?.runOwner, "cancelled/disabled execution settled");
				await new Promise((resolve) => setTimeout(resolve, 80));
				assert.equal(h.wakes.length, 0);
				if (action !== "remove") assert.equal((await h.tasks())[0].runOwner, undefined);
			} finally { await h.close(); }
		});
	}
});

test("a shutdown and replacement session suppress callbacks from the old generation", async () => {
	const gate = deferred();
	let started = false;
	const h = await harness(ROOT, () => { started = true; return gate.promise; });
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.02s", command: "check", wakeOn: "always", followUpPrompt: "old session" });
		await until(() => started, "old session shell started");
		await h.events.session_shutdown({}, h.context);
		const oldSessionFile = h.context.sessionManager.getSessionFile();
		h.context.sessionManager.getSessionFile = () => `${oldSessionFile}.replacement`;
		const replacement = { ...h.context, sessionManager: h.context.sessionManager };
		await h.events.session_start({}, replacement);
		gate.resolve({ code: 1, stdout: "late", stderr: "", killed: false });
		await until(async () => (await h.tasks())[0]?.history?.[0]?.wakeDisposition === "session-suppressed", "old session completion recorded");
		assert.equal(h.wakes.length, 0);
	} finally { await h.close(); }
});

test("ABA command edits invalidate the old change baseline", async () => {
	let calls = 0;
	const second = deferred();
	let secondStarted = false;
	const h = await harness(ROOT, () => {
		calls += 1;
		if (calls === 1) return Promise.resolve({ code: 1, stdout: "baseline", stderr: "", killed: false });
		secondStarted = true;
		return second.promise;
	});
	try {
		await h.start();
		const created = await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.02s", command: "A", wakeOn: "change", followUpPrompt: "changed" });
		await until(async () => (await h.tasks())[0]?.runCount === 1, "baseline run");
		await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, schedule: "0.02s" });
		await until(() => secondStarted, "second run");
		await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, command: "B" });
		await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, command: "A", schedule: "1h" });
		second.resolve({ code: 1, stdout: "new result", stderr: "", killed: false });
		await until(async () => (await h.tasks())[0]?.runCount === 2, "ABA completion");
		assert.equal(h.wakes.length, 0);
		assert.equal((await h.tasks())[0].lastResultFingerprint, undefined);
	} finally { await h.close(); }
});

test("renewing a deadline while running replaces the old expiry timer", async () => {
	const gate = deferred();
	let started = false;
	const h = await harness(ROOT, () => { started = true; return gate.promise; });
	try {
		await h.start();
		const created = await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.02s", command: "check", expiresIn: "0.06s" });
		await until(() => started, "deadline task started");
		await new Promise((resolve) => setTimeout(resolve, 90));
		await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, expiresIn: "1s", schedule: "1h" });
		gate.resolve({ code: 0, stdout: "done", stderr: "", killed: false });
		await until(async () => (await h.tasks())[0]?.runCount === 1, "renewed completion");
		assert.equal((await h.tasks())[0].status, "pending");
		assert.equal((await h.tasks())[0].enabled, true);
	} finally { await h.close(); }
});

test("wake delivery failure is recorded once after completed history is written", async () => {
	let calls = 0;
	const h = await harness(ROOT, () => Promise.resolve({ code: 1, stdout: calls++ === 0 ? "same" : "changed", stderr: "", killed: false }));
	try {
		await h.start();
		const created = await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.02s", command: "check", wakeOn: "change", followUpPrompt: "wake", maxRuns: 2 });
		h.wakes.push = () => { throw new Error("delivery unavailable"); };
		await until(async () => (await h.tasks())[0]?.history?.[1]?.wakeDisposition === "failed", "failed wake recorded");
		const task = (await h.tasks())[0];
		assert.equal(task.history.length, 2);
		assert.equal(task.history.filter((run) => run.wakeDisposition === "failed").length, 1);
		assert.match(task.history[1].wakeError, /delivery unavailable/);
	} finally { await h.close(); }
});

test("a finished once task does not retain an expiry timer", async () => {
	const h = await harness(ROOT, async () => ({ code: 0, stdout: "done", stderr: "", killed: false }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", type: "once", schedule: "0.02s", command: "check", expiresIn: "0.15s" });
		await until(async () => (await h.tasks())[0]?.status === "fired", "once finished");
		const before = JSON.parse(await fs.readFile(h.stateFile, "utf8")).revision;
		await new Promise((resolve) => setTimeout(resolve, 220));
		const after = JSON.parse(await fs.readFile(h.stateFile, "utf8")).revision;
		const task = (await h.tasks())[0];
		assert.equal(task.status, "fired");
		assert.equal(task.runCount, 1);
		assert.equal(after, before, "finished task must not retain an expiry callback");
	} finally { await h.close(); }
});

test("an in-flight wake policy edit applies exactly the new policy", async (t) => {
	const cases = [
		["change", "always", 0, "success", "delivered"],
		["change", "failure", 1, "failure", "delivered"],
		["always", "never", 0, "success", "suppressed"],
		["never", "always", 0, "success", "delivered"],
	];
	for (const [from, to, code, label, disposition] of cases) {
		await t.test(`${from}->${to} (${label})`, async () => {
			const gate = deferred();
			let started = false;
			const h = await harness(ROOT, () => { started = true; return gate.promise; });
			try {
				await h.start();
				const created = await h.call("schedule_task", {
					action: "shell", type: "once", schedule: "0.02s", command: "check",
					wakeOn: from, followUpPrompt: "policy edit",
				});
				await until(() => started, "policy-edited shell started");
				await h.call("manage_scheduled_task", { action: "update", id: created.details.task.id, wakeOn: to });
				gate.resolve({ code, stdout: label, stderr: "", killed: false });
				await until(async () => {
					const task = (await h.tasks())[0];
					return task?.runOwner === undefined && task?.history?.[0]?.wakeDisposition === disposition;
				}, "settled wake disposition");
				assert.equal(h.wakes.length, disposition === "delivered" ? 1 : 0);
			} finally { await h.close(); }
		});
	}
});

test("wakeOn=change and stopOn=success remain independent on the first successful run", async () => {
	const h = await harness(ROOT, async () => ({ code: 0, stdout: "success", stderr: "", killed: false }));
	try {
		await h.start();
		await h.call("schedule_task", {
			action: "shell", type: "interval", schedule: "0.02s", command: "check",
			wakeOn: "change", stopOn: "success", followUpPrompt: "should not wake baseline",
		});
		await until(async () => (await h.tasks())[0]?.status === "fired", "first successful stop");
		const task = (await h.tasks())[0];
		assert.equal(h.wakes.length, 0);
		assert.equal(task.history[0].wakeDisposition, "suppressed");
		assert.equal(task.enabled, false);
		assert.equal(task.runCount, 1);
		assert.ok(task.stopReason, "recurrence must stop because of stopOn, not because it is one-shot");
	} finally { await h.close(); }
});
