const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extensions/scheduler/scheduler-core.cjs");

const NOW = new Date("2026-07-05T12:00:00.000Z");
const min = (n) => n * 60 * 1000;

test("interval backoff validates and persists its base/effective interval", () => {
	const task = core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "poll", backoff: { factor: 2, maxInterval: "15m" } }, NOW, () => "b");
	assert.deepEqual(task.backoff, { factor: 2, maxIntervalMs: min(15), currentIntervalMs: min(5) });
	assert.throws(() => core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "x", backoff: { factor: 1, maxInterval: "15m" } }, NOW), /factor/);
	assert.throws(() => core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "x", backoff: { factor: 2, maxInterval: "4m" } }, NOW), /maxInterval/);
	assert.throws(() => core.createScheduledTask({ action: "notify", type: "once", schedule: "5m", message: "x", backoff: { factor: 2, maxInterval: "15m" } }, NOW), /interval/);
	for (const factor of [NaN, Infinity, 1, 0, -2]) {
		assert.throws(() => core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "x", backoff: { factor, maxInterval: "15m" } }, NOW), /factor/);
	}
	assert.throws(() => core.createScheduledTask({ action: "notify", type: "cron", schedule: "0 * * * * *", message: "x", backoff: { factor: 2, maxInterval: "15m" } }, NOW), /interval/);
	assert.throws(() => core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "x", backoff: { factor: 2, maxInterval: Number.MAX_SAFE_INTEGER } }, NOW), /date range/);
});

test("backoff increases after each execution and caps at maxInterval", () => {
	const tasks = [core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "poll", backoff: { factor: 2, maxInterval: "15m" } }, NOW, () => "b")];
	core.markScheduledTaskRunning(tasks, "b", NOW);
	let task = core.markScheduledTaskCompleted(tasks, "b", NOW, { ok: true });
	assert.equal(Date.parse(task.nextRun), NOW.getTime() + min(10));
	assert.equal(task.backoff.currentIntervalMs, min(10));
	core.markScheduledTaskRunning(tasks, "b", new Date(NOW.getTime() + min(10)));
	task = core.markScheduledTaskCompleted(tasks, "b", new Date(NOW.getTime() + min(10)), { ok: true });
	assert.equal(task.backoff.currentIntervalMs, min(15));
	assert.equal(Date.parse(task.nextRun), NOW.getTime() + min(25));
});

test("sanitize preserves effective backoff progression and updates reset it", () => {
	const original = core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "poll", backoff: { factor: 2, maxInterval: "15m" } }, NOW, () => "b");
	original.backoff.currentIntervalMs = min(10);
	original.nextRun = new Date(NOW.getTime() + min(10)).toISOString();
	const [loaded] = core.sanitizeTasks([original], NOW);
	assert.equal(loaded.backoff.currentIntervalMs, min(10));
	const updated = core.updateScheduledTask([loaded], "b", { backoff: null }, NOW);
	assert.equal(updated.backoff, undefined);
	assert.equal(updated.intervalMs, min(5));
	core.updateScheduledTask([updated], "b", { backoff: { factor: 3, maxInterval: "20m" } }, NOW);
	assert.equal(updated.backoff.currentIntervalMs, min(5));
	core.enableScheduledTask([updated], "b", NOW);
	assert.equal(updated.backoff.currentIntervalMs, min(5));
});

test("schedule and backoff changes reset progression, while clearing in-flight config stays cleared", () => {
	const tasks = [core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "poll", backoff: { factor: 2, maxInterval: "15m" } }, NOW, () => "b")];
	tasks[0].backoff.currentIntervalMs = min(10);
	core.updateScheduledTask(tasks, "b", { schedule: "10m" }, NOW);
	assert.equal(tasks[0].backoff.currentIntervalMs, min(10));
	core.updateScheduledTask(tasks, "b", { backoff: { factor: 3, maxInterval: "30m" } }, NOW);
	assert.equal(tasks[0].backoff.currentIntervalMs, min(10));
	core.markScheduledTaskRunning(tasks, "b", NOW);
	core.updateScheduledTask(tasks, "b", { backoff: null }, NOW);
	core.markScheduledTaskCompleted(tasks, "b", NOW, { ok: true });
	assert.equal(tasks[0].backoff, undefined);
	assert.equal(Date.parse(tasks[0].nextRun), NOW.getTime() + min(10));
});

test("explicit enable resets progression and disabled or cancelled in-flight runs do not rearm", () => {
	const disabledTasks = [core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "poll", backoff: { factor: 2, maxInterval: "15m" } }, NOW, () => "disabled")];
	disabledTasks[0].backoff.currentIntervalMs = min(10);
	core.markScheduledTaskRunning(disabledTasks, "disabled", NOW);
	core.disableScheduledTask(disabledTasks, "disabled", NOW);
	core.markScheduledTaskCompleted(disabledTasks, "disabled", NOW, { ok: true });
	assert.equal(disabledTasks[0].nextRun, undefined);
	core.enableScheduledTask(disabledTasks, "disabled", NOW);
	assert.equal(disabledTasks[0].backoff.currentIntervalMs, min(5));

	const cancelledTasks = [core.createScheduledTask({ action: "notify", type: "interval", schedule: "5m", message: "poll", backoff: { factor: 2, maxInterval: "15m" } }, NOW, () => "cancelled")];
	core.markScheduledTaskRunning(cancelledTasks, "cancelled", NOW);
	core.cancelScheduledTask(cancelledTasks, "cancelled", NOW);
	core.markScheduledTaskCompleted(cancelledTasks, "cancelled", NOW, { ok: true });
	assert.equal(cancelledTasks[0].status, "cancelled");
	assert.equal(cancelledTasks[0].nextRun, undefined);
});

test('schedule and backoff update validate against the new base and reset next delay', () => {
	const make = () => core.createScheduledTask({action:'shell',type:'interval',schedule:'5m',command:'check',backoff:{factor:2,maxInterval:'15m'}},NOW,()=> 'update');
	const increasing = make();
	core.updateScheduledTask([increasing],increasing.id,{schedule:'10m'},NOW);
	assert.equal(increasing.backoff.currentIntervalMs,min(10));
	const decreasing=make();
	core.updateScheduledTask([decreasing],decreasing.id,{schedule:'1m',backoff:{factor:3,maxInterval:'2m'}},NOW);
	assert.equal(decreasing.backoff.currentIntervalMs,min(1));
	assert.equal(decreasing.backoff.maxIntervalMs,min(2));
	core.markScheduledTaskCompleted([decreasing],decreasing.id,NOW,{ok:true});
	core.updateScheduledTask([decreasing],decreasing.id,{backoff:null},NOW);
	assert.equal(Date.parse(decreasing.nextRun)-NOW.getTime(),min(1));
});

test('changing to cron requires removing backoff explicitly', () => {
	const task=core.createScheduledTask({action:'shell',type:'interval',schedule:'1m',command:'check',backoff:{factor:2,maxInterval:'5m'}},NOW,()=> 'change');
	assert.throws(()=>core.updateScheduledTask([task],task.id,{type:'cron',schedule:'0 * * * * *'},NOW),/interval/);
	assert.equal(task.type,'interval');
	core.updateScheduledTask([task],task.id,{type:'cron',schedule:'0 * * * * *',backoff:null},NOW);
	assert.equal(task.backoff,undefined);
});
