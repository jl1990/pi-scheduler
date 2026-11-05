"use strict";

// A non-UTC zone makes date-only parsing bugs observable on UTC CI runners.
// Node re-reads TZ when it is assigned, and each test file runs in its own process.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	cancelScheduledTask,
	createScheduledTask,
	disableScheduledTask,
	enableScheduledTask,
	markScheduledTaskCompleted,
	markScheduledTaskRunning,
	parseWhen,
	pendingTasks,
	removeScheduledTask,
	sanitizeTasks,
	splitScheduleCommand,
	updateScheduledTask,
	validateTaskSchedule,
} = require("../extensions/scheduler/scheduler-core.cjs");

const NOW = new Date(2026, 6, 5, 12, 0, 0, 0);

function tasksWithIds(...ids) {
	return ids.map((id) => createScheduledTask({ action: "notify", whenText: "10m", message: id }, NOW, () => id));
}

test("an empty task id never selects an arbitrary task", () => {
	const tasks = tasksWithIds("task_aaa", "task_bbb");
	for (const operation of [removeScheduledTask, cancelScheduledTask, disableScheduledTask, enableScheduledTask]) {
		assert.throws(() => operation(tasks, ""), /not found|required/i);
		assert.throws(() => operation(tasks, "   "), /not found|required/i);
	}
	assert.throws(() => updateScheduledTask(tasks, "", { name: "renamed" }, NOW), /not found|required/i);
	assert.equal(tasks.length, 2);
	assert.ok(tasks.every((task) => task.enabled && task.status === "pending" && task.name === undefined));
});

test("an ambiguous id prefix is rejected instead of picking the first match", () => {
	const tasks = tasksWithIds("task_aaa", "task_abb");
	assert.throws(() => removeScheduledTask(tasks, "task_a"), /ambiguous/i);
	assert.throws(() => cancelScheduledTask(tasks, "task_"), /ambiguous/i);
	assert.equal(tasks.length, 2);
	assert.ok(tasks.every((task) => task.status === "pending"));

	assert.equal(removeScheduledTask(tasks, "task_ab").id, "task_abb", "a unique prefix still works");
	assert.equal(tasks.length, 1);
});

test("an exact id wins even when it is also a prefix of another id", () => {
	const tasks = tasksWithIds("task_a", "task_ab");
	assert.equal(cancelScheduledTask(tasks, "task_a").id, "task_a");
	assert.equal(tasks.find((task) => task.id === "task_ab").status, "pending");
});

test("recurring /schedule syntax without :: keeps its recurrence", () => {
	for (const [input, action, payload] of [
		["prompt every 5m check ci", "prompt", "check ci"],
		["shell interval 10m npm test", "shell", "npm test"],
		["every 1h stretch", "notify", "stretch"],
	]) {
		const parsed = splitScheduleCommand(input, NOW);
		assert.equal(parsed.type, "interval", input);
		assert.equal(parsed.action, action, input);
		assert.equal(parsed.payload, payload, input);
		assert.match(parsed.schedule, /^(5m|10m|1h)$/, input);
	}
	assert.equal(splitScheduleCommand("prompt once 5m check ci", NOW).type, "once");
});

test("cron /schedule syntax without :: asks for the separator", () => {
	assert.throws(() => splitScheduleCommand("prompt cron 0 9 * * 1 standup", NOW), /::/);
});

test("one task with an invalid persisted maxRuns does not make the whole store unreadable", () => {
	const good = createScheduledTask({ action: "notify", whenText: "10m", message: "good" }, NOW, () => "good");
	const bad = { ...createScheduledTask({ action: "notify", whenText: "10m", message: "bad" }, NOW, () => "bad"), maxRuns: 0 };
	const sanitized = sanitizeTasks([bad, good], NOW);
	assert.deepEqual(sanitized.map((task) => task.id), ["bad", "good"]);
	const broken = sanitized.find((task) => task.id === "bad");
	assert.equal(broken.status, "failed");
	assert.equal(broken.enabled, false);
	assert.equal(broken.maxRuns, undefined);
	assert.match(broken.lastError, /maxRuns/);
	assert.equal(sanitized.find((task) => task.id === "good").status, "pending");
});

test("re-enabling a finished task through update schedules it again", () => {
	for (const finish of ["fired", "failed", "cancelled"]) {
		const tasks = tasksWithIds("task_done");
		const [task] = tasks;
		if (finish === "cancelled") cancelScheduledTask(tasks, task.id, NOW);
		else {
			markScheduledTaskRunning(tasks, task.id, new Date(NOW.getTime() + 11 * 60_000));
			markScheduledTaskCompleted(tasks, task.id, new Date(NOW.getTime() + 11 * 60_000), finish === "fired" ? "ok" : "error");
			if (finish === "failed") task.status = "failed";
		}
		task.stopReason = "previous run";
		assert.notEqual(task.status, "pending", finish);

		updateScheduledTask(tasks, task.id, { enabled: true }, NOW);
		assert.equal(task.status, "pending", finish);
		assert.equal(task.enabled, true, finish);
		assert.equal(task.stopReason, undefined, finish);
		assert.ok(task.nextRun, `${finish} task must have a next run`);
		assert.deepEqual(pendingTasks(tasks).map((item) => item.id), ["task_done"], finish);
	}
});

test("a date-only schedule means local midnight, not UTC midnight", () => {
	assert.equal(parseWhen("2026-12-01", NOW).dueAtMs, new Date(2026, 11, 1, 0, 0, 0, 0).getTime());
	assert.throws(() => parseWhen("2026-02-30", NOW), /Could not parse|Invalid/);
	assert.throws(() => parseWhen("2026-01-01", NOW), /past/);
});

test("schedules beyond the supported date range fail with a clear message", () => {
	for (const type of ["once", "interval"]) {
		assert.throws(() => validateTaskSchedule(type, "99999999w", NOW), (error) => {
			assert.doesNotMatch(error.message, /Invalid time value/);
			assert.match(error.message, /supported date range/);
			return true;
		});
	}
});
