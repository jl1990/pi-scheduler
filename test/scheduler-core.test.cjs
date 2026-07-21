const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const {
	parseWhen,
	parseDurationMs,
	validateTaskSchedule,
	splitScheduleCommand,
	createScheduledTask,
	cancelScheduledTask,
	enableScheduledTask,
	disableScheduledTask,
	removeScheduledTask,
	updateScheduledTask,
	markScheduledTaskRunning,
	markScheduledTaskCompleted,
	markScheduledTaskFailed,
	formatTaskList,
	pendingTasks,
	dueTasks,
	sanitizeTasks,
	shouldWakeForShellResult,
	formatAbsoluteTime,
} = require("../extensions/scheduler/scheduler-core.cjs");

const NOW = new Date(2026, 6, 5, 12, 0, 0, 0);

function minutes(value) {
	return value * 60 * 1000;
}

function localAt(daysFromNow, hour, minute = 0) {
	const d = new Date(NOW.getTime());
	d.setDate(d.getDate() + daysFromNow);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
}

test("parseWhen handles relative durations", () => {
	assert.equal(parseWhen("5m", NOW).dueAtMs, NOW.getTime() + minutes(5));
	assert.equal(parseWhen("+5m", NOW).dueAtMs, NOW.getTime() + minutes(5));
	assert.equal(parseWhen("in 5 minutes", NOW).dueAtMs, NOW.getTime() + minutes(5));
	assert.equal(parseWhen("1h30m", NOW).dueAtMs, NOW.getTime() + minutes(90));
	assert.equal(parseWhen("2 days", NOW).dueAtMs, NOW.getTime() + minutes(2 * 24 * 60));
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

test("validateTaskSchedule supports once, interval, and cron", () => {
	const once = validateTaskSchedule("once", "5m", NOW);
	assert.equal(once.type, "once");
	assert.equal(Date.parse(once.nextRun), NOW.getTime() + minutes(5));

	const interval = validateTaskSchedule("interval", "10m", NOW);
	assert.equal(interval.type, "interval");
	assert.equal(interval.intervalMs, minutes(10));
	assert.equal(Date.parse(interval.nextRun), NOW.getTime() + minutes(10));

	const cron = validateTaskSchedule("cron", "0 */5 * * * *", NOW);
	assert.equal(cron.type, "cron");
	assert.ok(Date.parse(cron.nextRun) > NOW.getTime());
	assert.throws(() => validateTaskSchedule("cron", "not cron", NOW), /Invalid cron/);
	assert.throws(() => validateTaskSchedule("interval", "tomorrow", NOW), /Invalid interval/);
});

test("scheduler core resolves croner when loaded through a preserved symlink", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-scheduler-preserve-symlink-"));
	try {
		const linkedCore = join(tmp, "node_modules", "@jl1990", "pi-scheduler", "extensions", "scheduler", "scheduler-core.cjs");
		mkdirSync(dirname(linkedCore), { recursive: true });
		symlinkSync(resolve(__dirname, "..", "extensions", "scheduler", "scheduler-core.cjs"), linkedCore);

		const script = [
			`const core = require(${JSON.stringify(linkedCore)});`,
			`const result = core.validateTaskSchedule("cron", "0 */5 * * * *", new Date("2026-07-05T12:00:00Z"));`,
			`console.log(result.type);`,
		].join("\n");
		const result = spawnSync(process.execPath, ["--preserve-symlinks", "-e", script], {
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /cron/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("splitScheduleCommand separates optional action, type, schedule, and payload", () => {
	assert.deepEqual(splitScheduleCommand("in 5 minutes stretch", NOW), {
		action: "notify",
		type: "once",
		schedule: "in 5 minutes",
		whenText: "in 5 minutes",
		payload: "stretch",
	});
	assert.deepEqual(splitScheduleCommand("prompt 5m summarize this session", NOW), {
		action: "prompt",
		type: "once",
		schedule: "5m",
		whenText: "5m",
		payload: "summarize this session",
	});
	assert.deepEqual(splitScheduleCommand("shell at 14:30 npm test", NOW), {
		action: "shell",
		type: "once",
		schedule: "at 14:30",
		whenText: "at 14:30",
		payload: "npm test",
	});
	assert.deepEqual(splitScheduleCommand("prompt tomorrow at 9am check build", NOW), {
		action: "prompt",
		type: "once",
		schedule: "tomorrow at 9am",
		whenText: "tomorrow at 9am",
		payload: "check build",
	});
});

test("splitScheduleCommand supports :: separators and recurring syntax", () => {
	assert.deepEqual(splitScheduleCommand("shell in 10m :: echo 'hello world' && date", NOW), {
		action: "shell",
		type: "once",
		schedule: "in 10m",
		whenText: "in 10m",
		payload: "echo 'hello world' && date",
	});
	assert.deepEqual(splitScheduleCommand("2026-07-06T10:00:00 :: absolute default notify", NOW), {
		action: "notify",
		type: "once",
		schedule: "2026-07-06T10:00:00",
		whenText: "2026-07-06T10:00:00",
		payload: "absolute default notify",
	});
	assert.deepEqual(splitScheduleCommand("shell every 5m :: date", NOW), {
		action: "shell",
		type: "interval",
		schedule: "5m",
		whenText: "5m",
		payload: "date",
	});
	assert.deepEqual(splitScheduleCommand("prompt interval 10m :: check pipeline", NOW), {
		action: "prompt",
		type: "interval",
		schedule: "10m",
		whenText: "10m",
		payload: "check pipeline",
	});
	assert.deepEqual(splitScheduleCommand("prompt cron 0 */5 * * * * :: check pipeline", NOW), {
		action: "prompt",
		type: "cron",
		schedule: "0 */5 * * * *",
		whenText: "0 */5 * * * *",
		payload: "check pipeline",
	});
});

test("createScheduledTask validates action payloads and task metadata", () => {
	const notify = createScheduledTask(
		{
			action: "notify",
			whenText: "5m",
			message: "Take a break",
			cwd: "/tmp/project",
			name: "break",
			description: "Human reminder",
			scope: "cwd",
			maxRuns: 3,
		},
		NOW,
		() => "task_notify",
	);
	assert.equal(notify.id, "task_notify");
	assert.equal(notify.status, "pending");
	assert.equal(notify.enabled, true);
	assert.equal(notify.type, "once");
	assert.equal(notify.schedule, "5m");
	assert.equal(notify.action, "notify");
	assert.equal(notify.message, "Take a break");
	assert.equal(notify.name, "break");
	assert.equal(notify.description, "Human reminder");
	assert.equal(notify.scope, "cwd");
	assert.equal(notify.maxRuns, 3);
	assert.equal(notify.runCount, 0);
	assert.equal(Date.parse(notify.dueAt), NOW.getTime() + minutes(5));
	assert.equal(notify.nextRun, notify.dueAt);
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
			type: "interval",
			schedule: "15m",
			command: "npm test",
			timeoutMs: 1000,
			followUpPrompt: "Review the test result and decide next steps.",
			successPrompt: "Celebrate success.",
			failurePrompt: "Debug the failure.",
			wakeOn: "failure",
		},
		NOW,
		() => "task_shell",
	);
	assert.equal(shell.command, "npm test");
	assert.equal(shell.type, "interval");
	assert.equal(shell.intervalMs, minutes(15));
	assert.equal(shell.timeoutMs, 1000);
	assert.equal(shell.followUpPrompt, "Review the test result and decide next steps.");
	assert.equal(shell.successPrompt, "Celebrate success.");
	assert.equal(shell.failurePrompt, "Debug the failure.");
	assert.equal(shell.wakeOn, "failure");

	assert.throws(() => createScheduledTask({ action: "prompt", whenText: "5m" }, NOW), /prompt is required/);
	assert.throws(() => createScheduledTask({ action: "shell", whenText: "5m" }, NOW), /command is required/);
	assert.throws(() => createScheduledTask({ action: "notify", whenText: "5m", message: "x", maxRuns: 0 }, NOW), /maxRuns/);
});

test("sanitizeTasks migrates current one-shot task records", () => {
	const legacy = {
		id: "legacy",
		action: "notify",
		status: "pending",
		createdAt: NOW.toISOString(),
		dueAt: new Date(NOW.getTime() + minutes(5)).toISOString(),
		whenText: "5m",
		message: "legacy reminder",
	};

	const [task] = sanitizeTasks([legacy]);
	assert.equal(task.id, "legacy");
	assert.equal(task.type, "once");
	assert.equal(task.enabled, true);
	assert.equal(task.runCount, 0);
	assert.equal(task.schedule, "5m");
	assert.equal(task.nextRun, legacy.dueAt);
});

test("task lifecycle helpers update enabled state and recurrence metadata", () => {
	const tasks = [
		createScheduledTask({ action: "notify", whenText: "5m", message: "A" }, NOW, () => "a"),
		createScheduledTask({ action: "prompt", type: "interval", schedule: "10m", prompt: "B", maxRuns: 1 }, NOW, () => "b"),
	];

	assert.deepEqual(pendingTasks(tasks).map((t) => t.id), ["a", "b"]);
	assert.deepEqual(dueTasks(tasks, new Date(NOW.getTime() + minutes(6))).map((t) => t.id), ["a"]);

	const disabled = disableScheduledTask(tasks, "b", NOW);
	assert.equal(disabled.enabled, false);
	assert.deepEqual(pendingTasks(tasks).map((t) => t.id), ["a"]);

	const enabled = enableScheduledTask(tasks, "b", NOW);
	assert.equal(enabled.enabled, true);
	assert.equal(enabled.status, "pending");

	const updated = updateScheduledTask(tasks, "b", { schedule: "15m", name: "poll" }, NOW);
	assert.equal(updated.name, "poll");
	assert.equal(updated.intervalMs, minutes(15));

	const running = markScheduledTaskRunning(tasks, "b", NOW);
	assert.equal(running.status, "running");
	assert.equal(running.lastStatus, "running");

	const completed = markScheduledTaskCompleted(tasks, "b", NOW, { ok: true }, { ok: true });
	assert.equal(completed.runCount, 1);
	assert.equal(completed.lastStatus, "success");
	assert.equal(completed.enabled, false);
	assert.equal(completed.status, "fired");
	assert.deepEqual(completed.result, { ok: true });

	const cancelled = cancelScheduledTask(tasks, "a", NOW);
	assert.equal(cancelled.id, "a");
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.enabled, false);
	assert.equal(typeof cancelled.cancelledAt, "string");

	assert.throws(() => cancelScheduledTask(tasks, "missing", NOW), /not found/);
	assert.equal(removeScheduledTask(tasks, "a").id, "a");
	assert.equal(tasks.some((task) => task.id === "a"), false);
});

test("failed recurring runs stay scheduled unless maxRuns is reached", () => {
	const tasks = [
		createScheduledTask({ action: "shell", type: "interval", schedule: "5m", command: "false" }, NOW, () => "shell"),
	];
	markScheduledTaskRunning(tasks, "shell", NOW);
	const failed = markScheduledTaskFailed(tasks, "shell", NOW, new Error("boom"));
	assert.equal(failed.enabled, true);
	assert.equal(failed.status, "pending");
	assert.equal(failed.lastStatus, "error");
	assert.equal(failed.lastError, "boom");
	assert.equal(failed.runCount, 1);
});

test("shell wakeOn helper matches success and failure conditions", () => {
	assert.equal(shouldWakeForShellResult({ wakeOn: "never", followUpPrompt: "x" }, { ok: false }), false);
	assert.equal(shouldWakeForShellResult({ wakeOn: "success", followUpPrompt: "x" }, { ok: true }), true);
	assert.equal(shouldWakeForShellResult({ wakeOn: "success", followUpPrompt: "x" }, { ok: false }), false);
	assert.equal(shouldWakeForShellResult({ wakeOn: "failure", followUpPrompt: "x" }, { ok: false }), true);
	assert.equal(shouldWakeForShellResult({ followUpPrompt: "x" }, { ok: true }), true);
	assert.equal(shouldWakeForShellResult({}, { ok: false }), false);
});

test("formatTaskList is readable and sorted by next run", () => {
	const tasks = [
		createScheduledTask({ action: "prompt", type: "interval", schedule: "10m", prompt: "B", name: "poll" }, NOW, () => "b"),
		createScheduledTask({ action: "notify", whenText: "5m", message: "A", name: "break" }, NOW, () => "a"),
	];
	const output = formatTaskList(tasks, NOW);
	assert.match(output, /a/);
	assert.match(output, /break/);
	assert.match(output, /A/);
	assert.match(output, /b/);
	assert.match(output, /poll/);
	assert.match(output, /interval/);
	assert.match(output, /runs=0/);
	assert.ok(output.indexOf("break") < output.indexOf("poll"));
});

test("formatAbsoluteTime shows same-day 24h time with at prefix", () => {
	const todayAfternoon = new Date(NOW.getTime() + 3 * 60 * 60 * 1000); // +3h = same day
	const result = formatAbsoluteTime(todayAfternoon.toISOString(), NOW);
	assert.match(result, /^at \d{2}:\d{2}$/);
	assert.doesNotMatch(result, /AM|PM/i);
});

test("formatAbsoluteTime shows tomorrow prefix for next day", () => {
	const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000); // +1 day
	const result = formatAbsoluteTime(nextDay.toISOString(), NOW);
	assert.match(result, /^tomorrow at /);
});

test("formatAbsoluteTime shows on date prefix for beyond tomorrow", () => {
	const later = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000); // +5 days
	const result = formatAbsoluteTime(later.toISOString(), NOW);
	assert.match(result, /^on [A-Z][a-z]{2} \d+ at /);
});

test("formatAbsoluteTime returns unknown for invalid date", () => {
	assert.equal(formatAbsoluteTime("garbage", NOW), "unknown");
});
