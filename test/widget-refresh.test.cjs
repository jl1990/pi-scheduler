"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { harness } = require("./helpers/runtime-harness.cjs");

const ROOT = resolve(__dirname, "..");
const WIDGET_TICK_MS = 1_000;

test("the scheduled actions widget keeps its relative time current (issue #14)", async () => {
	const intervals = new Map();
	const cleared = new Set();
	const h = await harness(ROOT, async () => ({ code: 0, stdout: "", stderr: "" }), {
		setInterval: (callback, delay) => {
			const handle = { delay, unref() {} };
			intervals.set(delay, { callback, handle });
			return handle;
		},
		clearInterval: (handle) => cleared.add(handle),
	});
	const widgets = [];
	h.context.hasUI = true;
	h.context.ui = {
		setStatus() {},
		notify() {},
		setWidget: (_key, lines) => widgets.push(lines),
	};
	try {
		await h.start();
		await h.call("schedule_task", { action: "notify", message: "later", type: "once", schedule: "1h", scope: "session" });
		const before = widgets.at(-1);
		assert.match(before.join("\n"), /in 59m 5\ds|in 1h/);

		const tick = intervals.get(WIDGET_TICK_MS);
		assert.ok(tick, "widget must refresh on a periodic tick");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
		const renders = widgets.length;
		await tick.callback();
		assert.equal(widgets.length, renders + 1, "a tick must re-render a widget whose text changed");
		assert.notDeepEqual(widgets.at(-1), before);

		await tick.callback();
		assert.equal(widgets.length, renders + 1, "a tick must not re-render unchanged text");
	} finally {
		await h.close();
	}
	assert.ok(cleared.has(intervals.get(WIDGET_TICK_MS).handle), "shutdown must stop the widget tick");
});
