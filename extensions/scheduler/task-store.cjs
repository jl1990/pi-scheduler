"use strict";

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
const lockfile = require("proper-lockfile");

function createTaskStore(options) {
	const stateFile = options.stateFile;
	const sanitize = options.sanitize ?? ((tasks) => tasks);

	async function readUnlocked() {
		try {
			const raw = await readFile(stateFile, "utf8");
			const parsed = JSON.parse(raw);
			return {
				tasks: sanitize(parsed.tasks ?? parsed),
				revision: Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
			};
		} catch (error) {
			if (error?.code === "ENOENT") return { tasks: [], revision: 0 };
			throw error;
		}
	}

	async function writeUnlocked(tasks, revision) {
		await mkdir(dirname(stateFile), { recursive: true });
		const payload = JSON.stringify({ version: 2, revision, updatedAt: new Date().toISOString(), tasks }, null, 2) + "\n";
		const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmp, payload, "utf8");
		await rename(tmp, stateFile);
	}

	async function acquireLock() {
		await mkdir(dirname(stateFile), { recursive: true });
		return lockfile.lock(stateFile, {
			realpath: false,
			stale: 10_000,
			update: 2_000,
			retries: { retries: 100, minTimeout: 10, maxTimeout: 100, randomize: true },
		});
	}

	async function read() {
		return readUnlocked();
	}

	async function transact(mutator) {
		const release = await acquireLock();
		try {
			const snapshot = await readUnlocked();
			const result = await mutator(snapshot.tasks);
			const revision = snapshot.revision + 1;
			await writeUnlocked(snapshot.tasks, revision);
			return { tasks: snapshot.tasks, revision, result };
		} finally {
			await release();
		}
	}

	return { read, transact };
}

module.exports = { createTaskStore };
