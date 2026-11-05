"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, utimes } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const { createTaskStore } = require("../extensions/scheduler/task-store.cjs");

function runNode(script, args) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`child exited ${code}: ${stderr}`))));
	});
}

test("concurrent transactions preserve every writer's changes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-store-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const stateFile = join(dir, "tasks.json");
	const store = createTaskStore({ stateFile, sanitize: (tasks) => tasks });

	await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			store.transact(async (tasks) => {
				await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
				tasks.push({ id: `task-${index}` });
			}),
		),
	);

	const { tasks, revision } = await store.read();
	assert.equal(tasks.length, 20);
	assert.equal(revision, 20);
	assert.deepEqual(
		tasks.map((task) => task.id).sort(),
		Array.from({ length: 20 }, (_, index) => `task-${index}`).sort(),
	);
	JSON.parse(await readFile(stateFile, "utf8"));
});

test("transactions preserve changes across separate Node processes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-processes-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const stateFile = join(dir, "tasks.json");
	const modulePath = resolve(__dirname, "../extensions/scheduler/task-store.cjs");
	const script = `
		const { createTaskStore } = require(process.argv[1]);
		const store = createTaskStore({ stateFile: process.argv[2], sanitize: (tasks) => tasks });
		store.transact((tasks) => tasks.push({ id: process.argv[3] })).catch((error) => { console.error(error); process.exit(1); });
	`;
	await Promise.all(Array.from({ length: 12 }, (_, index) => runNode(script, [modulePath, stateFile, `process-${index}`])));
	const snapshot = await createTaskStore({ stateFile, sanitize: (tasks) => tasks }).read();
	assert.equal(snapshot.tasks.length, 12);
	assert.equal(new Set(snapshot.tasks.map((task) => task.id)).size, 12);
});

test("a state transaction can atomically claim a task only once", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-claim-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = createTaskStore({ stateFile: join(dir, "tasks.json"), sanitize: (tasks) => tasks });
	await store.transact((tasks) => tasks.push({ id: "shared", status: "pending", enabled: true }));

	const claims = await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			store.transact((tasks) => {
				const task = tasks.find((candidate) => candidate.id === "shared");
				if (task.status !== "pending") return false;
				task.status = "running";
				task.owner = index;
				return true;
			}),
		),
	);
	assert.equal(claims.filter(({ result }) => result).length, 1);
});

for (const scenario of ["removed", "replaced", "during-read", "during-write"]) {
	test(`compromised lock (${scenario}) rejects without crashing or committing and permits recovery`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-compromised-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const stateFile = join(dir, "tasks.json");
		const modulePath = resolve(__dirname, "../extensions/scheduler/task-store.cjs");
		// Run with Node's default uncaught-exception handling: a timer throw must fail this test.
		const script = `
			const assert = require('node:assert/strict');
			const fs = require('node:fs/promises');
			const path = require('node:path');
			const stateFile = process.argv[2];
			const scenario = process.argv[3];
			const lockDir = stateFile + '.lock';
			async function compromise() {
				if (scenario === 'removed') await fs.rmdir(lockDir);
				else {
					const foreignTime = new Date(Date.now() + 60_000);
					await fs.utimes(lockDir, foreignTime, foreignTime);
				}
				// Let proper-lockfile's real heartbeat observe the loss of ownership.
				await new Promise(resolve => setTimeout(resolve, 2500));
			}
			const readFile = fs.readFile;
			let interruptRead = false;
			fs.readFile = async (...args) => {
				const result = await readFile(...args);
				if (interruptRead && args[0] === stateFile) {
					interruptRead = false;
					await compromise();
				}
				return result;
			};
			const writeFile = fs.writeFile;
			let interruptWrite = false;
			fs.writeFile = async (...args) => {
				const result = await writeFile(...args);
				if (interruptWrite && String(args[0]).endsWith('.tmp')) {
					interruptWrite = false;
					await compromise();
				}
				return result;
			};
			const { createTaskStore } = require(process.argv[1]);
			(async () => {
				const store = createTaskStore({ stateFile });
				await store.transact(tasks => tasks.push({ id: 'original' }));
				const before = await fs.readFile(stateFile, 'utf8');
				interruptRead = scenario === 'during-read';
				interruptWrite = scenario === 'during-write';
				await assert.rejects(store.transact(async tasks => {
					assert.notEqual(scenario, 'during-read', 'must not invoke mutator after ownership loss');
					tasks.push({ id: 'must-not-commit' });
					if (scenario !== 'during-write') await compromise();
				}), { code: 'ECOMPROMISED' });
				assert.equal(await fs.readFile(stateFile, 'utf8'), before);
				assert.equal((await fs.readdir(path.dirname(stateFile))).some(name => name.endsWith('.tmp')), false);
				if (scenario !== 'removed') {
					// Releasing a compromised lease must not remove a peer's lock.
					await fs.stat(lockDir);
					await fs.rmdir(lockDir);
				}
				await store.transact(tasks => tasks.push({ id: 'recovered' }));
				assert.deepEqual(await store.read(), { tasks: [{ id: 'original' }, { id: 'recovered' }], revision: 2 });
			})().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		await runNode(script, [modulePath, stateFile, scenario]);
	});
}

test("stale lock owned by a dead process is recovered", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-stale-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const stateFile = join(dir, "tasks.json");
	const lockDir = `${stateFile}.lock`;
	await mkdir(lockDir, { recursive: true });
	const staleTime = new Date(Date.now() - 30_000);
	await utimes(lockDir, staleTime, staleTime);

	const store = createTaskStore({ stateFile, sanitize: (tasks) => tasks });
	await store.transact((tasks) => tasks.push({ id: "recovered" }));
	assert.deepEqual((await store.read()).tasks, [{ id: "recovered" }]);
});

test("locking survives a host that exposes fs modules through a lazy Proxy", async (t) => {
	// Reproduces issue #13: proper-lockfile caches mtime precision on the fs object with a
	// non-configurable property. When the host hands out fs through a Proxy whose `get`
	// reads from a different object, reading that cache back breaks a Proxy invariant
	// inside an fs callback and terminates the process.
	const dir = await mkdtemp(join(tmpdir(), "pi-scheduler-proxied-fs-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const modulePath = resolve(__dirname, "../extensions/scheduler/task-store.cjs");
	const script = `
		const Module = require('node:module');
		const load = Module._load;
		const proxies = new Map();
		Module._load = function (request, ...rest) {
			const loaded = load.call(this, request, ...rest);
			if (request !== 'graceful-fs') return loaded;
			if (!proxies.has(loaded)) proxies.set(loaded, new Proxy({}, { get: (_, key) => loaded[key] }));
			return proxies.get(loaded);
		};
		const { createTaskStore } = require(process.argv[1]);
		const store = createTaskStore({ stateFile: process.argv[2] });
		(async () => {
			await store.transact((tasks) => tasks.push({ id: 'first' }));
			await store.transact((tasks) => tasks.push({ id: 'second' }));
			const { tasks } = await store.read();
			if (tasks.length !== 2) throw new Error('expected two tasks, got ' + tasks.length);
		})().catch((error) => { console.error(error); process.exit(1); });
	`;
	await runNode(script, [modulePath, join(dir, "tasks.json")]);
});
