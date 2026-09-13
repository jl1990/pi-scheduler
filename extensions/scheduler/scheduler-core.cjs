const { realpathSync } = require("node:fs");
const { createRequire } = require("node:module");
const { createHash, randomUUID } = require("node:crypto");

function loadCroner() {
	try {
		return require("croner");
	} catch (error) {
		if (error?.code !== "MODULE_NOT_FOUND" || !String(error?.message ?? "").includes("'croner'")) {
			throw error;
		}
		// Pi's extension loader can preserve the npm/pnpm package symlink path. In that
		// mode Node does not walk up into pnpm's real virtual-store node_modules, so
		// resolve from this file's real path as a fallback.
		return createRequire(realpathSync(__filename))("croner");
	}
}

const { Cron } = loadCroner();

const VALID_ACTIONS = new Set(["notify", "prompt", "shell", "message"]);
const VALID_TYPES = new Set(["once", "interval", "cron"]);
const VALID_STATUSES = new Set(["pending", "running", "fired", "cancelled", "failed", "expired"]);
const VALID_LAST_STATUSES = new Set(["success", "error", "running"]);
const VALID_SCOPES = new Set(["session", "cwd", "global"]);
const VALID_WAKE_ON = new Set(["always", "failure", "success", "never", "change"]);
const VALID_STOP_ON = new Set(["success", "failure", "never"]);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const DEFAULT_CATCHUP_WINDOW_HOURS = 24;
const DEFAULT_CATCHUP_MAX_FIRE = 5;
const DEFAULT_HISTORY_LIMIT = 10;

function normalizeRunHistory(value) {
	if (!Array.isArray(value)) return undefined;
	const valid = new Map();
	for (const entry of value) {
		if (!entry || typeof entry.attemptId !== "string" || !entry.attemptId || entry.attemptId.length > 128
			|| !Number.isFinite(Date.parse(entry.startedAt)) || !Number.isFinite(Date.parse(entry.completedAt))
			|| !Number.isSafeInteger(entry.durationMs) || entry.durationMs < 0
			|| !["success", "error", "cancelled", "interrupted"].includes(entry.outcome?.status)) continue;
		const outcome = { status: entry.outcome.status, killed: entry.outcome.killed === true };
		if (Number.isSafeInteger(entry.outcome.exitCode)) outcome.exitCode = entry.outcome.exitCode;
		if (typeof entry.outcome.error === "string") outcome.error = entry.outcome.error.slice(0, 1000);
		const clean = { attemptId: entry.attemptId, startedAt: new Date(entry.startedAt).toISOString(), completedAt: new Date(entry.completedAt).toISOString(), durationMs: entry.durationMs, outcome };
		if (typeof entry.wakeReason === "string") clean.wakeReason = entry.wakeReason.slice(0, 120);
		if (["delivered", "suppressed", "failed", "no-followup", "session-suppressed", "not-requested"].includes(entry.wakeDisposition)) clean.wakeDisposition = entry.wakeDisposition;
		if (typeof entry.wakeError === "string") clean.wakeError = entry.wakeError.slice(0, 1000);
		valid.set(clean.attemptId, clean);
	}
	return [...valid.values()].slice(-DEFAULT_HISTORY_LIMIT);
}

function appendRunHistory(task, now, result = {}, status) {
	const attemptId = task.runAttemptId ?? task.runOwner?.attemptId ?? (task.startedAt ? `legacy-${task.startedAt}` : undefined);
	if (!attemptId || !task.startedAt) return;
	const history = normalizeRunHistory(task.history) ?? [];
	if (history.some((entry) => entry.attemptId === attemptId)) return;
	const entry = {
		attemptId, startedAt: task.startedAt, completedAt: now.toISOString(),
		durationMs: Math.max(0, now.getTime() - Date.parse(task.startedAt)),
		outcome: { status, exitCode: result?.code, killed: result?.killed, error: result?.error },
		wakeReason: result?.wakeReason, wakeDisposition: result?.wakeDisposition, wakeError: result?.wakeError,
	};
	task.history = normalizeRunHistory([...history, entry]);
}

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

function normalizeStopOn(stopOn) {
	const value = compactSpaces(stopOn || "never").toLowerCase();
	if (!VALID_STOP_ON.has(value)) throw new Error(`Invalid stopOn value: ${value}`);
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

function normalizeBackoff(value, baseIntervalMs, nowValue = new Date()) {
	if (value === undefined || value === null) return undefined;
	if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) throw new Error("backoff requires an interval schedule");
	if (!value || typeof value !== "object") throw new Error("backoff must be an object");
	const factor = Number(value.factor);
	if (!Number.isFinite(factor) || factor <= 1) throw new Error("backoff.factor must be a finite number greater than 1");
	const maxIntervalMs = typeof value.maxInterval === "string" ? parseDurationMs(value.maxInterval) : Number(value.maxIntervalMs ?? value.maxInterval);
	if (!Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < baseIntervalMs) throw new Error("backoff.maxInterval must be at least the base interval");
	if (!Number.isFinite(new Date(asDate(nowValue).getTime() + maxIntervalMs).getTime())) throw new Error("backoff maxInterval exceeds the supported date range");
	const current = value.currentIntervalMs === undefined ? baseIntervalMs : Number(value.currentIntervalMs);
	if (!Number.isSafeInteger(current) || current < baseIntervalMs || current > maxIntervalMs) throw new Error("backoff current interval is invalid");
	return { factor, maxIntervalMs, currentIntervalMs: current };
}

function expiryAtFromInput(value, nowValue = new Date()) {
	const duration = typeof value === "string" ? parseDurationMs(value) : null;
	const deadline = asDate(nowValue).getTime() + duration;
	if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isFinite(new Date(deadline).getTime())) {
		throw new Error("expiresIn must be a positive duration within the supported date range");
	}
	return new Date(deadline).toISOString();
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
	if (input.stopOn !== undefined && action !== "shell") throw new Error("stopOn is only supported for shell scheduled tasks");

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
	if (input.backoff !== undefined) task.backoff = normalizeBackoff(input.backoff, validated.intervalMs, now);
	if (input.title !== undefined) task.title = compactSpaces(input.title);
	if (input.name !== undefined) task.name = compactSpaces(input.name);
	if (input.description !== undefined) task.description = compactSpaces(input.description);
	if (input.cwd) task.cwd = String(input.cwd);
	if (input.sessionFile) task.sessionFile = String(input.sessionFile);
	if (input.maxRuns !== undefined) task.maxRuns = normalizeMaxRuns(input.maxRuns);
	if (input.expiresIn !== undefined) task.expiresAt = expiryAtFromInput(input.expiresIn, now);

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
		task.stopOn = normalizeStopOn(input.stopOn);
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
	return task.status === "fired" || task.status === "cancelled" || task.status === "failed" || task.status === "expired";
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
	const history = normalizeRunHistory(task.history);
	if (history?.length) migrated.history = history;
	else delete migrated.history;
	migrated.enabled = task.enabled === undefined ? !isTerminal(migrated) : Boolean(task.enabled);
	migrated.runCount = Number.isInteger(task.runCount) && task.runCount >= 0 ? task.runCount : 0;
	migrated.scope = VALID_SCOPES.has(task.scope) ? task.scope : task.sessionFile ? "session" : task.cwd ? "cwd" : "global";
	migrated.whenText = compactSpaces(task.whenText ?? task.when ?? schedule);
	migrated.createdAt = Number.isNaN(Date.parse(task.createdAt)) ? asDate(nowValue).toISOString() : task.createdAt;
	if (task.expiresAt !== undefined) {
		const expiry = Date.parse(task.expiresAt);
		if (!Number.isFinite(expiry)) {
			migrated.enabled = false;
			migrated.status = "failed";
			migrated.lastError = "Invalid persisted expiresAt";
			delete migrated.nextRun;
		} else migrated.expiresAt = new Date(expiry).toISOString();
	}
	if (task.maxRuns !== undefined) migrated.maxRuns = normalizeMaxRuns(task.maxRuns);
	if (task.lastStatus !== undefined && !VALID_LAST_STATUSES.has(task.lastStatus)) delete migrated.lastStatus;

	try {
		const validated = validateTaskSchedule(type, schedule, nowValue);
		if (validated.intervalMs !== undefined) migrated.intervalMs = validated.intervalMs;
		if (type === "interval" && task.backoff !== undefined) {
			try {
				migrated.backoff = normalizeBackoff(task.backoff, validated.intervalMs, nowValue);
			} catch (error) {
				delete migrated.backoff;
				migrated.enabled = false;
				migrated.status = "failed";
				migrated.lastStatus = "error";
				migrated.lastError = error.message;
				migrated.nextRun = undefined;
			}
		} else if (type !== "interval") delete migrated.backoff;
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
		if (typeof migrated.lastResultFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(migrated.lastResultFingerprint)) {
			delete migrated.lastResultFingerprint;
		}
		if (typeof migrated.wakeOnChangeKey !== "string") delete migrated.wakeOnChangeKey;
		if (typeof migrated.wakeOnChangeRevision !== "string") delete migrated.wakeOnChangeRevision;
		try {
			migrated.stopOn = normalizeStopOn(task.stopOn);
		} catch (error) {
			migrated.stopOn = "never";
			migrated.enabled = false;
			migrated.status = "failed";
			migrated.nextRun = undefined;
			migrated.lastStatus = "error";
			migrated.lastError = error.message;
		}
	} else {
		delete migrated.stopOn;
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

function taskMatchesScope(task, context = {}) {
	const scope = task.scope ?? "session";
	if (scope === "global") return true;
	if (scope === "cwd") return Boolean(task.cwd && context.cwd && task.cwd === context.cwd);
	return Boolean(task.sessionFile && context.sessionFile && task.sessionFile === context.sessionFile);
}

function pendingTasks(tasks) {
	return tasks
		.filter((task) => task.enabled !== false && !isTerminal(task))
		.slice()
		.sort(sortByNextRun);
}

function canClaimTask(task, nowValue = new Date()) {
	if (task?.expiresAt === undefined) return true;
	const expiry = Date.parse(task.expiresAt);
	return Number.isFinite(expiry) && asDate(nowValue).getTime() < expiry;
}

function expireOverdueTasks(tasks, nowValue = new Date()) {
	const now = asDate(nowValue);
	const expired = [];
	for (const task of tasks) {
		if (isTerminal(task) || task.status === "running" || !task.expiresAt || !Number.isFinite(Date.parse(task.expiresAt))) continue;
		if (Date.parse(task.expiresAt) <= now.getTime()) {
			task.enabled = false;
			task.status = "expired";
			task.expiredAt = now.toISOString();
			task.nextRun = undefined;
			expired.push(task);
		}
	}
	return expired;
}

function dueTasks(tasks, nowValue = new Date()) {
	const now = asDate(nowValue).getTime();
	return pendingTasks(tasks).filter((task) => task.status === "pending" && canClaimTask(task, nowValue) && Date.parse(task.nextRun ?? task.dueAt) <= now);
}

function parseCatchUpOptions(env = {}) {
	const rawWindow = typeof env.PI_SCHEDULER_CATCHUP_WINDOW_H === "string"
		? env.PI_SCHEDULER_CATCHUP_WINDOW_H.trim()
		: env.PI_SCHEDULER_CATCHUP_WINDOW_H;
	const parsedWindow = rawWindow === undefined || rawWindow === "" ? Number.NaN : Number(rawWindow);
	const windowHours = Number.isFinite(parsedWindow) && parsedWindow >= 0 && Number.isFinite(parsedWindow * HOUR)
		? parsedWindow
		: DEFAULT_CATCHUP_WINDOW_HOURS;

	const rawMax = typeof env.PI_SCHEDULER_CATCHUP_MAX === "string"
		? env.PI_SCHEDULER_CATCHUP_MAX.trim()
		: env.PI_SCHEDULER_CATCHUP_MAX;
	const parsedMax = rawMax === undefined || rawMax === "" ? Number.NaN : Number(rawMax);
	const maxFire = Number.isSafeInteger(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_CATCHUP_MAX_FIRE;
	return { windowHours, maxFire };
}

function latestMissedCronRun(task, now) {
	const persistedNext = Date.parse(task.nextRun ?? task.dueAt ?? "");
	if (!Number.isFinite(persistedNext) || persistedNext > now.getTime()) return undefined;

	let cron;
	try {
		cron = new Cron(task.schedule, { paused: true }, () => {});
		const [latest] = cron.previousRuns(1, now);
		if (latest && latest.getTime() >= persistedNext && latest.getTime() <= now.getTime()) return latest;
	} catch {
		return undefined;
	} finally {
		cron?.stop();
	}
	return new Date(persistedNext);
}

function selectCatchUpCronTasks(tasks, nowValue = new Date(), options = {}) {
	const now = asDate(nowValue);
	const windowHours = Number(options.windowHours);
	const maxFire = Number(options.maxFire);
	if (!Number.isFinite(windowHours) || windowHours < 0 || !Number.isSafeInteger(maxFire) || maxFire <= 0) return [];
	const windowMs = windowHours * HOUR;
	if (!Number.isFinite(windowMs)) return [];

	return tasks
		.filter((task) => task.type === "cron" && task.enabled !== false && task.status === "pending" && canClaimTask(task, now))
		.map((task) => ({ task, missedAt: latestMissedCronRun(task, now) }))
		.filter((entry) => entry.missedAt && now.getTime() - entry.missedAt.getTime() <= windowMs)
		.sort((a, b) => b.missedAt.getTime() - a.missedAt.getTime())
		.slice(0, maxFire);
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
	return task;
}

function enableScheduledTask(tasks, idOrPrefix, nowValue = new Date()) {
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "expired") throw new Error(`Scheduled task ${task.id} is expired; renew expiresIn before enabling`);
	if (!canClaimTask(task, nowValue)) throw new Error(`Scheduled task ${task.id} is expired; renew expiresIn before enabling`);
	if (task.status === "cancelled" || task.status === "failed" || task.status === "fired") task.status = "pending";
	delete task.stopReason;
	task.enabled = true;
	const validated = validateTaskSchedule(task.type ?? "once", task.schedule ?? task.whenText ?? task.dueAt, nowValue);
	task.type = validated.type;
	task.schedule = validated.schedule;
	if (validated.intervalMs !== undefined) task.intervalMs = validated.intervalMs;
	if (task.backoff) task.backoff = normalizeBackoff(task.backoff, validated.intervalMs, nowValue);
	if (task.backoff) task.backoff.currentIntervalMs = validated.intervalMs;
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
	const scheduleChanged = updates.schedule !== undefined || updates.when !== undefined || updates.whenText !== undefined || updates.type !== undefined;
	const resetBackoff = scheduleChanged || updates.backoff !== undefined;
	let nextBackoff = task.backoff;
	if (resetBackoff) {
		const nextType = updates.type !== undefined ? normalizeType(updates.type) : task.type;
		const nextSchedule = updates.schedule ?? updates.whenText ?? updates.when ?? task.schedule;
		const validated = validateTaskSchedule(nextType, nextSchedule, nowValue);
		const input = updates.backoff !== undefined ? updates.backoff : task.backoff;
		if (input != null && typeof input !== "object") throw new Error("backoff must be an object");
		nextBackoff = input == null ? undefined : normalizeBackoff({ ...input, currentIntervalMs: undefined }, validated.intervalMs, nowValue);
	}
	const renewed = updates.expiresIn !== undefined;
	const newExpiry = renewed && updates.expiresIn !== null ? expiryAtFromInput(updates.expiresIn, nowValue) : undefined;
	if (updates.enabled === true && !renewed && (task.status === "expired" || !canClaimTask(task, nowValue))) {
		throw new Error(`Scheduled task ${task.id} is expired; renew expiresIn before enabling`);
	}

	const nextAction = updates.action !== undefined ? normalizeAction(updates.action) : task.action;
	if (updates.stopOn !== undefined && nextAction !== "shell") throw new Error("stopOn is only supported for shell scheduled tasks");
	if (updates.action !== undefined) task.action = nextAction;
	if (updates.type !== undefined) task.type = normalizeType(updates.type);
	if (updates.scope !== undefined) task.scope = normalizeScope(updates.scope);
	if (updates.enabled !== undefined) task.enabled = Boolean(updates.enabled);
	if (renewed) {
		if (newExpiry === undefined) delete task.expiresAt;
		else task.expiresAt = newExpiry;
		if (task.status === "expired") {
			task.status = "pending";
			task.enabled = updates.enabled === undefined ? true : Boolean(updates.enabled);
			delete task.expiredAt;
		}
	}
	if (updates.name !== undefined) task.name = compactSpaces(updates.name);
	if (updates.title !== undefined) task.title = compactSpaces(updates.title);
	if (updates.description !== undefined) task.description = compactSpaces(updates.description);
	if (updates.maxRuns !== undefined) task.maxRuns = normalizeMaxRuns(updates.maxRuns);
	if (updates.cwd !== undefined) {
		const cwd = String(updates.cwd);
		if (cwd !== task.cwd) {
			delete task.lastResultFingerprint;
			delete task.wakeOnChangeKey;
			task.wakeOnChangeRevision = randomUUID();
		}
		task.cwd = cwd;
	}
	if (updates.sessionFile === null) delete task.sessionFile;
	else if (updates.sessionFile !== undefined) task.sessionFile = String(updates.sessionFile);
	if (updates.timeoutMs !== undefined) task.timeoutMs = validateTimeoutMs(updates.timeoutMs);
	if (resetBackoff) {
		if (nextBackoff === undefined) delete task.backoff;
		else task.backoff = nextBackoff;
	}
	if (updates.followUpPrompt !== undefined) task.followUpPrompt = compactSpaces(updates.followUpPrompt) || undefined;
	if (updates.successPrompt !== undefined) task.successPrompt = compactSpaces(updates.successPrompt) || undefined;
	if (updates.failurePrompt !== undefined) task.failurePrompt = compactSpaces(updates.failurePrompt) || undefined;
	if (updates.wakeOn !== undefined) {
		const wakeOn = normalizeWakeOn(updates.wakeOn, true);
		if (wakeOn === "change" && task.wakeOn !== "change") {
			delete task.lastResultFingerprint;
			delete task.wakeOnChangeKey;
			task.wakeOnChangeRevision = randomUUID();
		}
		task.wakeOn = wakeOn;
	}
	if (updates.stopOn !== undefined) {
		task.stopOn = normalizeStopOn(updates.stopOn);
		delete task.stopReason;
	}
	if (updates.action !== undefined && task.action !== "shell") delete task.stopOn;
	if (updates.prompt !== undefined) task.prompt = compactSpaces(updates.prompt);
	if (updates.message !== undefined) task.message = compactSpaces(updates.message);
	if (updates.command !== undefined) {
		const command = compactSpaces(updates.command);
		if (command !== task.command) {
			delete task.lastResultFingerprint;
			delete task.wakeOnChangeKey;
			task.wakeOnChangeRevision = randomUUID();
		}
		task.command = command;
	}
	if (updates.triggerTurn !== undefined) task.triggerTurn = Boolean(updates.triggerTurn);

	if (scheduleChanged || updates.backoff !== undefined) {
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

function markScheduledTaskRunning(tasks, idOrPrefix, nowValue = new Date(), options = {}) {
	const now = asDate(nowValue);
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.enabled === false || isTerminal(task) || !canClaimTask(task, now)) return task;
	task.status = "running";
	task.lastStatus = "running";
	task.startedAt = now.toISOString();
	if (options.runOwner) task.runOwner = { ...options.runOwner, startedAt: now.toISOString() };
	task.runAttemptId = options.runOwner?.attemptId ?? randomUUID();
	return task;
}

function finishTaskAfterRun(task, now, ok, result) {
	const remainDisabled = task.enabled === false;
	appendRunHistory(task, now, result, result?.interrupted ? "interrupted" : (ok ? "success" : "error"));
	delete task.interruptedRun;
	delete task.startedAt;
	delete task.runAttemptId;
	delete task.runOwner;
	task.runCount = (Number.isInteger(task.runCount) ? task.runCount : 0) + 1;
	task.lastRun = now.toISOString();
	task.lastStatus = ok ? "success" : "error";
	if (ok) delete task.lastError;
	if (result !== undefined) task.result = result;
	if (task.expiresAt && Date.parse(task.expiresAt) <= now.getTime()) {
		task.enabled = false;
		task.status = "expired";
		task.expiredAt = now.toISOString();
		task.nextRun = undefined;
		return task;
	}

	const reachedMaxRuns = task.maxRuns !== undefined && task.runCount >= task.maxRuns;
	const stopOn = task.action === "shell" ? normalizeStopOn(task.stopOn) : "never";
	const stoppedOnResult = stopOn !== "never" && ((stopOn === "success" && ok) || (stopOn === "failure" && !ok));
	if (task.type === "once" || reachedMaxRuns || (!remainDisabled && stoppedOnResult)) {
		task.enabled = false;
		task.status = ok ? "fired" : "failed";
		if (stoppedOnResult) task.stopReason = `Stopped because stopOn=${stopOn} matched the ${ok ? "successful" : "failed"} shell result`;
		task.firedAt = ok ? now.toISOString() : task.firedAt;
		task.failedAt = ok ? task.failedAt : now.toISOString();
		task.nextRun = undefined;
		return task;
	}

	if (remainDisabled) {
		task.enabled = false;
		task.status = "pending";
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
		if (task.backoff) {
			const nextInterval = Math.min(task.backoff.maxIntervalMs, Math.round(task.backoff.currentIntervalMs * task.backoff.factor));
			if (!Number.isSafeInteger(nextInterval)) throw new Error("backoff interval exceeds safe timer range");
			task.backoff.currentIntervalMs = nextInterval;
			task.nextRun = new Date(now.getTime() + nextInterval).toISOString();
			task.dueAt = task.nextRun;
		}
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
	if (task.status === "cancelled") {
		appendRunHistory(task, now, result, "cancelled");
		delete task.runOwner;
		delete task.startedAt;
		delete task.runAttemptId;
		return task;
	}
	const historyResult = result && typeof result === "object" ? { ...result } : result;
	if (historyResult && options.wakeReason !== undefined) historyResult.wakeReason = options.wakeReason;
	if (historyResult && options.wakeDisposition !== undefined) historyResult.wakeDisposition = options.wakeDisposition;
	const ok = options.ok === undefined
		? (task.action === "shell" ? shellResultOk(result) : true)
		: options.ok !== false;
	return finishTaskAfterRun(task, now, ok, historyResult);
}

function markScheduledTaskFired(tasks, idOrPrefix, nowValue = new Date(), result) {
	return markScheduledTaskCompleted(tasks, idOrPrefix, nowValue, result, { ok: true });
}

function markScheduledTaskFailed(tasks, idOrPrefix, nowValue = new Date(), error) {
	const task = findTask(tasks, idOrPrefix);
	if (!task) throw new Error(`Scheduled task not found: ${idOrPrefix}`);
	if (task.status === "cancelled") {
		appendRunHistory(task, asDate(nowValue), {error: error instanceof Error ? error.message : String(error), wakeReason: "execution-error", wakeDisposition: "not-requested"}, "cancelled");
		delete task.runOwner;
		delete task.startedAt;
		delete task.runAttemptId;
		return task;
	}
	task.lastError = error instanceof Error ? error.message : String(error);
	return finishTaskAfterRun(task, asDate(nowValue), false, { error: task.lastError, interrupted: task.interruptedRun, wakeReason: task.interruptedRun ? "interrupted" : "execution-error", wakeDisposition: "not-requested" });
}

function recoverInterruptedTasks(tasks, nowValue = new Date(), options = {}) {
	const now = asDate(nowValue);
	const interrupted = tasks.filter(
		(task) => task.status === "running" && !options.isOwnerActive?.(task.runOwner),
	);
	for (const task of interrupted) {
		const error = new Error("Scheduled task was interrupted before completion");
		if (task.enabled === false) {
			// Preserve an external disable decision while clearing the abandoned run.
			task.status = "pending";
			task.lastStatus = "error";
			task.lastError = error.message;
			task.nextRun = undefined;
			appendRunHistory(task, now, {error: error.message, wakeReason: "interrupted", wakeDisposition: "not-requested"}, "interrupted");
			delete task.runOwner;
			delete task.startedAt;
			delete task.runAttemptId;
			continue;
		}
		task.interruptedRun = true;
		markScheduledTaskFailed(tasks, task.id, now, error);
	}
	return interrupted;
}

function shellResultOk(result) {
	if (typeof result?.ok === "boolean") return result.ok;
	if (typeof result?.code === "number") return result.code === 0 && result.killed !== true;
	return true;
}

// Hash the complete command result before any UI/state output truncation. JSON
// framing keeps stdout/stderr and status values unambiguous.
function shellResultFingerprint(result) {
	if (typeof result?.wakeOnChangeFingerprint === "string") return result.wakeOnChangeFingerprint;
	return createHash("sha256")
		.update(JSON.stringify([
			String(result?.stdout ?? ""),
			String(result?.stderr ?? ""),
			result?.code ?? null,
			Boolean(result?.killed),
		]))
		.digest("hex");
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
	if (wakeOn === "change") {
		const fingerprint = shellResultFingerprint(result);
		const key = `${task.command ?? ""}\0${task.cwd ?? result.cwd ?? ""}`;
		const changed = task.wakeOnChangeKey === key && task.lastResultFingerprint !== undefined
			&& task.lastResultFingerprint !== fingerprint;
		return changed;
	}
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

function formatAbsoluteTime(nextRun, nowValue = new Date()) {
	const date = new Date(nextRun);
	if (!Number.isFinite(date.getTime())) return "unknown";
	const now = asDate(nowValue);
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);

	const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

	if (date.toDateString() === now.toDateString()) {
		return `at ${timeStr}`;
	}
	if (date.toDateString() === tomorrow.toDateString()) {
		return `tomorrow at ${timeStr}`;
	}
	return `on ${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${timeStr}`;
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
	const expiry = task.expiresAt ? ` expiresAt=${task.expiresAt}` : "";
	return `- ${task.id} ${label} next=${next} [${task.action}/${task.type}] ${enabled} status=${task.status} runs=${task.runCount ?? 0}${last}${expiry} schedule=${formatSchedule(task)} :: ${taskSummary(task)}`;
}

function formatTaskList(tasks, nowValue = new Date(), options = {}) {
	const list = options.includeAll ? tasks.slice().sort(sortByNextRun) : pendingTasks(tasks);
	if (list.length === 0) return options.includeAll ? "No scheduled tasks." : "No active scheduled tasks.";
	const title = options.includeAll ? "Scheduled tasks:" : "Active scheduled tasks:";
	const lines = [title];
	for (const task of list) {
		lines.push(formatTaskLine(task, nowValue));
		if (options.includeHistory && task.history?.length) {
			for (const run of task.history) lines.push(`  · ${run.attemptId} ${run.outcome?.status ?? "unknown"} ${run.completedAt} (${run.durationMs}ms)${run.wakeDisposition ? ` wake=${run.wakeDisposition}` : ""}`);
		}
	}
	return lines.join("\n");
}

module.exports = {
	VALID_ACTIONS,
	VALID_TYPES,
	VALID_STATUSES,
	VALID_SCOPES,
	VALID_WAKE_ON,
	VALID_STOP_ON,
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
	normalizeBackoff,
	normalizeStopOn,
	generateId,
	createScheduledTask,
	normalizeTask,
	sanitizeTasks,
	taskMatchesScope,
	pendingTasks,
	canClaimTask,
	expireOverdueTasks,
	dueTasks,
	parseCatchUpOptions,
	selectCatchUpCronTasks,
	recoverInterruptedTasks,
	shellResultFingerprint,
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
	formatAbsoluteTime,
	formatRelativeTime,
	formatTaskLine,
	formatTaskList,
	taskSummary,
};
