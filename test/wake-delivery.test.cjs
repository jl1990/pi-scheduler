const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, controlledTimers } = require("./helpers/runtime-harness.cjs");

for (const action of ["shell", "prompt"]) {
	for (const idle of [true, false]) {
		test(`scheduled ${action} uses a visible custom follow-up while ${idle ? "idle" : "busy"}`, async () => {
			const timers = controlledTimers();
			const runtime = await harness(__dirname + "/..", async () => ({ code: 0, stdout: "test output", stderr: "" }), timers.sandbox);
			runtime.context.isIdle = () => idle;
			try {
				await runtime.start();
				await runtime.call("schedule_task", {
					action, schedule: "0.02s",
					...(action === "shell"
						? { command: "check", wakeOn: "always", followUpPrompt: "Inspect the output" }
						: { prompt: "Inspect the output" }),
				});
				await timers.runNext(runtime);
				const triggered = runtime.messages.filter(({ options }) => options.triggerTurn);
				assert.equal(triggered.length, 1);
				assert.equal(runtime.userMessages.length, 0, "scheduler wakes are not user input on a patched Pi");
				assert.equal(triggered[0].message.customType, "scheduled-task");
				assert.equal(triggered[0].message.display, true);
				assert.equal(triggered[0].options.deliverAs, "followUp");
				assert.match(triggered[0].message.content, /Inspect the output/);
				if (action === "shell") assert.match(triggered[0].message.content, /test output/);
			} finally {
				await runtime.close();
			}
		});
	}
}

test("an older Pi keeps the existing wake delivery rather than silently dropping results on Alt+Up", async () => {
	const timers = controlledTimers();
	const runtime = await harness(__dirname + "/..", async () => ({ code: 0, stdout: "legacy output", stderr: "" }), {
		...timers.sandbox,
		AgentSession: class {},
	});
	runtime.context.isIdle = () => false;
	try {
		await runtime.start();
		await runtime.call("schedule_task", { action: "shell", command: "check", schedule: "0.02s", wakeOn: "always" });
		await timers.runNext(runtime);
		assert.equal(runtime.userMessages.length, 1);
		assert.equal(runtime.userMessages[0].options.deliverAs, "followUp");
		assert.match(runtime.userMessages[0].text, /legacy output/);
		assert.equal(runtime.messages.some(({ options }) => options.triggerTurn), false);
	} finally {
		await runtime.close();
	}
});