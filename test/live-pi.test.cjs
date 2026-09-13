const test = require("node:test");
const assert = require("node:assert/strict");
const { startLivePi } = require("./helpers/live-pi-session.cjs");

const live = process.env.PI_SCHEDULER_LIVE_TESTS === "1";
const opts = live ? {} : { skip: "set PI_SCHEDULER_LIVE_TESTS=1 to run installed-Pi smoke tests" };

test("installed Pi loads scheduler and validates the combined tool schema", opts, async () => {
	const pi = await startLivePi();
	try {
		const names = pi.tools.map((tool) => tool.name);
		for (const name of ["cancel_scheduled_task", "list_scheduled_tasks", "manage_scheduled_task", "schedule_task"]) assert.ok(names.includes(name), `${name} is registered by Pi`);
		const manage = pi.tool("manage_scheduled_task");
		assert.ok(manage.parameters.properties.backoff, "backoff is in Pi's registered schema");
		assert.ok(manage.parameters.properties.expiresIn, "expiresIn is in Pi's registered schema");
		assert.equal(pi.valid(manage.parameters, { action: "update", id: "task_x", backoff: null, expiresIn: null }), true);
		assert.equal(pi.valid(manage.parameters, { action: "update", id: "task_x", wakeOn: "sometimes" }), false);
		assert.equal(pi.valid(manage.parameters, { action: "update", id: "task_x", timeoutMs: 999 }), false);

		const schedule = pi.tool("schedule_task");
		const created = await schedule.execute("schema", {
			action: "notify", type: "interval", schedule: "1h", scope: "cwd", message: "schema probe",
			backoff: { factor: 2, maxInterval: "5h" }, expiresIn: "2h",
		}, undefined, undefined);
		assert.match(created.content[0].text, /Scheduled notify\/interval task/);
		const id = created.details.task.id;
		const updated = await manage.execute("clear-null", { action: "update", id, backoff: null, expiresIn: null }, undefined, undefined);
		assert.match(updated.content[0].text, /update scheduled task/);
		assert.equal(updated.details.task.backoff, undefined);
		assert.equal(updated.details.task.expiresAt, undefined);
	} finally {
		await pi.close();
	}
});

test("installed Pi executes scheduled shell stdout/stderr and reports timeout", opts, async () => {
	const pi = await startLivePi();
	try {
		const schedule = pi.tool("schedule_task");
		const scheduled = await schedule.execute("shell", {
			action: "shell", type: "once", schedule: "1s", scope: "cwd",
			command: "printf live-stdout; printf live-stderr >&2", cwd: pi.cwd,
		}, undefined, undefined);
		const id = scheduled.details.task.id;
		const deadline = Date.now() + 2500;
		let persisted;
		do {
			persisted = JSON.parse(require("node:fs").readFileSync(pi.stateFile, "utf8")).tasks.find((entry) => entry.id === id);
			if (persisted?.history?.length) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		} while (Date.now() < deadline);
		const listed = await pi.tool("list_scheduled_tasks").execute("list", { id, includeAll: true, includeHistory: true }, undefined, undefined);
		const task = listed.details.tasks[0];
		assert.equal(task.id, id);
		assert.ok(persisted?.history?.length, "Pi scheduler persisted a run history entry");
		const shellResult = persisted.result;
		assert.equal(shellResult.stdout, "live-stdout");
		assert.equal(shellResult.stderr, "live-stderr");
		assert.equal(shellResult.code, 0);

		const timeoutScheduled = await schedule.execute("timeout", {
			action: "shell", type: "once", schedule: "1s", scope: "cwd", command: "sleep 2",
			timeoutMs: 1000, wakeOn: "never", cwd: pi.cwd,
		}, undefined, undefined);
		const timeoutId = timeoutScheduled.details.task.id;
		const timeoutDeadline = Date.now() + 6000;
		let timeoutPersisted;
		do {
			timeoutPersisted = JSON.parse(require("node:fs").readFileSync(pi.stateFile, "utf8")).tasks.find((entry) => entry.id === timeoutId);
			if (timeoutPersisted?.history?.length) break;
			await new Promise((resolve) => setTimeout(resolve, 30));
		} while (Date.now() < timeoutDeadline);
		assert.ok(timeoutPersisted?.history?.length, "scheduled timeout must finish and persist history");
		assert.equal(timeoutPersisted.result.killed, true);
		assert.equal(timeoutPersisted.history.at(-1).outcome.status, "error");
	} finally {
		await pi.close();
	}
});
