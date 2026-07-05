const VALID_ACTIONS = new Set(["notify", "prompt", "shell", "message"]);
const VALID_STATUSES = new Set(["pending", "running", "fired", "cancelled", "failed"]);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function asDate(value) {
	const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
	return date;
}

function compactSpaces(text) {
	return String(text ?? "").trim().replace(/\s+/g, " ");
}

function unitToMs(unit) {
	const u = unit.toLowerCase();
	if (u === "s" || u.startsWith("sec")) return SECOND;
	if (u === "m" || u.startsWith("min")) return MINUTE;
	if (u === "h" || u.startsWith("hr") || u.startsWith("hour")) return HOUR;
	if (u === "d" || u.startsWith("day")) return DAY;
	if (u === "w" || u.startsWith("week")) return WEEK;
	return undefined;
}

function parseDurationMs(text) {
	let input = compactSpaces(text).toLowerCase();
	if (!input) return null;
	input = input.replace(/^in\s+/, "").replace(/,/g, " ").replace(/\band\b/g, " ").replace(/\s+/g, " ").trim();
	if (!input) return null;

	const re = /(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/gi;
	let total = 0;
	let matched = false;
	let cursor = 0;
	let match;

	while ((match = re.exec(input)) !== null) {
		const between = input.slice(cursor, match.index);
		if (between.trim() !== "") return null;
		const value = Number(match[1]);
		const unitMs = unitToMs(match[2]);
		if (!Number.isFinite(value) || value <= 0 || !unitMs) return null;
		total += value * unitMs;
		matched = true;
		cursor = re.lastIndex;
	}

	if (!matched || input.slice(cursor).trim() !== "") return null;
	return Math.round(total);
}

function parseTimeToken(text, options = {}) {
	const input = compactSpaces(text).toLowerCase();
	const match = input.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
	if (!match) return null;

	const hasColon = match[2] !== undefined;
	const suffix = match[3]?.toLowerCase();
	if (!hasColon && !suffix && !options.allowBareHour) return null;

	let hour = Number(match[1]);
	const minute = match[2] === undefined ? 0 : Number(match[2]);
	if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

	if (suffix) {
		if (hour < 1 || hour > 12) return null;
		if (suffix === "am") hour = hour === 12 ? 0 : hour;
		if (suffix === "pm") hour = hour === 12 ? 12 : hour + 12;
	} else {
		if (hour < 0 || hour > 23) return null;
	}

	return { hour, minute };
}

function parseClockExpression(text, now) {
	let input = compactSpaces(text).toLowerCase();
	if (!input) return null;

	let dayOffset;
	let hadAt = false;

	if (input === "tomorrow") return now.getTime() + DAY;
	if (input === "today") return now.getTime();

	if (input.startsWith("tomorrow ")) {
		dayOffset = 1;
		input = input.slice("tomorrow".length).trim();
	} else if (input.startsWith("today ")) {
		dayOffset = 0;
		input = input.slice("today".length).trim();
	}

	if (input.startsWith("at ")) {
		hadAt = true;
		input = input.slice(3).trim();
	}

	if (!input) return null;
	const parsed = parseTimeToken(input, { allowBareHour: hadAt || dayOffset !== undefined });
	if (!parsed) return null;

	const target = new Date(now.getTime());
	if (dayOffset !== undefined) target.setDate(target.getDate() + dayOffset);
	target.setHours(parsed.hour, parsed.minute, 0, 0);

	if (dayOffset === undefined && target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
	return target.getTime();
}

function parseWhen(text, nowValue = new Date()) {
	const now = asDate(nowValue);
	const input = compactSpaces(text);
	if (!input) throw new Error("Scheduled time is required");

	const durationMs = parseDurationMs(input);
	if (durationMs !== null) {
		return { dueAtMs: now.getTime() + durationMs, kind: "relative", normalized: input };
	}

	const clockMs = parseClockExpression(input, now);
	if (clockMs !== null) {
		if (clockMs <= now.getTime()) throw new Error(`Scheduled time is in the past: ${input}`);
		return { dueAtMs: clockMs, kind: "clock", normalized: input };
	}

	const absoluteMs = Date.parse(input);
	if (!Number.isNaN(absoluteMs)) {
		if (absoluteMs <= now.getTime()) throw new Error(`Scheduled time is in the past: ${input}`);
		return { dueAtMs: absoluteMs, kind: "absolute", normalized: input };
	}

	throw new Error(`Could not parse scheduled time: ${input}`);
}

function normalizeAction(action) {
	const value = compactSpaces(action || "notify").toLowerCase();
	if (!VALID_ACTIONS.has(value)) throw new Error(`Invalid scheduled action: ${value}`);
	return value;
}

function splitScheduleCommand(args, nowValue = new Date()) {
	const text = compactSpaces(args);
	if (!text) throw new Error("Usage: /schedule [notify|prompt|shell|message] <when> <payload>");

	const separatorIndex = text.indexOf("::");
	if (separatorIndex >= 0) {
		const left = compactSpaces(text.slice(0, separatorIndex));
		const payload = compactSpaces(text.slice(separatorIndex + 2));
		if (!left || !payload) throw new Error("Usage with separator: /schedule [action] <when> :: <payload>");
		const leftTokens = left.split(" ");
		let action = "notify";
		let whenText = left;
		if (VALID_ACTIONS.has(leftTokens[0].toLowerCase())) {
			action = leftTokens[0].toLowerCase();
			whenText = compactSpaces(leftTokens.slice(1).join(" "));
		}
		parseWhen(whenText, nowValue);
		return { action, whenText, payload };
	}

	const tokens = text.split(" ");
	let action = "notify";
	let restTokens = tokens;
	if (VALID_ACTIONS.has(tokens[0].toLowerCase())) {
		action = tokens[0].toLowerCase();
		restTokens = tokens.slice(1);
	}

	const maxPrefix = Math.min(restTokens.length - 1, 10);
	let bestMatch = null;
	for (let i = 1; i <= maxPrefix; i++) {
		const whenText = restTokens.slice(0, i).join(" ");
		const payload = restTokens.slice(i).join(" ").trim();
		if (!payload) continue;
		try {
			parseWhen(whenText, nowValue);
			bestMatch = { action, whenText, payload };
		} catch {
			// Try a longer prefix.
		}
	}
	if (bestMatch) return bestMatch;

	throw new Error("Could not split scheduled task. Try: /schedule prompt 5m summarize progress");
}

function generateId(nowValue = new Date()) {
	const now = asDate(nowValue);
	return `task_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function validateTimeoutMs(value) {
	if (value === undefined || value === null) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error("timeoutMs must be a positive number");
	return Math.round(n);
}

function createScheduledTask(input, nowValue = new Date(), idFn = generateId) {
	const now = asDate(nowValue);
	const action = normalizeAction(input.action);
	const whenText = compactSpaces(input.whenText ?? input.when ?? input.due ?? "");
	const parsed = parseWhen(whenText, now);
	const task = {
		id: idFn(now),
		action,
		status: "pending",
		createdAt: now.toISOString(),
		dueAt: new Date(parsed.dueAtMs).toISOString(),
		whenText,
	};

	const message = compactSpaces(input.message ?? input.payload ?? "");
	const prompt = compactSpaces(input.prompt ?? input.payload ?? input.message ?? "");
	const command = compactSpaces(input.command ?? input.payload ?? "");

	if (input.title !== undefined) task.title = compactSpaces(input.title);
	if (input.cwd) task.cwd = String(input.cwd);
	if (input.sessionFile) task.sessionFile = String(input.sessionFile);

	if (action === "notify") {
		if (!message) throw new Error("message is required for notify scheduled tasks");
		task.message = message;
	} else if (action === "prompt") {
		if (!prompt) throw new Error("prompt is required for prompt scheduled tasks");
		task.prompt = prompt;
	} else if (action === "shell") {
		if (!command) throw new Error("command is required for shell scheduled tasks");
		task.command = command;
		const timeoutMs = validateTimeoutMs(input.timeoutMs);
		if (timeoutMs !== undefined) task.timeoutMs = timeoutMs;
		const followUpPrompt = compactSpaces(input.followUpPrompt ?? "");
		if (followUpPrompt) task.followUpPrompt = followUpPrompt;
	} else if (action === "message") {
		if (!message) throw new Error("message is required for message scheduled tasks");
		task.message = message;
		if (input.triggerTurn !== undefined) task.triggerTurn = Boolean(input.triggerTurn);
	}

	return task;
}

function taskSummary(task) {
	const raw = task.command ?? task.prompt ?? task.message ?? "";
	return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}

function isTaskShape(task) {
	if (!task || typeof task !== "object") return false;
	if (typeof task.id !== "string" || !VALID_ACTIONS.has(task.action)) return false;
	if (!VALID_STATUSES.has(task.status)) return false;
	if (Number.isNaN(Date.parse(task.dueAt))) return false;
	return true;
}

function sanitizeTasks(value) {
	if (!Array.isArray(value)) return [];
	return value.filter(isTaskShape);
}

function pendingTasks(tasks) {
	return tasks
		.filter((task) => task.status === "pending")
		.slice()
		.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

function dueTasks(tasks, nowValue = new Date()) {
	const now = asDate(nowValue).getTime();
	return pendingTasks(tasks).filter((task) => Date.parse(task.dueAt) <= now);
}

function findTask(tasks, idOrPrefix) {
	const id = compactSpaces(idOrPrefix);
	return tasks.find((task) => task.id === id || task.id.startsWith(id));
}

function cancelScheduledTask(tasks, idOrPrefix, nowValue = new Date()) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status !== "pending") throw new Error(`Scheduled task ${task.id} is already ${task.status}`);
	task.status = "cancelled";
	task.cancelledAt = now.toISOString();
	return task;
}

function markScheduledTaskRunning(tasks, idOrPrefix, nowValue = new Date()) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status !== "pending") return task;
	task.status = "running";
	task.startedAt = now.toISOString();
	return task;
}

function markScheduledTaskFired(tasks, idOrPrefix, nowValue = new Date(), result) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "cancelled") return task;
	task.status = "fired";
	task.firedAt = now.toISOString();
	if (result !== undefined) task.result = result;
	return task;
}

function markScheduledTaskFailed(tasks, idOrPrefix, nowValue = new Date(), error) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "cancelled") return task;
	task.status = "failed";
	task.failedAt = now.toISOString();
	task.error = error instanceof Error ? error.message : String(error);
	return task;
}

function formatRelativeTime(dueAt, nowValue = new Date()) {
	const now = asDate(nowValue).getTime();
	let diff = Date.parse(dueAt) - now;
	if (!Number.isFinite(diff) || diff <= 0) return "due now";

	const parts = [];
	const units = [
		["d", DAY],
		["h", HOUR],
		["m", MINUTE],
		["s", SECOND],
	];
	for (const [label, size] of units) {
		const value = Math.floor(diff / size);
		if (value > 0) {
			parts.push(`${value}${label}`);
			diff -= value * size;
		}
		if (parts.length >= 2) break;
	}
	return `in ${parts.join(" ") || "<1s"}`;
}

function formatTaskLine(task, nowValue = new Date()) {
	const due = new Date(task.dueAt);
	const status = task.status === "pending" ? formatRelativeTime(task.dueAt, nowValue) : task.status;
	return `- ${task.id} ${status} (${due.toLocaleString()}) [${task.action}] ${taskSummary(task)}`;
}

function formatTaskList(tasks, nowValue = new Date(), options = {}) {
	const list = options.includeAll
		? tasks.slice().sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
		: pendingTasks(tasks);
	if (list.length === 0) return options.includeAll ? "No scheduled tasks." : "No pending scheduled tasks.";
	const title = options.includeAll ? "Scheduled tasks:" : "Pending scheduled tasks:";
	return [title, ...list.map((task) => formatTaskLine(task, nowValue))].join("\n");
}

module.exports = {
	VALID_ACTIONS,
	VALID_STATUSES,
	SECOND,
	MINUTE,
	HOUR,
	DAY,
	parseDurationMs,
	parseWhen,
	splitScheduleCommand,
	normalizeAction,
	generateId,
	createScheduledTask,
	sanitizeTasks,
	pendingTasks,
	dueTasks,
	cancelScheduledTask,
	markScheduledTaskRunning,
	markScheduledTaskFired,
	markScheduledTaskFailed,
	formatRelativeTime,
	formatTaskLine,
	formatTaskList,
	taskSummary,
};
