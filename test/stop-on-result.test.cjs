const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extensions/scheduler/scheduler-core.cjs');
const NOW = new Date('2026-09-13T12:00:00Z');
function task(extra = {}) {
  return core.createScheduledTask({action:'shell', type:'interval', schedule:'1m', command:'check', stopOn:'success', ...extra}, NOW, ()=>'task');
}

test('stopOn works for cron and interval independently of wake policy', () => {
  for (const type of ['interval', 'cron']) {
    const item = task({type, schedule: type === 'cron' ? '0 * * * * *' : '1m', wakeOn:'never'});
    core.markScheduledTaskCompleted([item], item.id, NOW, {code:1});
    assert.equal(item.enabled, true);
    assert.ok(item.nextRun);
    assert.equal(core.shouldWakeForShellResult(item, {code:0}), false);
    core.markScheduledTaskCompleted([item], item.id, NOW, {code:0});
    assert.equal(item.enabled, false);
    assert.equal(item.nextRun, undefined);
    assert.equal(item.runCount, 2);
  }
});

test('maxRuns still bounds unmatched results and thrown execution failures can stop', () => {
  const capped = task({maxRuns:1});
  core.markScheduledTaskCompleted([capped], capped.id, NOW, {code:1});
  assert.equal(capped.enabled, false);
  const errored = task({stopOn:'failure'});
  core.markScheduledTaskFailed([errored], errored.id, NOW, new Error('exec failed'));
  assert.equal(errored.enabled, false);
  assert.match(errored.stopReason, /failure/);
});

test('cancellation wins and explicit enable clears the previous stop reason', () => {
  const cancelled = task();
  core.markScheduledTaskRunning([cancelled], cancelled.id, NOW, {runOwner:{pid:1}});
  core.cancelScheduledTask([cancelled], cancelled.id, NOW);
  core.markScheduledTaskCompleted([cancelled], cancelled.id, NOW, {code:0});
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.runOwner, undefined);
  const stopped = task();
  core.markScheduledTaskCompleted([stopped], stopped.id, NOW, {code:0});
  core.enableScheduledTask([stopped], stopped.id, NOW);
  assert.equal(stopped.stopReason, undefined);
  assert.equal(stopped.enabled, true);
});

test('malformed saved stop policy fails closed without breaking other tasks', () => {
  const saved = core.sanitizeTasks([{...task(), stopOn:'typo'}, {...task(), id:'valid'}], NOW);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].status, 'failed');
  assert.match(saved[0].lastError, /stopOn/);
  assert.equal(saved[1].enabled, true);
});
