"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const { rm } = require("node:fs/promises");

const ROOT = resolve(__dirname, "..");

for (const scenario of ["timeout", "cron", "invalid-cron", "throwing-reporter", "expiry", "completion"]) {
	test(`background ${scenario} failure cannot escape into the host process`, async (t) => {
		const script = `
			const assert = require('node:assert/strict');
			const path = require('node:path');
			const { createRequire } = require('node:module');
			const { harness, until } = require('./test/helpers/runtime-harness.cjs');
			const realRequire = createRequire(path.resolve('extensions/scheduler/index.ts'));
			const scenario = process.argv[1];
			let failWrites = false;
			let failedWrites = 0;
			let timerCallback, cronCallback, refreshCallback;
			let timerRegistrations = 0;
			let executions = 0;
			const notices = [];
			const overrides = {
				require: id => {
					const module = realRequire(id);
					if (id !== './task-store.cjs') return module;
					return { createTaskStore: options => {
						const store = module.createTaskStore(options);
						return { ...store, transact: async mutator => {
							if (failWrites) { failedWrites++; throw new Error('store unavailable'); }
							return store.transact(mutator);
						} };
					} };
				},
				setTimeout: callback => { timerRegistrations++; timerCallback = callback; return {}; },
				clearTimeout: () => {},
				setInterval: (callback, delay) => { if (delay === 5000) refreshCallback = callback; return { unref() {} }; },
				clearInterval: () => {},
				Cron: class {
					constructor(schedule, callback) {
						if (scenario === 'invalid-cron') {
							failWrites = true;
							throw new Error('cron initialization failed');
						}
						cronCallback = callback;
					}
					stop() {}
				},
			};
			(async () => {
				const h = await harness(process.cwd(), async () => {
					assert.equal(scenario, 'completion');
					executions++;
					failWrites = true;
					return { code: 0, stdout: 'done', stderr: '' };
				}, overrides);
				console.log('STATE_DIR=' + path.dirname(h.stateFile));
				h.context.hasUI = true;
				h.context.ui = {
					setStatus() {}, setWidget() {},
					notify(message) {
						notices.push(message);
						if (scenario === 'throwing-reporter' || scenario === 'expiry') throw new Error('UI is closed');
					},
				};
				try {
					await h.start();
					const cron = scenario === 'cron' || scenario === 'invalid-cron';
					await h.call('schedule_task', {
						action: scenario === 'completion' ? 'shell' : 'notify', command: 'check', message: 'test', scope: 'session',
						type: cron ? 'cron' : 'once', schedule: cron ? '* * * * *' : '0.01s',
						...(scenario === 'expiry' ? { expiresIn: '1s' } : {}),
					});
					if (scenario !== 'invalid-cron') {
						failWrites = scenario !== 'completion';
						await new Promise(resolve => setTimeout(resolve, 20));
						(cron ? cronCallback : timerCallback)();
					}
					await until(() => notices.some(message => message.includes('store unavailable')), 'background failure reported');
					assert.ok(failedWrites >= (scenario === 'invalid-cron' || scenario === 'expiry' ? 1 : 2));
					// Allow Node's unhandled-rejection check to run, including reporter failures.
					await new Promise(resolve => setTimeout(resolve, 20));
					if (scenario === 'completion') {
						assert.equal((await h.tasks())[0].status, 'running');
						failWrites = false;
						await refreshCallback();
						const [task] = await h.tasks();
						assert.equal(task.runOwner, undefined, 'a failed finalization must not remain owned forever');
						assert.equal(task.history[0].outcome.status, 'interrupted');
						assert.equal(executions, 1, 'must not repeat a completed shell command');
					}
					if (scenario === 'timeout') {
						assert.equal(timerRegistrations, 1, 'must not immediately rearm a failed claim');
						assert.equal(failedWrites, 2);
						failWrites = false;
						await refreshCallback();
						assert.equal(timerRegistrations, 2, 'refresh must retry even without a revision change');
						timerCallback();
						await until(async () => (await h.tasks())[0]?.runCount === 1, 'recovery after store becomes available');
					}

				} finally {
					failWrites = false;
					await h.close();
				}
			})().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		let stdout = "";
		t.after(async () => {
			const stateDir = stdout.match(/^STATE_DIR=(.+)$/m)?.[1];
			if (stateDir) await rm(stateDir, { recursive: true, force: true });
		});
		const result = await new Promise((resolveResult, reject) => {
			const child = spawn(process.execPath, ["--unhandled-rejections=strict", "-e", script, scenario], {
				cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
			});
			let stderr = "";
			child.stdout.on("data", chunk => stdout += chunk);
			child.stderr.on("data", chunk => stderr += chunk);
			child.on("error", reject);
			child.on("close", (code, signal) => resolveResult({ code, signal, stderr }));
		});
		assert.equal(result.code, 0, `child failed (${result.signal}): ${result.stderr}`);
	});
}
