const test = require("node:test");
const assert = require("node:assert/strict");
const {
	createScheduledTask,
	updateScheduledTask,
	shouldWakeForShellResult,
	shellResultFingerprint,
	sanitizeTasks,
} = require("../extensions/scheduler/scheduler-core.cjs");
const { harness, until } = require("./helpers/runtime-harness.cjs");

test("change policy establishes a baseline and suppresses repeated failures", () => {
	const task = createScheduledTask({ action: "shell", schedule: "5m", command: "status", cwd: "/tmp", wakeOn: "change" }, new Date("2026-07-05T12:00:00Z"));
	const first = { code: 1, killed: false, stdout: "bad", stderr: "warn" };
	assert.equal(shouldWakeForShellResult(task, first), false);
	task.lastResultFingerprint = shellResultFingerprint(first);
	task.wakeOnChangeKey = "status\0/tmp";
	assert.equal(shouldWakeForShellResult(task, first), false);
	assert.equal(shouldWakeForShellResult(task, { ...first, stderr: "changed" }), true);
});

test("sanitize ignores malformed persisted change fingerprints", () => {
	const [task] = sanitizeTasks([{
		id: "legacy-change", action: "shell", type: "interval", schedule: "5m",
		command: "status", wakeOn: "change", lastResultFingerprint: { bad: true },
	}]);
	assert.equal(task.lastResultFingerprint, undefined);
});

test("fingerprint includes raw output, exit status, and killed state", () => {
	const base = { stdout: "same", stderr: "", code: 0, killed: false };
	assert.notEqual(shellResultFingerprint(base), shellResultFingerprint({ ...base, code: 1 }));
	assert.notEqual(shellResultFingerprint(base), shellResultFingerprint({ ...base, killed: true }));
	assert.notEqual(shellResultFingerprint(base), shellResultFingerprint({ ...base, stderr: "x" }));
});

test("command, cwd, and opting into change reset the baseline", () => {
	const task = createScheduledTask({ action: "shell", schedule: "5m", command: "one", cwd: "/tmp", wakeOn: "change" }, new Date("2026-07-05T12:00:00Z"));
	task.lastResultFingerprint = "old";
	updateScheduledTask([task], task.id, { command: "two" });
	assert.equal(task.lastResultFingerprint, undefined);
	task.lastResultFingerprint = "old";
	updateScheduledTask([task], task.id, { cwd: "/other" });
	assert.equal(task.lastResultFingerprint, undefined);
	task.wakeOn = "failure";
	task.lastResultFingerprint = "old";
	updateScheduledTask([task], task.id, { wakeOn: "change" });
	assert.equal(task.lastResultFingerprint, undefined);
});

test("runtime persists full-result fingerprint and wakes on a changed second run", async () => {
	let calls = 0;
	const runtime = await harness(__dirname + "/..", async () => ({
		code: 1,
		killed: false,
		stdout: calls++ === 0 ? "failure-a" : "failure-b",
		stderr: "",
	}));
	try {
		await runtime.start();
		await runtime.call("schedule_task", {
			action: "shell", type: "interval", schedule: "1s", command: "check",
			wakeOn: "change", followUpPrompt: "Investigate changed status.", maxRuns: 2,
		});
		await until(async () => (await runtime.tasks())[0]?.runCount >= 2, "two shell runs");
		assert.equal(runtime.wakes.length, 1);
		assert.match(runtime.wakes[0].text, /Investigate changed status/);
	} finally {
		await runtime.close();
	}
});

test('resetting change policy while running does not restore an old baseline', async () => {
	let release;
	const runtime = await harness(__dirname + '/..', () => new Promise(resolve => { release = resolve; }));
	try {
		await runtime.start();
		const result = await runtime.call('schedule_task', {action:'shell', type:'interval', schedule:'0.02s', command:'check', wakeOn:'change'});
		const id = result.details.task.id;
		await until(() => release, 'command running');
		await runtime.call('manage_scheduled_task', {action:'update', id, wakeOn:'never'});
		await runtime.call('manage_scheduled_task', {action:'update', id, wakeOn:'change', schedule:'1h'});
		release({code:0, stdout:'old', stderr:'', killed:false});
		await until(async () => (await runtime.tasks())[0].runCount === 1, 'completion');
		assert.equal((await runtime.tasks())[0].lastResultFingerprint, undefined);
		assert.equal(runtime.wakes.length, 0);
	} finally {await runtime.close();}
});

test('cancelled change task never wakes on its in-flight result', async () => {
	let calls = 0, release;
	const runtime = await harness(__dirname + '/..', () => ++calls === 1
		? Promise.resolve({code:0, stdout:'baseline', stderr:'', killed:false})
		: new Promise(resolve => {release = resolve;}));
	try {
		await runtime.start();
		const result = await runtime.call('schedule_task', {action:'shell', type:'interval', schedule:'0.02s', command:'check', wakeOn:'change'});
		await until(() => release, 'second command');
		await runtime.call('cancel_scheduled_task', {id:result.details.task.id});
		release({code:0, stdout:'changed', stderr:'', killed:false});
		await until(async () => !(await runtime.tasks())[0].runOwner, 'cancelled completion');
		assert.equal(runtime.wakes.length, 0);
	} finally {await runtime.close();}
});

test('restart preserves baseline and detects changes hidden by output truncation', async () => {
	let calls = 0;
	const runtime = await harness(__dirname + '/..', async () => ({code:1, killed:false, stderr:'',
		stdout: 'a'.repeat(13000) + (++calls < 3 ? 'old' : 'new') + 'z'.repeat(13000)}));
	try {
		await runtime.start();
		await runtime.call('schedule_task', {action:'shell', type:'interval', schedule:'0.1s', command:'check', wakeOn:'change', maxRuns:3});
		await until(async () => (await runtime.tasks())[0]?.runCount === 2, 'repeated same failure');
		assert.equal(runtime.wakes.length, 0);
		const before = (await runtime.tasks())[0];
		await runtime.events.session_shutdown({}, runtime.context);
		await runtime.start();
		await until(async () => (await runtime.tasks())[0]?.runCount === 3, 'changed result after restart');
		const after = (await runtime.tasks())[0];
		assert.equal(after.result.stdout, before.result.stdout, 'stored output truncates the changed middle');
		assert.notEqual(after.lastResultFingerprint, before.lastResultFingerprint);
		assert.equal(runtime.wakes.length, 1);
	} finally {await runtime.close();}
});
