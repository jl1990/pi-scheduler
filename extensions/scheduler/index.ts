import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// Keep the scheduler logic testable from plain node --test.
const core = require("./scheduler-core.cjs");
const lifecycle = require("./scheduler-lifecycle.cjs");
const coordination = require("./scheduler-coordination.cjs");
const { createTaskStore } = require("./task-store.cjs");

const ACTIONS = ["notify", "prompt", "shell", "message"] as const;
const TYPES = ["once", "interval", "cron"] as const;
const SCOPES = ["session", "cwd", "global"] as const;
const WAKE_ON = ["always", "failure", "success", "never", "change"] as const;
const STOP_ON = ["success", "failure", "never"] as const;
const MANAGE_ACTIONS = ["enable", "disable", "remove", "update", "cleanup"] as const;

const STATE_FILE = process.env.PI_SCHEDULER_STATE_FILE || join(homedir(), ".pi", "agent", "state", "scheduler", "tasks.json");
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout's practical max (~24.8 days)
const STATE_REFRESH_INTERVAL_MS = 5_000;
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
	return core.taskMatchesScope(task, { cwd: ctx.cwd, sessionFile: currentSessionFile(ctx) });
}

function isRunOwnerActive(owner: Record<string, any> | undefined): boolean {
	const pid = Number(owner?.pid);
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
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
	let expiryHandles = new Map<string, NodeJS.Timeout>();
	let activeCtx: ExtensionContext | undefined;
	let sessionGeneration = 0;
	let stateRevision = -1;
	let widgetEnabled = true;
	const firing = new Set<string>();
	const store = createTaskStore({ stateFile: STATE_FILE, sanitize: core.sanitizeTasks });

	function isSessionActive(ctx: ExtensionContext, generation = sessionGeneration): boolean {
		return lifecycle.isSessionContextActive(activeCtx, ctx, sessionGeneration, generation);
	}

	async function loadTasks(): Promise<boolean> {
		const snapshot = await store.read();
		return coordination.reconcileSnapshot(
			snapshot,
			stateRevision,
			(nextTasks: ScheduledTask[], revision: number) => {
				tasks = nextTasks;
				stateRevision = revision;
			},
			() => rescheduleAll(),
		);
	}

	async function transactTasks<T>(mutator: (current: ScheduledTask[]) => T | Promise<T>): Promise<T> {
		const transaction = await store.transact(mutator);
		if (transaction.revision >= stateRevision) {
			tasks = transaction.tasks;
			stateRevision = transaction.revision;
		}
		return transaction.result;
	}

	function clearHandle(id: string): void {
		const handle = handles.get(id);
		if (handle?.kind === "cron") handle.handle.stop();
		else if (handle) clearTimeout(handle.handle);
		handles.delete(id);
		const expiry = expiryHandles.get(id);
		if (expiry) clearTimeout(expiry);
		expiryHandles.delete(id);
	}

	function clearTimers(): void {
		for (const id of new Set([...handles.keys(), ...expiryHandles.keys()])) clearHandle(id);
	}

	function scheduleExpiry(task: ScheduledTask, ctx: ExtensionContext, generation = sessionGeneration): void {
		if (!task.expiresAt || task.status !== "pending" || !taskBelongsToSession(task, ctx)) return;
		const deadline = Date.parse(task.expiresAt);
		if (!Number.isFinite(deadline)) return;
		const timer = setTimeout(() => {
			expiryHandles.delete(task.id);
			if (!isSessionActive(ctx, generation)) return;
			void transactTasks((current) => {
				if (!isSessionActive(ctx, generation)) return;
				core.expireOverdueTasks(current.filter((item) => taskBelongsToSession(item, ctx)), new Date());
			}).then(() => {
				if (isSessionActive(ctx, generation)) rescheduleAll(generation);
			}).catch((error: any) => {
				if (isSessionActive(ctx, generation) && ctx.hasUI) ctx.ui.notify(`Scheduler expiry failed: ${error?.message ?? String(error)}`, "error");
			});
		}, Math.max(0, Math.min(deadline - Date.now(), MAX_TIMER_DELAY_MS)));
		expiryHandles.set(task.id, timer);
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
			const relative = task.nextRun ? core.formatRelativeTime(task.nextRun) : "no next run";
			const absolute = task.nextRun ? core.formatAbsoluteTime(task.nextRun) : "";
			const when = absolute ? `${relative} (${absolute})` : relative;
			const last = task.lastStatus ? ` last=${task.lastStatus}` : "";
			lines.push(`  ✓ ${taskLabel(task)} ${task.action}/${task.type} ${when} runs=${task.runCount ?? 0}${last}`);
		}
		ctx.ui.setWidget("scheduler", lines, { placement: "belowEditor" });
	}

	function updateStatus(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		const count = core.pendingTasks(visibleTasks(ctx)).length;
		ctx.ui.setStatus("scheduler", count ? `⏰ ${count} scheduled` : undefined);
		updateWidget(ctx);
	}

	function scheduleTaskHandle(task: ScheduledTask, ctx: ExtensionContext, generation = sessionGeneration): void {
		if (!isSessionActive(ctx, generation)) return;
		if (task.enabled === false || task.status !== "pending") return;
		if (!taskBelongsToSession(task, ctx)) return;
		clearHandle(task.id);

		if (task.type === "cron") {
			try {
				const cron = new Cron(task.schedule, () => {
					void fireTask(task.id, ctx, generation);
				});
				handles.set(task.id, { kind: "cron", handle: cron });
			} catch (error: any) {
				const message = error?.message ?? String(error);
				void transactTasks((current) => {
					const persisted = current.find((candidate) => candidate.id === task.id);
					if (!persisted) return;
					persisted.enabled = false;
					persisted.status = "failed";
					persisted.lastStatus = "error";
					persisted.lastError = message;
				});
			}
			return;
		}

		const dueAt = Date.parse(task.nextRun ?? task.dueAt);
		if (!Number.isFinite(dueAt)) return;
		const delay = Math.max(0, dueAt - Date.now());
		const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

		const timer = setTimeout(() => {
			handles.delete(task.id);
			if (!isSessionActive(ctx, generation)) return;
			if (Date.now() < dueAt) {
				scheduleTaskHandle(task, ctx, generation);
				return;
			}
			void fireTask(task.id, ctx, generation);
		}, timerDelay);
		handles.set(task.id, { kind: "timeout", handle: timer });
	}

	function rescheduleAll(generation = sessionGeneration): void {
		const ctx = activeCtx;
		if (!ctx || !isSessionActive(ctx, generation)) return;
		clearTimers();
		for (const task of core.pendingTasks(tasks)) scheduleTaskHandle(task, ctx, generation);
		for (const task of tasks) scheduleExpiry(task, ctx, generation);
		updateStatus(ctx);
	}

	async function refreshFromStore(generation = sessionGeneration): Promise<void> {
		const ctx = activeCtx;
		if (!ctx || !isSessionActive(ctx, generation)) return;
		await coordination.refreshSchedulerState({
			store,
			currentRevision: () => stateRevision,
			isOwnerActive: isRunOwnerActive,
			recoverInterrupted: (current: ScheduledTask[], now: Date, options: any) => {
				core.expireOverdueTasks(current, now);
				return core.recoverInterruptedTasks(current, now, options);
			},
			now: () => new Date(),
			install: (nextTasks: ScheduledTask[], revision: number) => {
				tasks = nextTasks;
				stateRevision = revision;
			},
			reconcile: () => rescheduleAll(generation),
		});
	}

	const refreshLoop = coordination.createRefreshLoop({
		intervalMs: STATE_REFRESH_INTERVAL_MS,
		run: refreshFromStore,
		onError: (error: any) => {
			if (activeCtx?.hasUI) activeCtx.ui.notify(`Scheduler state refresh failed: ${error?.message ?? String(error)}`, "error");
		},
		setInterval,
		clearInterval,
	});

	function startStateRefresh(generation: number): void {
		refreshLoop.start(generation);
	}

	async function catchUpOverdueCronTasks(
		ctx: ExtensionContext,
		generation: number,
		options: { windowHours: number; maxFire: number },
	): Promise<void> {
		const overdue = core.selectCatchUpCronTasks(visibleTasks(ctx), new Date(), options);
		if (overdue.length === 0 || !isSessionActive(ctx, generation)) return;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Catching up ${overdue.length} missed cron task(s) (window ${options.windowHours}h, limit ${options.maxFire})`,
				"info",
			);
		}

		for (const { task, missedAt } of overdue) {
			if (!isSessionActive(ctx, generation)) return;
			await fireTask(task.id, ctx, generation, {
				expectedNextRun: task.nextRun ?? task.dueAt,
				occurrence: missedAt.toISOString(),
			});
		}
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

	async function executeTask(
		task: ScheduledTask,
		ctx: ExtensionContext,
		isActive: () => boolean,
	): Promise<Record<string, any>> {
		if (task.action === "notify") {
			const message = task.message ?? "Scheduled reminder";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			recordMessage(`🔔 ${message}`, { task }, false);
			return { ok: true, delivered: "notify", wakeReason: "notify", wakeDisposition: "not-requested" };
		}

		if (task.action === "prompt") {
			const prompt = `${scheduledPromptHeader(task)}${task.prompt}`;
			sendAgentPrompt(pi, ctx, prompt);
			return { ok: true, delivered: "prompt", wakeReason: "prompt", wakeDisposition: "delivered" };
		}

		if (task.action === "message") {
			const message = task.message ?? "Scheduled message";
			recordMessage(`⏰ ${message}`, { task }, task.triggerTurn !== false);
			return { ok: true, delivered: "message", triggerTurn: task.triggerTurn !== false, wakeReason: "message", wakeDisposition: task.triggerTurn !== false ? "delivered" : "not-requested" };
		}

		if (task.action === "shell") {
			const cwd = task.cwd || ctx.cwd;
			const timeout = task.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			if (ctx.hasUI) ctx.ui.notify(`Running scheduled command: ${task.command}`, "info");

			const result = await pi.exec("bash", ["-lc", task.command], { cwd, timeout });
			const wakeOnChangeFingerprint = core.shellResultFingerprint({
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.code,
				killed: result.killed,
			});
			const shellResult: Record<string, any> = {
				ok: result.code === 0 && result.killed !== true,
				command: task.command,
				cwd,
				timeoutMs: timeout,
				code: result.code,
				killed: result.killed,
				wakeOnChangeFingerprint,
				stdout: truncateMiddle(result.stdout ?? "", MAX_STORED_OUTPUT_CHARS),
				stderr: truncateMiddle(result.stderr ?? "", MAX_STORED_OUTPUT_CHARS),
			};

			if (!isActive()) return { ...shellResult, outputSuppressed: true, wakeReason: task.wakeOn ?? "never", wakeDisposition: "session-suppressed" };

			recordMessage(
				`🖥️ Scheduled command ${task.id} finished with exit code ${result.code}: ${task.command}`,
				{ task, result: shellResult },
				false,
			);

			shellResult.wakeReason = task.wakeOn ?? "never";
			shellResult.wakeDisposition = "suppressed";
			if (task.wakeOn !== "change" && core.shouldWakeForShellResult(task, shellResult)) {
				const instruction = core.selectShellFollowUpPrompt(task, shellResult);
				if (instruction) {
					try {
						sendAgentPrompt(pi, ctx, shellResultPrompt(task, shellResult, instruction));
						shellResult.wakeDisposition = "delivered";
					} catch (error: any) {
						shellResult.wakeDisposition = "failed";
						shellResult.wakeError = String(error?.message ?? error).slice(0, 1000);
					}
				} else shellResult.wakeDisposition = "no-followup";
			}

			return shellResult;
		}

		throw new Error(`Unsupported scheduled action: ${task.action}`);
	}

	async function fireTask(
		taskId: string,
		ctx: ExtensionContext,
		generation = sessionGeneration,
		claimOptions?: { expectedNextRun?: string; occurrence?: string },
	): Promise<void> {
		if (!isSessionActive(ctx, generation) || firing.has(taskId)) return;

		firing.add(taskId);
		const attemptId = randomUUID();
		let task: ScheduledTask | undefined;
		try {
			// Claim under the shared state lock. Other Pi processes may have armed the
			// same cwd/global task, but only one can transition it to running.
			task = await transactTasks((current) => {
				const candidate = current.find((item) => item.id === taskId);
				if (!candidate || candidate.enabled === false || candidate.status !== "pending") return undefined;
				if (!taskBelongsToSession(candidate, ctx)) return undefined;
				const persistedNextRun = candidate.nextRun ?? candidate.dueAt;
				if (claimOptions?.expectedNextRun && persistedNextRun !== claimOptions.expectedNextRun) return undefined;
				const dueAt = Date.parse(claimOptions?.occurrence ?? persistedNextRun ?? "");
				if (!Number.isFinite(dueAt) || dueAt > Date.now()) return undefined;
				const claimedAt = new Date();
				if (!core.canClaimTask(candidate, claimedAt)) {
					core.expireOverdueTasks([candidate], claimedAt);
					return undefined;
				}
				if (claimOptions?.occurrence) {
					candidate.nextRun = claimOptions.occurrence;
					candidate.dueAt = claimOptions.occurrence;
				}
				core.markScheduledTaskRunning(current, candidate.id, claimedAt, {
					runOwner: { pid: process.pid, attemptId, sessionFile: currentSessionFile(ctx) },
				});
				return { ...candidate, runOwner: { ...candidate.runOwner } };
			});
			if (!task) return;

			if (!isSessionActive(ctx, generation)) {
				await transactTasks((current) => {
					const persisted = current.find((candidate) => candidate.id === taskId);
					if (persisted?.runOwner?.attemptId !== attemptId) return;
					persisted.status = "pending";
					persisted.lastStatus = "error";
					persisted.lastError = "Scheduled task start was cancelled because the Pi session changed";
					delete persisted.runOwner;
					delete persisted.startedAt;
				});
				return;
			}

			updateStatus(ctx);
			const result = await executeTask(task, ctx, () => isSessionActive(ctx, generation));
			result.attemptId = attemptId;
			let wakeOnChange = false;
			let wakeTask: ScheduledTask | undefined;
			await transactTasks((current) => {
				const persisted = current.find((candidate) => candidate.id === taskId);
				if (persisted?.runOwner?.attemptId !== attemptId) return;
				// A command/cwd or wake-policy edit while the process was running owns
				// the new state; never let this stale result restore its baseline.
				if (task?.wakeOn === "change" && result.wakeOnChangeFingerprint
					&& persisted.enabled !== false && persisted.status === "running"
					&& persisted.action === "shell"
					&& persisted.wakeOn === "change"
					&& persisted.wakeOnChangeRevision === task.wakeOnChangeRevision
					&& persisted.command === task.command
					&& (persisted.cwd ?? ctx.cwd) === (task.cwd ?? ctx.cwd)) {
					wakeOnChange = core.shouldWakeForShellResult(persisted, result);
					result.wakeDisposition = wakeOnChange ? "pending" : "suppressed";
					persisted.lastResultFingerprint = result.wakeOnChangeFingerprint;
					persisted.wakeOnChangeKey = `${task.command ?? ""}\0${task.cwd ?? ctx.cwd}`;
					if (wakeOnChange) wakeTask = { ...persisted };
				}
				core.markScheduledTaskCompleted(current, persisted.id, new Date(), result, { ok: result.ok !== false });
			});
			if (wakeOnChange && wakeTask) {
				result.wakeDisposition = "session-suppressed";
				if (isSessionActive(ctx, generation)) {
					const instruction = core.selectShellFollowUpPrompt(wakeTask, result);
					result.wakeDisposition = "no-followup";
					if (instruction) {
						try {
							sendAgentPrompt(pi, ctx, shellResultPrompt(wakeTask, result, instruction));
							result.wakeDisposition = "delivered";
						} catch (error: any) {
							result.wakeDisposition = "failed";
							result.wakeError = String(error?.message ?? error).slice(0, 1000);
						}
					}
				}
				await transactTasks((current) => {
					const persisted = current.find((candidate) => candidate.id === taskId);
					const historyEntry = persisted?.history?.find((entry: any) => entry.attemptId === attemptId);
					if (historyEntry) {
						historyEntry.wakeDisposition = result.wakeDisposition;
						if (result.wakeError) historyEntry.wakeError = result.wakeError;
					}
					if (persisted?.result?.attemptId === attemptId) {
						persisted.result.wakeDisposition = result.wakeDisposition;
						if (result.wakeError) persisted.result.wakeError = result.wakeError;
					}
				});
			}
		} catch (error: any) {
			let failedTask: ScheduledTask | undefined;
			await transactTasks((current) => {
				const persisted = current.find((candidate) => candidate.id === taskId);
				if (persisted?.runOwner?.attemptId !== attemptId) return;
				core.markScheduledTaskFailed(current, persisted.id, new Date(), error);
				failedTask = { ...persisted };
			});
			if (failedTask && isSessionActive(ctx, generation)) {
				const message = `Scheduled task ${taskId} failed: ${error?.message ?? String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				recordMessage(`⚠️ ${message}`, { task: failedTask, error: error?.message ?? String(error) }, false);
			}
		} finally {
			firing.delete(taskId);
			if (activeCtx) rescheduleAll(sessionGeneration);
		}
	}

	async function createAndSchedule(input: Record<string, any>, ctx: ExtensionContext): Promise<ScheduledTask> {
		const scope = input.scope ?? "session";
		const sessionFile = scope === "session" ? currentSessionFile(ctx) : undefined;
		if (scope === "session" && !sessionFile) {
			throw new Error("Session-scoped tasks require a persisted Pi session; use scope 'cwd' or 'global' instead");
		}
		const task = await transactTasks((current) => {
			const created = core.createScheduledTask(
				{
					...input,
					schedule: input.schedule ?? input.when ?? input.whenText,
					cwd: input.cwd ?? ctx.cwd,
					scope,
					sessionFile,
				},
				new Date(),
			);
			current.push(created);
			return created;
		});
		rescheduleAll();
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

	function cleanupVisibleTasks(current: ScheduledTask[], ctx: ExtensionContext): ScheduledTask[] {
		const removable = current
			.filter((task) => taskBelongsToSession(task, ctx))
			.filter((task) => task.enabled === false || ["fired", "cancelled", "failed"].includes(task.status));
		const removableIds = new Set(removable.map((task) => task.id));
		current.splice(0, current.length, ...current.filter((task) => !removableIds.has(task.id)));
		for (const task of removable) clearHandle(task.id);
		return removable;
	}

	async function mutateVisibleTask(
		ctx: ExtensionContext,
		id: string,
		mutator: (visible: ScheduledTask[]) => ScheduledTask,
	): Promise<ScheduledTask> {
		const task = await transactTasks((current) => {
			const visible = current.filter((candidate) => taskBelongsToSession(candidate, ctx));
			return mutator(visible);
		});
		rescheduleAll();
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
		const generation = ++sessionGeneration;
		const interrupted = await transactTasks((current) => {
			core.expireOverdueTasks(current, new Date());
			return core.recoverInterruptedTasks(current, new Date(), { isOwnerActive: isRunOwnerActive });
		});
		if (!isSessionActive(ctx, generation)) return;

		if (interrupted.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`Recovered ${interrupted.length} task(s) interrupted before completion; recurring tasks were rescheduled`,
				"warning",
			);
		}

		rescheduleAll(generation);
		startStateRefresh(generation);
		const catchUpOptions = core.parseCatchUpOptions(process.env);
		void catchUpOverdueCronTasks(ctx, generation, catchUpOptions).catch((error: any) => {
			if (isSessionActive(ctx, generation) && ctx.hasUI) {
				ctx.ui.notify(`Failed to catch up missed cron tasks: ${error?.message ?? String(error)}`, "error");
			}
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		++sessionGeneration;
		clearTimers();
		refreshLoop.stop();
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
		description: "List scheduled tasks; pass 'all' to include inactive tasks or 'history' for run history",
		handler: async (args, ctx) => {
			await loadTasks();
			const view = args.trim().toLowerCase();
			const includeAll = view === "all" || view === "history";
			const includeHistory = view === "history";
			const visible = visibleTasks(ctx);
			recordMessage(core.formatTaskList(visible, new Date(), { includeAll, includeHistory }), { includeAll, includeHistory, tasks: visible }, false);
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
				const removed = await transactTasks((current) => {
					const visible = current.filter((task) => taskBelongsToSession(task, ctx));
					const visibleRemoved = core.removeScheduledTask(visible, id);
					return core.removeScheduledTask(current, visibleRemoved.id);
				});
				clearHandle(removed.id);
				rescheduleAll();
				ctx.ui.notify(`Removed scheduled task ${removed.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-cleanup", {
		description: "Remove disabled/completed/cancelled/failed scheduled tasks visible to this session",
		handler: async (_args, ctx) => {
			const removed = await transactTasks((current) => cleanupVisibleTasks(current, ctx));
			rescheduleAll();
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
			backoff: Type.Optional(Type.Object({ factor: Type.Number({ description: "Multiplicative interval factor greater than 1." }), maxInterval: Type.String({ description: "Maximum interval, e.g. '15m'." }) })),
			expiresIn: Type.Optional(Type.String({ description: "Optional positive duration after which this task expires (for example, '2h')." })),
			message: Type.Optional(Type.String({ description: "Message for notify/message actions." })),
			prompt: Type.Optional(Type.String({ description: "User prompt to inject for prompt actions." })),
			command: Type.Optional(Type.String({ description: "Shell command to run for shell actions." })),
			payload: Type.Optional(Type.String({ description: "Generic payload fallback for any action." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for shell actions; defaults to current cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Shell timeout in milliseconds.", minimum: 1000 })),
			wakeOn: Type.Optional(StringEnum(WAKE_ON, { description: "For shell actions: when to wake the agent. 'change' wakes after the first run only when stdout, stderr, exit status, or killed state changes. Default always if a prompt is configured, otherwise never." })),
			stopOn: Type.Optional(StringEnum(STOP_ON, { description: "For shell actions: disable a recurring task after a matching result. Default never." })),
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
			includeHistory: Type.Optional(Type.Boolean({ description: "Include compact per-run history. Default false." })),
			id: Type.Optional(Type.String({ description: "Show history for one task id or prefix." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await loadTasks();
			let visible = visibleTasks(ctx);
			if (params.id) {
				const matches = visible.filter((task) => task.id === params.id || task.id.startsWith(params.id));
				if (matches.length !== 1) throw new Error(`Scheduled task not found or prefix is ambiguous: ${params.id}`);
				visible = matches;
			}
			const text = core.formatTaskList(visible, new Date(), { includeAll: Boolean(params.includeAll || params.id || params.includeHistory), includeHistory: Boolean(params.includeHistory) });
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
			backoff: Type.Optional(Type.Union([Type.Object({ factor: Type.Number(), maxInterval: Type.String() }), Type.Null()])),
			expiresIn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			prompt: Type.Optional(Type.String()),
			message: Type.Optional(Type.String()),
			command: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1000 })),
			wakeOn: Type.Optional(StringEnum(WAKE_ON)),
			stopOn: Type.Optional(StringEnum(STOP_ON)),
			followUpPrompt: Type.Optional(Type.String()),
			successPrompt: Type.Optional(Type.String()),
			failurePrompt: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "cleanup") {
				const removed = await transactTasks((current) => cleanupVisibleTasks(current, ctx));
				rescheduleAll();
				return { content: [{ type: "text", text: `Cleaned up ${removed.length} scheduled task(s).` }], details: { removed } };
			}

			if (!params.id) throw new Error("id is required for this management action");
			const task = await transactTasks((current) => {
				const visible = current.filter((candidate) => taskBelongsToSession(candidate, ctx));
				if (params.action === "enable") {
					return core.enableScheduledTask(visible, params.id, new Date());
				}
				if (params.action === "disable") {
					return core.disableScheduledTask(visible, params.id, new Date());
				}
				if (params.action === "remove") {
					const visibleRemoved = core.removeScheduledTask(visible, params.id);
					return core.removeScheduledTask(current, visibleRemoved.id);
				}

				const updates: Record<string, any> = { ...params };
				delete updates.action;
				delete updates.id;
				if (updates.scope === "session") {
					updates.sessionFile = currentSessionFile(ctx);
					if (!updates.sessionFile) throw new Error("Session-scoped tasks require a persisted Pi session");
				} else if (updates.scope !== undefined) {
					updates.sessionFile = null;
				}
				return core.updateScheduledTask(visible, params.id, updates, new Date());
			});
			if (params.action === "remove") clearHandle(task.id);
			rescheduleAll();
			return {
				content: [{ type: "text", text: `${params.action} scheduled task ${task.id}` }],
				details: { task, pending: core.pendingTasks(tasks) },
			};
		},
	});
}
