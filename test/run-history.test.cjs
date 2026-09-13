const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extensions/scheduler/scheduler-core.cjs");
const { harness, until } = require("./helpers/runtime-harness.cjs");

const NOW = new Date("2026-07-05T12:00:00Z");

test("completed runs append bounded compact history with attempt and outcome metadata", () => {
	const task = core.createScheduledTask({ action: "shell", type: "interval", schedule: "5m", command: "check" }, NOW, () => "history");
	const tasks = [task];
	for (let i = 0; i < 12; i++) {
		const started = new Date(NOW.getTime() + i * 1000);
		core.markScheduledTaskRunning(tasks, task.id, started, { runOwner: { attemptId: `attempt-${i}` } });
		core.markScheduledTaskCompleted(tasks, task.id, new Date(started.getTime() + 250), { ok: i % 2 === 0, code: i % 2 === 0 ? 0 : 2, killed: false }, { ok: i % 2 === 0, wakeReason: "policy", wakeDisposition: "suppressed" });
	}
	assert.equal(task.history.length, 10);
	assert.equal(task.history[0].attemptId, "attempt-2");
	assert.equal(task.history.at(-1).durationMs, 250);
	assert.equal(task.history.at(-1).outcome.status, "error");
	assert.equal(task.history.at(-1).outcome.exitCode, 2);
	assert.equal(task.history.at(-1).wakeDisposition, "suppressed");
	assert.equal(task.history.at(-1).result, undefined);
});

test("failed and interrupted runs are recorded once and malformed history is sanitized", () => {
	const task = core.createScheduledTask({ action: "shell", type: "interval", schedule: "5m", command: "check" }, NOW, () => "failed");
	const tasks = [task];
	core.markScheduledTaskRunning(tasks, task.id, NOW, { runOwner: { attemptId: "boom" } });
	core.markScheduledTaskFailed(tasks, task.id, new Date(NOW.getTime() + 100), new Error("boom"));
	assert.equal(task.history.length, 1);
	assert.equal(task.history[0].outcome.status, "error");
	assert.equal(task.history[0].outcome.error, "boom");
	const [clean] = core.sanitizeTasks([{ ...task, history: [...task.history, null, { bad: true }, { attemptId: "x", startedAt: "bad" }] }]);
	assert.equal(clean.history.length, 1);
});

test("extension runtime records shell wake disposition and exposes history", async () => {
	let calls = 0;
	const runtime = await harness(__dirname + "/..", async () => ({ code: calls++ ? 1 : 0, killed: false, stdout: "ok", stderr: "" }));
	try {
		await runtime.start();
		const created = await runtime.call("schedule_task", { action: "shell", type: "interval", schedule: "1s", command: "check", wakeOn: "failure", followUpPrompt: "review", maxRuns: 2 });
		await until(async () => {
			const task = (await runtime.tasks())[0];
			return task?.runCount >= 2 && task.history?.[1]?.wakeDisposition === "delivered";
		}, "two runtime runs and persisted wake delivery");
		const task = (await runtime.tasks())[0];
		assert.equal(task.history.length, 2);
		assert.equal(task.history[0].outcome.status, "success");
		assert.equal(task.history[1].outcome.status, "error");
		assert.equal(task.history[0].wakeDisposition, "suppressed");
		assert.equal(task.history[1].wakeDisposition, "delivered");
		const listed = await runtime.call("list_scheduled_tasks", { includeAll: true, includeHistory: true, id: task.id });
		assert.match(listed.content[0].text, /attempt|wake=delivered/);
	} finally { await runtime.close(); }
});

test('cancelled failed attempts retain a single history row and clear attempt metadata', () => {
	const task=core.createScheduledTask({action:'shell',type:'interval',schedule:'1m',command:'check'},NOW,()=> 'cancel');
	core.markScheduledTaskRunning([task],task.id,NOW,{runOwner:{attemptId:'cancelled-run'}});
	core.cancelScheduledTask([task],task.id,NOW);
	core.markScheduledTaskFailed([task],task.id,NOW,new Error('execution failed'));
	assert.equal(task.history?.length,1);
	assert.equal(task.history[0].outcome.status,'cancelled');
	assert.equal(task.runAttemptId,undefined);
	core.markScheduledTaskFailed([task],task.id,NOW,new Error('duplicate callback'));
	assert.equal(task.history.length,1);
});

test('sanitized history cannot retain output blobs or invalid outcomes', () => {
	const task=core.createScheduledTask({action:'shell',type:'interval',schedule:'1m',command:'check'},NOW,()=> 'sanitize');
	const entry={attemptId:'run',startedAt:NOW.toISOString(),completedAt:NOW.toISOString(),durationMs:0,
		outcome:{status:'error',error:'x'.repeat(10000),stdout:'large'},stdout:'large',wakeDisposition:'invalid'};
	const [saved]=core.sanitizeTasks([{...task,history:[entry,{...entry,attemptId:'invalid',outcome:{status:'invented'}}]}],NOW);
	assert.equal(saved.history.length,1);
	assert.equal(saved.history[0].stdout,undefined);
	assert.equal(saved.history[0].outcome.stdout,undefined);
	assert.ok(saved.history[0].outcome.error.length<=1000);
	assert.equal(saved.history[0].wakeDisposition,undefined);
});

test('legacy interrupted attempt with owner metadata is recorded', () => {
	const task=core.createScheduledTask({action:'shell',type:'interval',schedule:'1m',command:'check'},NOW,()=> 'legacy');
	task.status='running'; task.startedAt=NOW.toISOString(); task.runOwner={pid:99999,attemptId:'old'};
	core.recoverInterruptedTasks([task],new Date(NOW.getTime()+50),{isOwnerActive:()=>false});
	assert.equal(task.history?.[0].outcome.status,'interrupted');
	assert.equal(task.history[0].attemptId,'old');
});

test('/schedules history includes completed tasks', async () => {
	const h=await harness(__dirname+'/..',async()=>({code:0,stdout:'',stderr:''}));
	try {
		await h.start();
		const result=await h.call('schedule_task',{action:'shell',type:'once',schedule:'0.02s',command:'check'});
		await until(async()=> (await h.tasks())[0]?.runCount===1,'completed once');
		await h.commands.schedules.handler('history',h.context);
		assert.match(h.messages.at(-1).message.content,/success/);
		const listed=await h.call('list_scheduled_tasks',{id:result.details.task.id,includeHistory:true});
		assert.match(listed.content[0].text,/success/);
	} finally {await h.close();}
});

test('wake delivery failure is recorded without turning shell success into command failure', async () => {
	const h=await harness(__dirname+'/..',async()=>({code:0,stdout:'ok',stderr:''}));
	h.wakes.push=()=>{throw new Error('wake enqueue failed');};
	try {
		await h.start();
		await h.call('schedule_task',{action:'shell',type:'once',schedule:'0.02s',command:'check',wakeOn:'always'});
		await until(async()=> (await h.tasks())[0]?.history?.length===1,'history after wake failure');
		const [task]=await h.tasks();
		assert.equal(task.history[0].outcome.status,'success');
		assert.equal(task.history[0].wakeDisposition,'failed');
		assert.equal(task.history[0].wakeError,'wake enqueue failed');
		assert.equal(task.runCount,1);
	} finally {await h.close();}
});

test('thrown shell execution is recorded exactly once', async () => {
	const h=await harness(__dirname+'/..',async()=>{throw new Error('cannot execute');});
	try {
		await h.start();
		await h.call('schedule_task',{action:'shell',type:'once',schedule:'0.02s',command:'check'});
		await until(async()=> (await h.tasks())[0]?.history?.length===1,'history after execution failure');
		const [task]=await h.tasks();
		assert.equal(task.history[0].outcome.status,'error');
		assert.match(task.history[0].outcome.error,/cannot execute/);
		assert.equal(task.history[0].wakeDisposition,'not-requested');
		assert.equal(task.runCount,1);
	} finally {await h.close();}
});
