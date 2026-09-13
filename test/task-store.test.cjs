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
		const child = spawn(process.execPath, ["-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
