const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extensions/scheduler/scheduler-core.cjs');

test('invalid saved deadline is removed while its task fails closed', () => {
	const now = new Date('2026-01-01T00:00:00Z');
	const original = core.createScheduledTask({ action: 'shell', type: 'interval', schedule: '1h', command: 'check' }, now);
	const [task] = core.sanitizeTasks([{ ...original, expiresAt: 'garbage' }], now);
	assert.equal(task.enabled, false);
	assert.equal(task.status, 'failed');
	assert.equal(task.lastStatus, 'error');
	assert.equal(task.expiresAt, undefined);
	assert.equal(task.nextRun, undefined);
	assert.match(task.lastError, /Invalid persisted expiresAt/);
	assert.deepEqual(core.sanitizeTasks([task], now), [task]);
	assert.doesNotThrow(() => core.enableScheduledTask([task], task.id, now));
});
