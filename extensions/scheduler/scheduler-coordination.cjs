"use strict";

function reconcileSnapshot(snapshot, currentRevision, install, reconcile) {
	if (snapshot.revision <= currentRevision) return false;
	install(snapshot.tasks, snapshot.revision);
	reconcile();
	return true;
}

function needsInterruptedRunRecovery(tasks, isOwnerActive) {
	return tasks.some((task) => task.status === "running" && !isOwnerActive(task.runOwner));
}

async function refreshSchedulerState(options) {
	let snapshot = await options.store.read();
	if (needsInterruptedRunRecovery(snapshot.tasks, options.isOwnerActive)) {
		const transaction = await options.store.transact((tasks) =>
			options.recoverInterrupted(tasks, options.now(), { isOwnerActive: options.isOwnerActive }),
		);
		snapshot = transaction;
	}
	return reconcileSnapshot(snapshot, options.currentRevision(), options.install, options.reconcile);
}

function createRefreshLoop(options) {
	let handle;
	let inFlight = false;

	async function tick(generation) {
		if (inFlight) return;
		inFlight = true;
		try {
			await options.run(generation);
		} catch (error) {
			options.onError?.(error);
		} finally {
			inFlight = false;
		}
	}

	function stop() {
		if (handle !== undefined) options.clearInterval(handle);
		handle = undefined;
	}

	function start(generation) {
		stop();
		handle = options.setInterval(() => tick(generation), options.intervalMs);
		handle?.unref?.();
	}

	return { start, stop, tick };
}

module.exports = { createRefreshLoop, reconcileSnapshot, refreshSchedulerState };
