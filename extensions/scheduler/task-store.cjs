"use strict";

const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const lockfile = require("proper-lockfile");

// The fs implementation proper-lockfile would use by default.
const lockfileFs = createRequire(require.resolve("proper-lockfile"))("graceful-fs");

// proper-lockfile caches its mtime precision on the fs object with a non-configurable
// property. Hosts may hand modules out through a Proxy whose reads do not reflect that
// write, which breaks a Proxy invariant inside an fs callback and kills the process.
// Give the library a plain object we own so its cache lands somewhere ordinary.
function createLockFs(base) {
	const methods = ["mkdir", "realpath", "rmdir", "rmdirSync", "stat", "utimes"];
	return Object.fromEntries(methods.map((name) => [name, (...args) => base[name](...args)]));
}

function createTaskStore(options) {
	const stateFile = options.stateFile;
	const sanitize = options.sanitize ?? ((tasks) => tasks);
	const lockFs = createLockFs(lockfileFs);

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

	async function writeUnlocked(tasks, revision, assertLock) {
		await mkdir(dirname(stateFile), { recursive: true });
		const payload = JSON.stringify({ version: 2, revision, updatedAt: new Date().toISOString(), tasks }, null, 2) + "\n";
		const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
		try {
			assertLock();
			await writeFile(tmp, payload, "utf8");
			assertLock();
			await rename(tmp, stateFile);
			assertLock();
		} catch (error) {
			// Best-effort cleanup must not hide the transaction's original failure.
			await rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
	}

	async function acquireLock(onCompromised) {
		await mkdir(dirname(stateFile), { recursive: true });
		return lockfile.lock(stateFile, {
			fs: lockFs,
			realpath: false,
			onCompromised,
			stale: 10_000,
			update: 2_000,
			retries: { retries: 100, minTimeout: 10, maxTimeout: 100, randomize: true },
		});
	}

	async function read() {
		return readUnlocked();
	}

	async function transact(mutator) {
		let compromised;
		const release = await acquireLock((error) => {
			// This callback runs on the library's heartbeat, outside our promise chain.
			// Record ownership loss instead of throwing out of the timer into Pi.
			compromised = error;
		});
		const assertLock = () => {
			if (compromised) throw compromised;
		};
		try {
			assertLock();
			const snapshot = await readUnlocked();
			assertLock();
			const result = await mutator(snapshot.tasks);
			assertLock();
			const revision = snapshot.revision + 1;
			await writeUnlocked(snapshot.tasks, revision, assertLock);
			return { tasks: snapshot.tasks, revision, result };
		} finally {
			// proper-lockfile already invalidates compromised leases. Releasing one
			// would raise ERELEASED and hide the original compromise error.
			if (!compromised) await release();
		}
	}

	return { read, transact };
}

module.exports = { createTaskStore };
