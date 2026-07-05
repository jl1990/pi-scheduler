import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cron } from "croner";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

// Keep the scheduler logic testable from plain node --test.
const core = require("./scheduler-core.cjs");

const ACTIONS = ["notify", "prompt", "shell", "message"] as const;
const TYPES = ["once", "interval", "cron"] as const;
const SCOPES = ["session", "cwd", "global"] as const;
const WAKE_ON = ["always", "failure", "success", "never"] as const;
const MANAGE_ACTIONS = ["enable", "disable", "remove", "update", "cleanup"] as const;

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "scheduler", "tasks.json");
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout's practical max (~24.8 days)
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STORED_OUTPUT_CHARS = 12_000;
const MAX_PROMPT_OUTPUT_CHARS = 18_000;

type ScheduledTask = Record<string, any>;
type TimerHandle =
	| { kind: "timeout"; handle: NodeJS.Timeout }
	| { kind: "cron"; handle: Cron };

function truncateMiddle(text: string | undefined, maxChars: number): string {
	const value = text ?? "";
	if (value.length <= maxChars) return value;
	const head = Math.floor(maxChars * 0.35);
	const tail = maxChars - head - 80;
	return `${value.slice(0, head)}\n\n[... truncated ${value.length - maxChars} characters ...]\n\n${value.slice(-tail)}`;
}

function currentSessionFile(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile() ?? undefined;
}

function taskBelongsToSession(task: ScheduledTask, ctx: ExtensionContext): boolean {
	const scope = task.scope ?? "session";
	if (scope === "global") return true;
	if (scope === "cwd") return !task.cwd || task.cwd === ctx.cwd;

	const sessionFile = currentSessionFile(ctx);
	return !task.sessionFile || !sessionFile || task.sessionFile === sessionFile;
}

function sendAgentPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}
}

function scheduledPromptHeader(task: ScheduledTask): string {
	return [
		`[Scheduled task ${task.id} fired]`,
		`Name: ${task.name ?? task.title ?? "(unnamed)"}`,
		`Action: ${task.action}`,
		`Type: ${task.type}`,
		`Schedule: ${task.schedule}`,
		`Scheduled for: ${task.nextRun ?? task.dueAt ?? "unknown"}`,
		"",
	].join("\n");
}

function taskCreatedText(task: ScheduledTask): string {
	const label = task.name ? ` "${task.name}"` : "";
	const next = task.nextRun ? ` next run ${new Date(task.nextRun).toLocaleString()}` : "";
	return `Scheduled ${task.action}/${task.type} task${label} ${task.id}${next}: ${core.taskSummary(task)}`;
}

function shellResultPrompt(task: ScheduledTask, result: Record<string, any>, instruction: string): string {
	const stdout = truncateMiddle(result.stdout ?? "", MAX_PROMPT_OUTPUT_CHARS);
	const stderr = truncateMiddle(result.stderr ?? "", MAX_PROMPT_OUTPUT_CHARS);
	return [
		scheduledPromptHeader(task).trimEnd(),
		"A scheduled shell command completed.",
		"",
		`Command: ${task.command}`,
		`CWD: ${result.cwd}`,
		`Exit code: ${result.code}`,
		`Timed out/killed: ${Boolean(result.killed)}`,
		"",
		"STDOUT:",
		"```",
		stdout,
		"```",
		"",
		"STDERR:",
		"```",
		stderr,
		"```",
		"",
		"Follow-up instruction:",
		instruction,
	].join("\n");
}

function taskLabel(task: ScheduledTask): string {
	return task.name || task.title || task.id;
}

export default function schedulerExtension(pi: ExtensionAPI) {
	let tasks: ScheduledTask[] = [];
	let handles = new Map<string, TimerHandle>();
	let activeCtx: ExtensionContext | undefined;
	let saveQueue: Promise<void> = Promise.resolve();
	let widgetEnabled = true;
	const firing = new Set<string>();

	async function loadTasks(): Promise<void> {
		try {
			const raw = await readFile(STATE_FILE, "utf8");
			const parsed = JSON.parse(raw);
			tasks = core.sanitizeTasks(parsed.tasks ?? parsed);
		} catch (error: any) {
			if (error?.code === "ENOENT") {
				tasks = [];
				return;
			}
			throw error;
		}
	}

	async function saveTasks(): Promise<void> {
		const payload = JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), tasks }, null, 2) + "\n";
		saveQueue = saveQueue.then(async () => {
			await mkdir(dirname(STATE_FILE), { recursive: true });
			const tmp = `${STATE_FILE}.${process.pid}.tmp`;
			await writeFile(tmp, payload, "utf8");
			await rename(tmp, STATE_FILE);
		});
		return saveQueue;
	}

	function clearHandle(id: string): void {
		const handle = handles.get(id);
		if (!handle) return;
		if (handle.kind === "cron") handle.handle.stop();
		else clearTimeout(handle.handle);
		handles.delete(id);
	}

	function clearTimers(): void {
		for (const id of [...handles.keys()]) clearHandle(id);
	}

	function visibleTasks(ctx = activeCtx): ScheduledTask[] {
		if (!ctx) return tasks;
		return tasks.filter((task) => taskBelongsToSession(task, ctx));
	}

	function updateWidget(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		if (!widgetEnabled) {
			ctx.ui.setWidget("scheduler", undefined);
			return;
		}

		const upcoming = core.pendingTasks(visibleTasks(ctx)).slice(0, 3);
		if (upcoming.length === 0) {
			ctx.ui.setWidget("scheduler", undefined);
			return;
		}

		const lines = ["⏰ Scheduled Actions"];
		for (const task of upcoming) {
			const next = task.nextRun ? core.formatRelativeTime(task.nextRun) : "no next run";
			const last = task.lastStatus ? ` last=${task.lastStatus}` : "";
			lines.push(`  ✓ ${taskLabel(task)} ${task.action}/${task.type} ${next} runs=${task.runCount ?? 0}${last}`);
		}
		ctx.ui.setWidget("scheduler", lines, { placement: "belowEditor" });
	}

	function updateStatus(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		const count = core.pendingTasks(visibleTasks(ctx)).length;
		ctx.ui.setStatus("scheduler", count ? `⏰ ${count} scheduled` : undefined);
		updateWidget(ctx);
	}

	function scheduleTaskHandle(task: ScheduledTask, ctx: ExtensionContext): void {
		if (task.enabled === false || task.status !== "pending") return;
		if (!taskBelongsToSession(task, ctx)) return;
		clearHandle(task.id);

		if (task.type === "cron") {
			try {
				const cron = new Cron(task.schedule, () => {
					void fireTask(task.id, ctx);
				});
				handles.set(task.id, { kind: "cron", handle: cron });
			} catch (error: any) {
				task.enabled = false;
				task.status = "failed";
				task.lastStatus = "error";
				task.lastError = error?.message ?? String(error);
				void saveTasks();
			}
			return;
		}

		const dueAt = Date.parse(task.nextRun ?? task.dueAt);
		if (!Number.isFinite(dueAt)) return;
		const delay = Math.max(0, dueAt - Date.now());
		const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

		const timer = setTimeout(() => {
			handles.delete(task.id);
			if (Date.now() < dueAt) {
				scheduleTaskHandle(task, ctx);
				return;
			}
			void fireTask(task.id, ctx);
		}, timerDelay);
		handles.set(task.id, { kind: "timeout", handle: timer });
	}

	function rescheduleAll(ctx = activeCtx): void {
		if (!ctx) return;
		clearTimers();
		for (const task of core.pendingTasks(tasks)) scheduleTaskHandle(task, ctx);
		updateStatus(ctx);
	}

	function recordMessage(content: string, details?: Record<string, any>, triggerTurn = false): void {
		pi.sendMessage(
			{
				customType: "scheduled-task",
				content,
				display: true,
				details,
			},
			{ triggerTurn },
		);
	}

	async function executeTask(task: ScheduledTask, ctx: ExtensionContext): Promise<Record<string, any>> {
		if (task.action === "notify") {
			const message = task.message ?? "Scheduled reminder";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			recordMessage(`🔔 ${message}`, { task }, false);
			return { ok: true, delivered: "notify" };
		}

		if (task.action === "prompt") {
			const prompt = `${scheduledPromptHeader(task)}${task.prompt}`;
			sendAgentPrompt(pi, ctx, prompt);
			return { ok: true, delivered: "prompt" };
		}

		if (task.action === "message") {
			const message = task.message ?? "Scheduled message";
			recordMessage(`⏰ ${message}`, { task }, task.triggerTurn !== false);
			return { ok: true, delivered: "message", triggerTurn: task.triggerTurn !== false };
		}

		if (task.action === "shell") {
			const cwd = task.cwd || ctx.cwd;
			const timeout = task.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			if (ctx.hasUI) ctx.ui.notify(`Running scheduled command: ${task.command}`, "info");

			const result = await pi.exec("bash", ["-lc", task.command], { cwd, timeout });
			const shellResult = {
				ok: result.code === 0 && result.killed !== true,
				command: task.command,
				cwd,
				timeoutMs: timeout,
				code: result.code,
				killed: result.killed,
				stdout: truncateMiddle(result.stdout ?? "", MAX_STORED_OUTPUT_CHARS),
				stderr: truncateMiddle(result.stderr ?? "", MAX_STORED_OUTPUT_CHARS),
			};

			recordMessage(
				`🖥️ Scheduled command ${task.id} finished with exit code ${result.code}: ${task.command}`,
				{ task, result: shellResult },
				false,
			);

			if (core.shouldWakeForShellResult(task, shellResult)) {
				const instruction = core.selectShellFollowUpPrompt(task, shellResult);
				if (instruction) sendAgentPrompt(pi, ctx, shellResultPrompt(task, shellResult, instruction));
			}

			return shellResult;
		}

		throw new Error(`Unsupported scheduled action: ${task.action}`);
	}

	async function fireTask(taskId: string, ctx: ExtensionContext): Promise<void> {
		const task = tasks.find((candidate) => candidate.id === taskId);
		if (!task || task.enabled === false || task.status !== "pending" || firing.has(task.id)) return;
		if (!taskBelongsToSession(task, ctx)) return;

		firing.add(task.id);
		try {
			core.markScheduledTaskRunning(tasks, task.id, new Date());
			await saveTasks();
			updateStatus(ctx);
			const result = await executeTask(task, ctx);
			core.markScheduledTaskCompleted(tasks, task.id, new Date(), result, { ok: result.ok !== false });
			await saveTasks();
		} catch (error: any) {
			core.markScheduledTaskFailed(tasks, task.id, new Date(), error);
			await saveTasks();
			const message = `Scheduled task ${task.id} failed: ${error?.message ?? String(error)}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			recordMessage(`⚠️ ${message}`, { task, error: error?.message ?? String(error) }, false);
		} finally {
			firing.delete(task.id);
			rescheduleAll(ctx);
		}
	}

	async function createAndSchedule(input: Record<string, any>, ctx: ExtensionContext): Promise<ScheduledTask> {
		const scope = input.scope ?? "session";
		const task = core.createScheduledTask(
			{
				...input,
				schedule: input.schedule ?? input.when ?? input.whenText,
				cwd: input.cwd ?? ctx.cwd,
				scope,
				sessionFile: scope === "session" ? currentSessionFile(ctx) : undefined,
			},
			new Date(),
		);
		tasks.push(task);
		await saveTasks();
		rescheduleAll(ctx);
		return task;
	}

	function parseCommandTask(args: string, ctx: ExtensionContext): Record<string, any> {
		const parsed = core.splitScheduleCommand(args, new Date());
		const base: Record<string, any> = {
			action: parsed.action,
			type: parsed.type,
			schedule: parsed.schedule,
			cwd: ctx.cwd,
		};
		if (parsed.action === "prompt") return { ...base, prompt: parsed.payload };
		if (parsed.action === "shell") return { ...base, command: parsed.payload };
		return { ...base, message: parsed.payload };
	}

	function cleanupVisibleTasks(ctx: ExtensionContext): ScheduledTask[] {
		const removable = visibleTasks(ctx).filter(
			(task) => task.enabled === false || ["fired", "cancelled", "failed"].includes(task.status),
		);
		const removableIds = new Set(removable.map((task) => task.id));
		tasks = tasks.filter((task) => !removableIds.has(task.id));
		for (const task of removable) clearHandle(task.id);
		return removable;
	}

	async function mutateVisibleTask(
		ctx: ExtensionContext,
		id: string,
		mutator: (visible: ScheduledTask[]) => ScheduledTask,
	): Promise<ScheduledTask> {
		await loadTasks();
		const visible = visibleTasks(ctx);
		const task = mutator(visible);
		await saveTasks();
		rescheduleAll(ctx);
		return task;
	}

	pi.registerMessageRenderer("scheduled-task", (message, options, theme) => {
		let text = `${theme.fg("accent", theme.bold("scheduled"))} ${message.content}`;
		if (options.expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		await loadTasks();
		rescheduleAll(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimers();
		if (ctx.hasUI) {
			ctx.ui.setStatus("scheduler", undefined);
			ctx.ui.setWidget("scheduler", undefined);
		}
		activeCtx = undefined;
	});

	pi.registerCommand("schedule", {
		description: "Schedule a notify, prompt, shell command, or message action",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /schedule [notify|prompt|shell|message] [once|every|interval|cron] <schedule> :: <payload>", "warning");
				return;
			}
			try {
				const task = await createAndSchedule(parseCommandTask(args, ctx), ctx);
				ctx.ui.notify(taskCreatedText(task), "info");
				recordMessage(taskCreatedText(task), { task }, false);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("remind", {
		description: "Alias for /schedule notify",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /remind <when> <message>", "warning");
				return;
			}
			try {
				const parsed = core.splitScheduleCommand(`notify ${args}`, new Date());
				const task = await createAndSchedule(
					{ action: "notify", type: parsed.type, schedule: parsed.schedule, message: parsed.payload, cwd: ctx.cwd },
					ctx,
				);
				ctx.ui.notify(taskCreatedText(task), "info");
				recordMessage(taskCreatedText(task), { task }, false);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedules", {
		description: "List scheduled tasks; pass 'all' to include disabled/completed/cancelled/failed tasks",
		handler: async (args, ctx) => {
			await loadTasks();
			const includeAll = args.trim().toLowerCase() === "all";
			const visible = visibleTasks(ctx);
			recordMessage(core.formatTaskList(visible, new Date(), { includeAll }), { includeAll, tasks: visible }, false);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("schedule-cancel", {
		description: "Cancel a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /schedule-cancel <id>", "warning");
				return;
			}
			try {
				const task = await mutateVisibleTask(ctx, id, (visible) => core.cancelScheduledTask(visible, id, new Date()));
				ctx.ui.notify(`Cancelled scheduled task ${task.id}`, "info");
				recordMessage(`Cancelled scheduled task ${task.id}`, { task }, false);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-enable", {
		description: "Enable a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			try {
				const task = await mutateVisibleTask(ctx, args.trim(), (visible) => core.enableScheduledTask(visible, args.trim(), new Date()));
				ctx.ui.notify(`Enabled scheduled task ${task.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-disable", {
		description: "Disable a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			try {
				const task = await mutateVisibleTask(ctx, args.trim(), (visible) => core.disableScheduledTask(visible, args.trim(), new Date()));
				ctx.ui.notify(`Disabled scheduled task ${task.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-remove", {
		description: "Remove a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			try {
				await loadTasks();
				const visibleRemoved = core.removeScheduledTask(visibleTasks(ctx), id);
				const removed = core.removeScheduledTask(tasks, visibleRemoved.id);
				clearHandle(removed.id);
				await saveTasks();
				rescheduleAll(ctx);
				ctx.ui.notify(`Removed scheduled task ${removed.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-cleanup", {
		description: "Remove disabled/completed/cancelled/failed scheduled tasks visible to this session",
		handler: async (_args, ctx) => {
			await loadTasks();
			const removed = cleanupVisibleTasks(ctx);
			await saveTasks();
			rescheduleAll(ctx);
			ctx.ui.notify(`Cleaned up ${removed.length} scheduled task(s)`, "info");
		},
	});

	pi.registerCommand("schedule-widget", {
		description: "Turn the compact scheduled-actions widget on or off for this session",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "off" || value === "false" || value === "0") widgetEnabled = false;
			else if (value === "on" || value === "true" || value === "1" || value === "") widgetEnabled = true;
			else {
				ctx.ui.notify("Usage: /schedule-widget [on|off]", "warning");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(`Schedule widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		description:
			"Schedule a future or recurring action in this Pi session: notify the user, wake the agent with a prompt, run a shell command, or send a custom message.",
		promptSnippet: "Schedule future/recurring notify, prompt, shell, or message actions in the current Pi session",
		promptGuidelines: [
			"Use schedule_task when the user asks to do something later, when waiting on external systems such as CI/CD pipelines, or when the agent needs to wake itself up to continue work.",
			"Use schedule_task type='once' for one-shot work, type='interval' for repeated polling, and type='cron' for calendar-style schedules.",
			"Prefer schedule_task action='shell' with followUpPrompt/failurePrompt when a fixed command should run later and its output should be reviewed by the agent.",
			"For bounded polling workflows, set maxRuns so interval tasks do not run forever.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description: "What to do at the scheduled time. Use prompt to wake the agent.",
				default: "prompt",
			}),
			type: Type.Optional(
				StringEnum(TYPES, { description: "Schedule type: once (default), interval, or cron.", default: "once" }),
			),
			when: Type.Optional(
				Type.String({
					description: "Backward-compatible alias for schedule, e.g. '5m', 'in 10 minutes', 'tomorrow at 9am'.",
				}),
			),
			schedule: Type.Optional(
				Type.String({ description: "Schedule string. once: '5m'/'tomorrow at 9am'; interval: '5m'; cron: '0 */5 * * * *'." }),
			),
			name: Type.Optional(Type.String({ description: "Optional human-readable task name." })),
			description: Type.Optional(Type.String({ description: "Optional task description." })),
			scope: Type.Optional(StringEnum(SCOPES, { description: "Task scope. Default session.", default: "session" })),
			enabled: Type.Optional(Type.Boolean({ description: "Whether the task starts enabled. Default true." })),
			maxRuns: Type.Optional(Type.Number({ description: "Disable after this many runs. Useful for bounded polling.", minimum: 1 })),
			message: Type.Optional(Type.String({ description: "Message for notify/message actions." })),
			prompt: Type.Optional(Type.String({ description: "User prompt to inject for prompt actions." })),
			command: Type.Optional(Type.String({ description: "Shell command to run for shell actions." })),
			payload: Type.Optional(Type.String({ description: "Generic payload fallback for any action." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for shell actions; defaults to current cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Shell timeout in milliseconds.", minimum: 1000 })),
			wakeOn: Type.Optional(StringEnum(WAKE_ON, { description: "For shell actions: when to wake the agent. Default always if a prompt is configured, otherwise never." })),
			followUpPrompt: Type.Optional(
				Type.String({ description: "For shell actions: generic follow-up instruction sent with stdout/stderr." }),
			),
			successPrompt: Type.Optional(Type.String({ description: "For shell actions: follow-up instruction used on exit code 0." })),
			failurePrompt: Type.Optional(Type.String({ description: "For shell actions: follow-up instruction used on non-zero/timeout." })),
			title: Type.Optional(Type.String({ description: "Backward-compatible human-readable title alias." })),
			triggerTurn: Type.Optional(
				Type.Boolean({ description: "For message actions: whether the message should trigger an agent turn. Default true." }),
			),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, any>;
			if (input.schedule === undefined && input.when === undefined && typeof input.whenText === "string") {
				return { ...input, when: input.whenText };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await createAndSchedule(params, ctx);
			return {
				content: [{ type: "text", text: taskCreatedText(task) }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("schedule_task"))} ${theme.fg("muted", args.action ?? "prompt")}/${theme.fg("muted", args.type ?? "once")} ${theme.fg("accent", args.schedule ?? args.when ?? "")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.[0];
			return new Text(theme.fg("success", "✓ ") + (text?.type === "text" ? text.text : "Scheduled"), 0, 0);
		},
	});

	pi.registerTool({
		name: "list_scheduled_tasks",
		label: "List Scheduled Tasks",
		description: "List pending or all scheduled tasks visible to the current Pi session.",
		promptSnippet: "List pending/all scheduled future or recurring actions visible to the current Pi session",
		parameters: Type.Object({
			includeAll: Type.Optional(Type.Boolean({ description: "Include disabled, fired, cancelled, and failed tasks. Default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await loadTasks();
			const visible = visibleTasks(ctx);
			const text = core.formatTaskList(visible, new Date(), { includeAll: Boolean(params.includeAll) });
			updateStatus(ctx);
			return { content: [{ type: "text", text }], details: { tasks: visible } };
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		description: "Cancel a scheduled task by id or id prefix. Alias for disabling with cancelled status.",
		promptSnippet: "Cancel a scheduled task by id or prefix",
		parameters: Type.Object({
			id: Type.String({ description: "Task id or unique id prefix." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await mutateVisibleTask(ctx, params.id, (visible) => core.cancelScheduledTask(visible, params.id, new Date()));
			return {
				content: [{ type: "text", text: `Cancelled scheduled task ${task.id}` }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
	});

	pi.registerTool({
		name: "manage_scheduled_task",
		label: "Manage Scheduled Task",
		description: "Enable, disable, remove, update, or cleanup scheduled tasks visible to this Pi session.",
		promptSnippet: "Manage scheduled tasks: enable, disable, remove, update, or cleanup",
		parameters: Type.Object({
			action: StringEnum(MANAGE_ACTIONS, { description: "Management action to perform." }),
			id: Type.Optional(Type.String({ description: "Task id or unique id prefix. Required except for cleanup." })),
			name: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			type: Type.Optional(StringEnum(TYPES)),
			schedule: Type.Optional(Type.String()),
			scope: Type.Optional(StringEnum(SCOPES)),
			enabled: Type.Optional(Type.Boolean()),
			maxRuns: Type.Optional(Type.Number({ minimum: 1 })),
			prompt: Type.Optional(Type.String()),
			message: Type.Optional(Type.String()),
			command: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1000 })),
			wakeOn: Type.Optional(StringEnum(WAKE_ON)),
			followUpPrompt: Type.Optional(Type.String()),
			successPrompt: Type.Optional(Type.String()),
			failurePrompt: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await loadTasks();
			if (params.action === "cleanup") {
				const removed = cleanupVisibleTasks(ctx);
				await saveTasks();
				rescheduleAll(ctx);
				return { content: [{ type: "text", text: `Cleaned up ${removed.length} scheduled task(s).` }], details: { removed } };
			}

			if (!params.id) throw new Error("id is required for this management action");
			let task: ScheduledTask;
			if (params.action === "enable") {
				task = core.enableScheduledTask(visibleTasks(ctx), params.id, new Date());
			} else if (params.action === "disable") {
				task = core.disableScheduledTask(visibleTasks(ctx), params.id, new Date());
			} else if (params.action === "remove") {
				const visibleRemoved = core.removeScheduledTask(visibleTasks(ctx), params.id);
				task = core.removeScheduledTask(tasks, visibleRemoved.id);
				clearHandle(task.id);
			} else {
				const updates = { ...params };
				delete updates.action;
				delete updates.id;
				task = core.updateScheduledTask(visibleTasks(ctx), params.id, updates, new Date());
			}

			await saveTasks();
			rescheduleAll(ctx);
			return {
				content: [{ type: "text", text: `${params.action} scheduled task ${task.id}` }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
	});
}
