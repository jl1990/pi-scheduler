import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

// Keep the scheduler logic testable from plain node --test.
const core = require("./scheduler-core.cjs");

const ACTIONS = ["notify", "prompt", "shell", "message"] as const;
const STATE_FILE = join(homedir(), ".pi", "agent", "state", "scheduler", "tasks.json");
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout's practical max (~24.8 days)
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STORED_OUTPUT_CHARS = 12_000;
const MAX_PROMPT_OUTPUT_CHARS = 18_000;

type ScheduledTask = Record<string, any>;

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
		`Action: ${task.action}`,
		`Scheduled for: ${task.dueAt}`,
		"",
	].join("\n");
}

function taskCreatedText(task: ScheduledTask): string {
	return `Scheduled ${task.action} task ${task.id} for ${new Date(task.dueAt).toLocaleString()}: ${core.taskSummary(task)}`;
}

function shellResultPrompt(task: ScheduledTask, result: Record<string, any>): string {
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
		task.followUpPrompt,
	].join("\n");
}

export default function schedulerExtension(pi: ExtensionAPI) {
	let tasks: ScheduledTask[] = [];
	let timers = new Map<string, NodeJS.Timeout>();
	let activeCtx: ExtensionContext | undefined;
	let saveQueue: Promise<void> = Promise.resolve();
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
		const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks }, null, 2) + "\n";
		saveQueue = saveQueue.then(async () => {
			await mkdir(dirname(STATE_FILE), { recursive: true });
			const tmp = `${STATE_FILE}.${process.pid}.tmp`;
			await writeFile(tmp, payload, "utf8");
			await rename(tmp, STATE_FILE);
		});
		return saveQueue;
	}

	function clearTimers(): void {
		for (const timer of timers.values()) clearTimeout(timer);
		timers = new Map();
	}

	function updateStatus(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		const count = core.pendingTasks(tasks).filter((task: ScheduledTask) => taskBelongsToSession(task, ctx)).length;
		ctx.ui.setStatus("scheduler", count ? `⏰ ${count} scheduled` : undefined);
	}

	function scheduleTaskTimer(task: ScheduledTask, ctx: ExtensionContext): void {
		if (task.status !== "pending") return;
		if (!taskBelongsToSession(task, ctx)) return;

		const dueAt = Date.parse(task.dueAt);
		if (!Number.isFinite(dueAt)) return;
		const delay = Math.max(0, dueAt - Date.now());
		const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

		const timer = setTimeout(() => {
			timers.delete(task.id);
			if (Date.now() < dueAt) {
				scheduleTaskTimer(task, ctx);
				return;
			}
			void fireTask(task.id, ctx);
		}, timerDelay);
		timers.set(task.id, timer);
	}

	function rescheduleAll(ctx = activeCtx): void {
		if (!ctx) return;
		clearTimers();
		for (const task of core.pendingTasks(tasks)) {
			scheduleTaskTimer(task, ctx);
		}
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
			return { delivered: "notify" };
		}

		if (task.action === "prompt") {
			const prompt = `${scheduledPromptHeader(task)}${task.prompt}`;
			sendAgentPrompt(pi, ctx, prompt);
			return { delivered: "prompt" };
		}

		if (task.action === "message") {
			const message = task.message ?? "Scheduled message";
			recordMessage(`⏰ ${message}`, { task }, task.triggerTurn !== false);
			return { delivered: "message", triggerTurn: task.triggerTurn !== false };
		}

		if (task.action === "shell") {
			const cwd = task.cwd || ctx.cwd;
			const timeout = task.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			if (ctx.hasUI) ctx.ui.notify(`Running scheduled command: ${task.command}`, "info");

			const result = await pi.exec("bash", ["-lc", task.command], { cwd, timeout });
			const shellResult = {
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

			if (task.followUpPrompt) {
				sendAgentPrompt(pi, ctx, shellResultPrompt(task, shellResult));
			}

			return shellResult;
		}

		throw new Error(`Unsupported scheduled action: ${task.action}`);
	}

	async function fireTask(taskId: string, ctx: ExtensionContext): Promise<void> {
		const task = tasks.find((candidate) => candidate.id === taskId);
		if (!task || task.status !== "pending" || firing.has(task.id)) return;
		if (!taskBelongsToSession(task, ctx)) return;

		firing.add(task.id);
		try {
			core.markScheduledTaskRunning(tasks, task.id, new Date());
			await saveTasks();
			const result = await executeTask(task, ctx);
			core.markScheduledTaskFired(tasks, task.id, new Date(), result);
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
		const task = core.createScheduledTask(
			{
				...input,
				whenText: input.whenText ?? input.when,
				cwd: input.cwd ?? ctx.cwd,
				sessionFile: currentSessionFile(ctx),
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
		const base: Record<string, any> = { action: parsed.action, whenText: parsed.whenText, cwd: ctx.cwd };
		if (parsed.action === "prompt") return { ...base, prompt: parsed.payload };
		if (parsed.action === "shell") return { ...base, command: parsed.payload };
		return { ...base, message: parsed.payload };
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
		if (ctx.hasUI) ctx.ui.setStatus("scheduler", undefined);
		activeCtx = undefined;
	});

	pi.registerCommand("schedule", {
		description: "Schedule a notify, prompt, shell command, or message action",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /schedule [notify|prompt|shell|message] <when> :: <payload>", "warning");
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
					{ action: "notify", whenText: parsed.whenText, message: parsed.payload, cwd: ctx.cwd },
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
		description: "List scheduled tasks; pass 'all' to include fired/cancelled/failed tasks",
		handler: async (args, ctx) => {
			await loadTasks();
			const includeAll = args.trim().toLowerCase() === "all";
			const visible = tasks.filter((task) => taskBelongsToSession(task, ctx));
			recordMessage(core.formatTaskList(visible, new Date(), { includeAll }), { includeAll, tasks: visible }, false);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("schedule-cancel", {
		description: "Cancel a pending scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /schedule-cancel <id>", "warning");
				return;
			}
			try {
				await loadTasks();
				const visible = tasks.filter((task) => taskBelongsToSession(task, ctx));
				const task = core.cancelScheduledTask(visible, id, new Date());
				await saveTasks();
				rescheduleAll(ctx);
				ctx.ui.notify(`Cancelled scheduled task ${task.id}`, "info");
				recordMessage(`Cancelled scheduled task ${task.id}`, { task }, false);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		description:
			"Schedule a future action in this Pi session: notify the user, wake the agent with a prompt, run a shell command, or send a custom message.",
		promptSnippet: "Schedule future notify, prompt, shell, or message actions in the current Pi session",
		promptGuidelines: [
			"Use schedule_task when the user asks to do something later, when waiting on external systems such as CI/CD pipelines, or when the agent needs to wake itself up to continue work.",
			"Prefer schedule_task action='prompt' for agentic follow-ups; include enough context for the future agent to know what to check and what to do next.",
			"For polling workflows, schedule a future prompt that says to check the status and schedule another check if the work is still pending.",
			"Use schedule_task action='shell' with followUpPrompt when a fixed command should run later and its output should be reviewed by the agent.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description: "What to do at the scheduled time. Use prompt to wake the agent.",
				default: "prompt",
			}),
			when: Type.String({
				description: "When to run, e.g. '5m', 'in 10 minutes', 'tomorrow at 9am', '14:30', or an ISO datetime.",
			}),
			message: Type.Optional(Type.String({ description: "Message for notify/message actions." })),
			prompt: Type.Optional(Type.String({ description: "User prompt to inject for prompt actions." })),
			command: Type.Optional(Type.String({ description: "Shell command to run for shell actions." })),
			payload: Type.Optional(Type.String({ description: "Generic payload fallback for any action." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for shell actions; defaults to current cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Shell timeout in milliseconds.", minimum: 1000 })),
			followUpPrompt: Type.Optional(
				Type.String({
					description:
						"For shell actions: if set, wake the agent after the command completes and include stdout/stderr plus this instruction.",
				}),
			),
			title: Type.Optional(Type.String({ description: "Optional human-readable title." })),
			triggerTurn: Type.Optional(
				Type.Boolean({ description: "For message actions: whether the message should trigger an agent turn. Default true." }),
			),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, any>;
			if (input.when === undefined && typeof input.whenText === "string") {
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
				`${theme.fg("toolTitle", theme.bold("schedule_task"))} ${theme.fg("muted", args.action ?? "prompt")} ${theme.fg("accent", args.when ?? "")}`,
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
		description: "List pending or all scheduled tasks for the current Pi session.",
		promptSnippet: "List pending/all scheduled future actions in the current Pi session",
		parameters: Type.Object({
			includeAll: Type.Optional(Type.Boolean({ description: "Include fired, cancelled, and failed tasks. Default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await loadTasks();
			const visible = tasks.filter((task) => taskBelongsToSession(task, ctx));
			const text = core.formatTaskList(visible, new Date(), { includeAll: Boolean(params.includeAll) });
			updateStatus(ctx);
			return { content: [{ type: "text", text }], details: { tasks: visible } };
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		description: "Cancel a pending scheduled task by id or id prefix.",
		promptSnippet: "Cancel a pending scheduled task by id or prefix",
		parameters: Type.Object({
			id: Type.String({ description: "Task id or unique id prefix." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await loadTasks();
			const visible = tasks.filter((task) => taskBelongsToSession(task, ctx));
			const task = core.cancelScheduledTask(visible, params.id, new Date());
			await saveTasks();
			rescheduleAll(ctx);
			return {
				content: [{ type: "text", text: `Cancelled scheduled task ${task.id}` }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
	});
}
