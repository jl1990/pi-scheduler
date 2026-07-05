const { Cron } = require("croner");

const VALID_ACTIONS = new Set(["notify", "prompt", "shell", "message"]);
const VALID_TYPES = new Set(["once", "interval", "cron"]);
const VALID_STATUSES = new Set(["pending", "running", "fired", "cancelled", "failed"]);
const VALID_LAST_STATUSES = new Set(["success", "error", "running"]);
const VALID_SCOPES = new Set(["session", "cwd", "global"]);
const VALID_WAKE_ON = new Set(["always", "failure", "success", "never"]);

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
	input = input
		.replace(/^in\s+/, "")
		.replace(/^every\s+/, "")
		.replace(/^\+/, "")
		.replace(/,/g, " ")
		.replace(/\band\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
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

function normalizeType(type) {
	const value = compactSpaces(type || "once").toLowerCase();
	if (!VALID_TYPES.has(value)) throw new Error(`Invalid schedule type: ${value}`);
	return value;
}

function normalizeScope(scope) {
	const value = compactSpaces(scope || "session").toLowerCase();
	if (!VALID_SCOPES.has(value)) throw new Error(`Invalid scheduled task scope: ${value}`);
	return value;
}

function normalizeWakeOn(wakeOn, hasPrompt = false) {
	const value = compactSpaces(wakeOn || (hasPrompt ? "always" : "never")).toLowerCase();
	if (!VALID_WAKE_ON.has(value)) throw new Error(`Invalid wakeOn value: ${value}`);
	return value;
}

function normalizeMaxRuns(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new Error("maxRuns must be a positive integer");
	return n;
}

function validateTimeoutMs(value) {
	if (value === undefined || value === null) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error("timeoutMs must be a positive number");
	return Math.round(n);
}

function validateTaskSchedule(typeValue, scheduleValue, nowValue = new Date()) {
	const now = asDate(nowValue);
	const type = normalizeType(typeValue);
	const schedule = compactSpaces(scheduleValue);
	if (!schedule) throw new Error("schedule is required");

	if (type === "once") {
		const parsed = parseWhen(schedule, now);
		const nextRun = new Date(parsed.dueAtMs).toISOString();
		return { type, schedule, nextRun, dueAt: nextRun, dueAtMs: parsed.dueAtMs, scheduleKind: parsed.kind };
	}

	if (type === "interval") {
		const intervalMs = parseDurationMs(schedule);
		if (!intervalMs) throw new Error(`Invalid interval schedule: ${schedule}`);
		const nextRun = new Date(now.getTime() + intervalMs).toISOString();
		return { type, schedule, intervalMs, nextRun, dueAt: nextRun };
	}

	try {
		const cron = new Cron(schedule, { paused: true }, () => {});
		const next = cron.nextRun(now);
		cron.stop();
		if (!next) throw new Error("No next run could be computed");
		return { type, schedule, nextRun: next.toISOString(), dueAt: next.toISOString() };
	} catch (error) {
		throw new Error(`Invalid cron schedule: ${schedule}${error instanceof Error ? ` (${error.message})` : ""}`);
	}
}

function getScheduleInput(input) {
	return compactSpaces(input.schedule ?? input.whenText ?? input.when ?? input.due ?? "");
}

function splitScheduleCommand(args, nowValue = new Date()) {
	const text = compactSpaces(args);
	if (!text) throw new Error("Usage: /schedule [notify|prompt|shell|message] <when> <payload>");

	const parseLeft = (leftText) => {
		const tokens = compactSpaces(leftText).split(" ").filter(Boolean);
		let action = "notify";
		if (tokens.length > 0 && VALID_ACTIONS.has(tokens[0].toLowerCase())) action = tokens.shift().toLowerCase();

		let type = "once";
		if (tokens[0]?.toLowerCase() === "every") {
			type = "interval";
			tokens.shift();
		} else if (tokens.length > 0 && VALID_TYPES.has(tokens[0].toLowerCase())) {
			type = tokens.shift().toLowerCase();
		}

		const schedule = compactSpaces(tokens.join(" "));
		validateTaskSchedule(type, schedule, nowValue);
		return { action, type, schedule, whenText: schedule };
	};

	const separatorIndex = text.indexOf("::");
	if (separatorIndex >= 0) {
		const left = compactSpaces(text.slice(0, separatorIndex));
		const payload = compactSpaces(text.slice(separatorIndex + 2));
		if (!left || !payload) throw new Error("Usage with separator: /schedule [action] <when> :: <payload>");
		return { ...parseLeft(left), payload };
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
		const schedule = restTokens.slice(0, i).join(" ");
		const payload = restTokens.slice(i).join(" ").trim();
		if (!payload) continue;
		try {
			validateTaskSchedule("once", schedule, nowValue);
			bestMatch = { action, type: "once", schedule, whenText: schedule, payload };
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

function createScheduledTask(input, nowValue = new Date(), idFn = generateId) {
	const now = asDate(nowValue);
	const action = normalizeAction(input.action);
	const type = normalizeType(input.type);
	const schedule = getScheduleInput(input);
	const validated = validateTaskSchedule(type, schedule, now);
	const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
	const hasShellPrompt = Boolean(input.followUpPrompt || input.successPrompt || input.failurePrompt);

	const task = {
		id: idFn(now),
		action,
		type,
		schedule: validated.schedule,
		whenText: compactSpaces(input.whenText ?? input.when ?? validated.schedule),
		status: "pending",
		enabled,
		createdAt: now.toISOString(),
		dueAt: validated.dueAt,
		nextRun: enabled ? validated.nextRun : undefined,
		runCount: 0,
		scope: normalizeScope(input.scope),
	};

	if (validated.intervalMs !== undefined) task.intervalMs = validated.intervalMs;
	if (input.title !== undefined) task.title = compactSpaces(input.title);
	if (input.name !== undefined) task.name = compactSpaces(input.name);
	if (input.description !== undefined) task.description = compactSpaces(input.description);
	if (input.cwd) task.cwd = String(input.cwd);
	if (input.sessionFile) task.sessionFile = String(input.sessionFile);
	if (input.maxRuns !== undefined) task.maxRuns = normalizeMaxRuns(input.maxRuns);

	const message = compactSpaces(input.message ?? input.payload ?? "");
	const prompt = compactSpaces(input.prompt ?? input.payload ?? input.message ?? "");
	const command = compactSpaces(input.command ?? input.payload ?? "");

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
		const successPrompt = compactSpaces(input.successPrompt ?? "");
		const failurePrompt = compactSpaces(input.failurePrompt ?? "");
		if (followUpPrompt) task.followUpPrompt = followUpPrompt;
		if (successPrompt) task.successPrompt = successPrompt;
		if (failurePrompt) task.failurePrompt = failurePrompt;
		task.wakeOn = normalizeWakeOn(input.wakeOn, hasShellPrompt);
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

function isTerminal(task) {
	return task.status === "fired" || task.status === "cancelled" || task.status === "failed";
}

function normalizeTask(task, nowValue = new Date()) {
	if (!task || typeof task !== "object") return undefined;
	if (typeof task.id !== "string") return undefined;
	let action;
	try {
		action = normalizeAction(task.action);
	} catch {
		return undefined;
	}

	const status = VALID_STATUSES.has(task.status) ? task.status : "pending";
	let type;
	try {
		type = normalizeType(task.type);
	} catch {
		type = "once";
	}

	const schedule = compactSpaces(task.schedule ?? task.whenText ?? task.when ?? task.due ?? task.dueAt ?? "");
	if (!schedule) return undefined;

	const migrated = { ...task, action, type, schedule, status };
	migrated.enabled = task.enabled === undefined ? !isTerminal(migrated) : Boolean(task.enabled);
	migrated.runCount = Number.isInteger(task.runCount) && task.runCount >= 0 ? task.runCount : 0;
	migrated.scope = VALID_SCOPES.has(task.scope) ? task.scope : "session";
	migrated.whenText = compactSpaces(task.whenText ?? task.when ?? schedule);
	migrated.createdAt = Number.isNaN(Date.parse(task.createdAt)) ? asDate(nowValue).toISOString() : task.createdAt;
	if (task.maxRuns !== undefined) migrated.maxRuns = normalizeMaxRuns(task.maxRuns);
	if (task.lastStatus !== undefined && !VALID_LAST_STATUSES.has(task.lastStatus)) delete migrated.lastStatus;

	try {
		const validated = validateTaskSchedule(type, schedule, nowValue);
		if (validated.intervalMs !== undefined) migrated.intervalMs = validated.intervalMs;
		if (!task.nextRun && !task.dueAt) {
			migrated.nextRun = migrated.enabled ? validated.nextRun : undefined;
			migrated.dueAt = validated.dueAt;
		}
	} catch {
		// Legacy one-shot absolute dueAt values may be in the past. Keep them for
		// display/missed-run handling instead of dropping the task.
		if (type !== "once" || Number.isNaN(Date.parse(task.dueAt ?? task.nextRun))) return undefined;
	}

	const preservedNext = task.nextRun ?? task.dueAt;
	if (preservedNext && !Number.isNaN(Date.parse(preservedNext))) {
		migrated.nextRun = migrated.enabled && !isTerminal(migrated) ? new Date(preservedNext).toISOString() : undefined;
		migrated.dueAt = new Date(preservedNext).toISOString();
	}

	if (action === "shell") {
		const hasShellPrompt = Boolean(task.followUpPrompt || task.successPrompt || task.failurePrompt);
		try {
			migrated.wakeOn = normalizeWakeOn(task.wakeOn, hasShellPrompt);
		} catch {
			migrated.wakeOn = hasShellPrompt ? "always" : "never";
		}
	}

	return migrated;
}

function isTaskShape(task) {
	return normalizeTask(task) !== undefined;
}

function sanitizeTasks(value, nowValue = new Date()) {
	if (!Array.isArray(value)) return [];
	return value.map((task) => normalizeTask(task, nowValue)).filter(Boolean);
}

function sortByNextRun(a, b) {
	const aTime = Date.parse(a.nextRun ?? a.dueAt ?? "");
	const bTime = Date.parse(b.nextRun ?? b.dueAt ?? "");
	return (Number.isFinite(aTime) ? aTime : Number.POSITIVE_INFINITY) - (Number.isFinite(bTime) ? bTime : Number.POSITIVE_INFINITY);
}

function pendingTasks(tasks) {
	return tasks
		.filter((task) => task.enabled !== false && !isTerminal(task))
		.slice()
		.sort(sortByNextRun);
}

function dueTasks(tasks, nowValue = new Date()) {
	const now = asDate(nowValue).getTime();
	return pendingTasks(tasks).filter((task) => task.status === "pending" && Date.parse(task.nextRun ?? task.dueAt) <= now);
}

function findTask(tasks, idOrPrefix) {
	const id = compactSpaces(idOrPrefix);
	return tasks.find((task) => task.id === id || task.id.startsWith(id));
}

function cancelScheduledTask(tasks, idOrPrefix, nowValue = new Date()) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "cancelled") throw new Error(`Scheduled task ${task.id} is already cancelled`);
	task.enabled = false;
	task.status = "cancelled";
	task.cancelledAt = now.toISOString();
	task.nextRun = undefined;
	return task;
}

function disableScheduledTask(tasks, idOrPrefix, nowValue = new Date()) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	task.enabled = false;
	task.disabledAt = now.toISOString();
	task.nextRun = undefined;
	if (task.status === "running") task.status = "pending";
	return task;
}

function enableScheduledTask(tasks, idOrPrefix, nowValue = new Date()) {
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "cancelled" || task.status === "failed" || task.status === "fired") task.status = "pending";
	task.enabled = true;
	const validated = validateTaskSchedule(task.type ?? "once", task.schedule ?? task.whenText ?? task.dueAt, nowValue);
	task.type = validated.type;
	task.schedule = validated.schedule;
	if (validated.intervalMs !== undefined) task.intervalMs = validated.intervalMs;
	task.nextRun = validated.nextRun;
	task.dueAt = validated.dueAt;
	return task;
}

function removeScheduledTask(tasks, idOrPrefix) {
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	const index = tasks.indexOf(task);
	if (index >= 0) tasks.splice(index, 1);
	return task;
}

function updateScheduledTask(tasks, idOrPrefix, updates = {}, nowValue = new Date()) {
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);

	if (updates.action !== undefined) task.action = normalizeAction(updates.action);
	if (updates.type !== undefined) task.type = normalizeType(updates.type);
	if (updates.scope !== undefined) task.scope = normalizeScope(updates.scope);
	if (updates.enabled !== undefined) task.enabled = Boolean(updates.enabled);
	if (updates.name !== undefined) task.name = compactSpaces(updates.name);
	if (updates.title !== undefined) task.title = compactSpaces(updates.title);
	if (updates.description !== undefined) task.description = compactSpaces(updates.description);
	if (updates.maxRuns !== undefined) task.maxRuns = normalizeMaxRuns(updates.maxRuns);
	if (updates.cwd !== undefined) task.cwd = String(updates.cwd);
	if (updates.sessionFile !== undefined) task.sessionFile = String(updates.sessionFile);
	if (updates.timeoutMs !== undefined) task.timeoutMs = validateTimeoutMs(updates.timeoutMs);
	if (updates.followUpPrompt !== undefined) task.followUpPrompt = compactSpaces(updates.followUpPrompt) || undefined;
	if (updates.successPrompt !== undefined) task.successPrompt = compactSpaces(updates.successPrompt) || undefined;
	if (updates.failurePrompt !== undefined) task.failurePrompt = compactSpaces(updates.failurePrompt) || undefined;
	if (updates.wakeOn !== undefined) task.wakeOn = normalizeWakeOn(updates.wakeOn, true);
	if (updates.prompt !== undefined) task.prompt = compactSpaces(updates.prompt);
	if (updates.message !== undefined) task.message = compactSpaces(updates.message);
	if (updates.command !== undefined) task.command = compactSpaces(updates.command);
	if (updates.triggerTurn !== undefined) task.triggerTurn = Boolean(updates.triggerTurn);

	if (updates.schedule !== undefined || updates.when !== undefined || updates.whenText !== undefined || updates.type !== undefined) {
		const schedule = compactSpaces(updates.schedule ?? updates.whenText ?? updates.when ?? task.schedule ?? task.whenText ?? "");
		const validated = validateTaskSchedule(task.type ?? "once", schedule, nowValue);
		task.type = validated.type;
		task.schedule = validated.schedule;
		task.whenText = schedule;
		task.dueAt = validated.dueAt;
		task.nextRun = task.enabled === false ? undefined : validated.nextRun;
		if (validated.intervalMs !== undefined) task.intervalMs = validated.intervalMs;
		else delete task.intervalMs;
	}

	if (task.enabled !== false && !isTerminal(task) && !task.nextRun) {
		const validated = validateTaskSchedule(task.type ?? "once", task.schedule ?? task.whenText, nowValue);
		task.nextRun = validated.nextRun;
		task.dueAt = validated.dueAt;
	}
	return task;
}

function markScheduledTaskRunning(tasks, idOrPrefix, nowValue = new Date()) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.enabled === false || isTerminal(task)) return task;
	task.status = "running";
	task.lastStatus = "running";
	task.startedAt = now.toISOString();
	return task;
}

function finishTaskAfterRun(task, now, ok, result) {
	task.runCount = (Number.isInteger(task.runCount) ? task.runCount : 0) + 1;
	task.lastRun = now.toISOString();
	task.lastStatus = ok ? "success" : "error";
	if (ok) delete task.lastError;
	if (result !== undefined) task.result = result;

	const reachedMaxRuns = task.maxRuns !== undefined && task.runCount >= task.maxRuns;
	if (task.type === "once" || reachedMaxRuns) {
		task.enabled = false;
		task.status = ok ? "fired" : "failed";
		task.firedAt = ok ? now.toISOString() : task.firedAt;
		task.failedAt = ok ? task.failedAt : now.toISOString();
		task.nextRun = undefined;
		return task;
	}

	task.enabled = true;
	task.status = "pending";
	try {
		const validated = validateTaskSchedule(task.type, task.schedule, now);
		task.nextRun = validated.nextRun;
		task.dueAt = validated.dueAt;
		if (validated.intervalMs !== undefined) task.intervalMs = validated.intervalMs;
	} catch {
		task.enabled = false;
		task.status = ok ? "fired" : "failed";
		task.nextRun = undefined;
	}
	return task;
}

function markScheduledTaskCompleted(tasks, idOrPrefix, nowValue = new Date(), result, options = {}) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "cancelled") return task;
	return finishTaskAfterRun(task, now, options.ok !== false, result);
}

function markScheduledTaskFired(tasks, idOrPrefix, nowValue = new Date(), result) {
	return markScheduledTaskCompleted(tasks, idOrPrefix, nowValue, result, { ok: true });
}

function markScheduledTaskFailed(tasks, idOrPrefix, nowValue = new Date(), error) {
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	task.lastError = error instanceof Error ? error.message : String(error);
	return finishTaskAfterRun(task, asDate(nowValue), false, undefined);
}

function shellResultOk(result) {
	if (typeof result?.ok === "boolean") return result.ok;
	if (typeof result?.code === "number") return result.code === 0 && result.killed !== true;
	return true;
}

function hasShellFollowUpPrompt(task) {
	return Boolean(task.followUpPrompt || task.successPrompt || task.failurePrompt);
}

function shouldWakeForShellResult(task, result) {
	if (!hasShellFollowUpPrompt(task) && !task.wakeOn) return false;
	const wakeOn = normalizeWakeOn(task.wakeOn, hasShellFollowUpPrompt(task));
	const ok = shellResultOk(result);
	if (wakeOn === "never") return false;
	if (wakeOn === "always") return true;
	if (wakeOn === "success") return ok;
	if (wakeOn === "failure") return !ok;
	return false;
}

function selectShellFollowUpPrompt(task, result) {
	const ok = shellResultOk(result);
	if (ok && task.successPrompt) return task.successPrompt;
	if (!ok && task.failurePrompt) return task.failurePrompt;
	if (task.followUpPrompt) return task.followUpPrompt;
	if (task.wakeOn && task.wakeOn !== "never") return "Review this scheduled shell command result and decide next steps.";
	return undefined;
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

function formatSchedule(task) {
	if (task.type === "interval") return `every ${task.schedule}`;
	if (task.type === "cron") return `cron ${task.schedule}`;
	return task.schedule ?? task.whenText ?? task.dueAt;
}

function formatTaskLine(task, nowValue = new Date()) {
	const label = task.name || task.title || task.id;
	const next = task.nextRun ? `${formatRelativeTime(task.nextRun, nowValue)} (${new Date(task.nextRun).toLocaleString()})` : "no next run";
	const enabled = task.enabled === false ? "disabled" : "enabled";
	const last = task.lastStatus ? ` last=${task.lastStatus}` : "";
	return `- ${task.id} ${label} next=${next} [${task.action}/${task.type}] ${enabled} status=${task.status} runs=${task.runCount ?? 0}${last} schedule=${formatSchedule(task)} :: ${taskSummary(task)}`;
}

function formatTaskList(tasks, nowValue = new Date(), options = {}) {
	const list = options.includeAll ? tasks.slice().sort(sortByNextRun) : pendingTasks(tasks);
	if (list.length === 0) return options.includeAll ? "No scheduled tasks." : "No active scheduled tasks.";
	const title = options.includeAll ? "Scheduled tasks:" : "Active scheduled tasks:";
	return [title, ...list.map((task) => formatTaskLine(task, nowValue))].join("\n");
}

module.exports = {
	VALID_ACTIONS,
	VALID_TYPES,
	VALID_STATUSES,
	VALID_SCOPES,
	VALID_WAKE_ON,
	SECOND,
	MINUTE,
	HOUR,
	DAY,
	parseDurationMs,
	parseWhen,
	validateTaskSchedule,
	splitScheduleCommand,
	normalizeAction,
	normalizeType,
	normalizeScope,
	normalizeWakeOn,
	generateId,
	createScheduledTask,
	normalizeTask,
	sanitizeTasks,
	pendingTasks,
	dueTasks,
	cancelScheduledTask,
	disableScheduledTask,
	enableScheduledTask,
	removeScheduledTask,
	updateScheduledTask,
	markScheduledTaskRunning,
	markScheduledTaskCompleted,
	markScheduledTaskFired,
	markScheduledTaskFailed,
	shouldWakeForShellResult,
	selectShellFollowUpPrompt,
	formatRelativeTime,
	formatTaskLine,
	formatTaskList,
	taskSummary,
};
