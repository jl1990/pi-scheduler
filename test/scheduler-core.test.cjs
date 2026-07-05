const test = require("node:test");
const assert = require("node:assert/strict");

const {
	parseWhen,
	splitScheduleCommand,
	createScheduledTask,
	cancelScheduledTask,
	markScheduledTaskFired,
	formatTaskList,
	pendingTasks,
	dueTasks,
} = require("../extensions/scheduler/scheduler-core.cjs");

const NOW = new Date(2026, 6, 5, 12, 0, 0, 0);

function ms(minutes) {
	return minutes * 60 * 1000;
}

function localAt(daysFromNow, hour, minute = 0) {
	const d = new Date(NOW.getTime());
	d.setDate(d.getDate() + daysFromNow);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
}

test("parseWhen handles relative durations", () => {
	assert.equal(parseWhen("5m", NOW).dueAtMs, NOW.getTime() + ms(5));
	assert.equal(parseWhen("in 5 minutes", NOW).dueAtMs, NOW.getTime() + ms(5));
	assert.equal(parseWhen("1h30m", NOW).dueAtMs, NOW.getTime() + ms(90));
	assert.equal(parseWhen("2 days", NOW).dueAtMs, NOW.getTime() + ms(2 * 24 * 60));
});

test("parseWhen handles clock times", () => {
	assert.equal(parseWhen("14:30", NOW).dueAtMs, localAt(0, 14, 30));
	assert.equal(parseWhen("9am", NOW).dueAtMs, localAt(1, 9, 0));
	assert.equal(parseWhen("tomorrow at 9am", NOW).dueAtMs, localAt(1, 9, 0));
});

test("parseWhen rejects invalid or past inputs", () => {
	assert.throws(() => parseWhen("nonsense", NOW), /Could not parse/);
	assert.throws(() => parseWhen("2020-01-01T00:00:00Z", NOW), /past/);
});

test("splitScheduleCommand separates optional action, when, and payload", () => {
	assert.deepEqual(splitScheduleCommand("in 5 minutes stretch", NOW), {
		action: "notify",
		whenText: "in 5 minutes",
		payload: "stretch",
	});
	assert.deepEqual(splitScheduleCommand("prompt 5m summarize this session", NOW), {
		action: "prompt",
		whenText: "5m",
		payload: "summarize this session",
	});
	assert.deepEqual(splitScheduleCommand("shell at 14:30 npm test", NOW), {
		action: "shell",
		whenText: "at 14:30",
		payload: "npm test",
	});
	assert.deepEqual(splitScheduleCommand("prompt tomorrow at 9am check build", NOW), {
		action: "prompt",
		whenText: "tomorrow at 9am",
		payload: "check build",
	});
});

test("splitScheduleCommand supports :: separators for complex payloads", () => {
	assert.deepEqual(splitScheduleCommand("shell in 10m :: echo 'hello world' && date", NOW), {
		action: "shell",
		whenText: "in 10m",
		payload: "echo 'hello world' && date",
	});
	assert.deepEqual(splitScheduleCommand("2026-07-06T10:00:00 :: absolute default notify", NOW), {
		action: "notify",
		whenText: "2026-07-06T10:00:00",
		payload: "absolute default notify",
	});
});

test("createScheduledTask validates action payloads", () => {
	const notify = createScheduledTask(
		{ action: "notify", whenText: "5m", message: "Take a break", cwd: "/tmp/project" },
		NOW,
		() => "task_notify",
	);
	assert.equal(notify.id, "task_notify");
	assert.equal(notify.status, "pending");
	assert.equal(notify.action, "notify");
	assert.equal(notify.message, "Take a break");
	assert.equal(new Date(notify.dueAt).getTime(), NOW.getTime() + ms(5));
	assert.equal(notify.cwd, "/tmp/project");

	const prompt = createScheduledTask(
		{ action: "prompt", whenText: "10m", prompt: "Summarize progress" },
		NOW,
		() => "task_prompt",
	);
	assert.equal(prompt.prompt, "Summarize progress");

	const shell = createScheduledTask(
		{
			action: "shell",
			whenText: "15m",
			command: "npm test",
			timeoutMs: 1000,
			followUpPrompt: "Review the test result and decide next steps.",
		},
		NOW,
		() => "task_shell",
	);
	assert.equal(shell.command, "npm test");
	assert.equal(shell.timeoutMs, 1000);
	assert.equal(shell.followUpPrompt, "Review the test result and decide next steps.");

	assert.throws(() => createScheduledTask({ action: "prompt", whenText: "5m" }, NOW), /prompt is required/);
	assert.throws(() => createScheduledTask({ action: "shell", whenText: "5m" }, NOW), /command is required/);
});

test("task lifecycle helpers update pending tasks", () => {
	const tasks = [
		createScheduledTask({ action: "notify", whenText: "5m", message: "A" }, NOW, () => "a"),
		createScheduledTask({ action: "prompt", whenText: "10m", prompt: "B" }, NOW, () => "b"),
	];

	assert.deepEqual(pendingTasks(tasks).map((t) => t.id), ["a", "b"]);
	assert.deepEqual(dueTasks(tasks, new Date(NOW.getTime() + ms(6))).map((t) => t.id), ["a"]);

	const cancelled = cancelScheduledTask(tasks, "b", NOW);
	assert.equal(cancelled.id, "b");
	assert.equal(tasks[1].status, "cancelled");
	assert.equal(typeof tasks[1].cancelledAt, "string");

	const fired = markScheduledTaskFired(tasks, "a", NOW, { ok: true });
	assert.equal(fired.status, "fired");
	assert.deepEqual(fired.result, { ok: true });
	assert.throws(() => cancelScheduledTask(tasks, "missing", NOW), /not found/);
});

test("formatTaskList is readable and sorted by due time", () => {
	const tasks = [
		createScheduledTask({ action: "prompt", whenText: "10m", prompt: "B" }, NOW, () => "b"),
		createScheduledTask({ action: "notify", whenText: "5m", message: "A" }, NOW, () => "a"),
	];
	const output = formatTaskList(tasks, NOW);
	assert.match(output, /a/);
	assert.match(output, /A/);
	assert.match(output, /b/);
	assert.match(output, /prompt/);
	assert.ok(output.indexOf("A") < output.indexOf("B"));
});
