const test = require('node:test');
const assert = require('node:assert/strict');
const {harness, until} = require('./helpers/runtime-harness.cjs');

test('change detection, backoff, stop-on-success, expiry and history compose', async () => {
  let calls=0;
  const h=await harness(__dirname+'/..',async()=>({code:++calls===1?1:0,stdout:calls===1?'pending':'ready',stderr:''}));
  try {
    await h.start();
    await h.call('schedule_task',{action:'shell',type:'interval',schedule:'0.02s',command:'check',wakeOn:'change',stopOn:'success',expiresIn:'2s',backoff:{factor:2,maxInterval:'0.1s'}});
    await until(async()=> (await h.tasks())[0]?.status==='fired','successful automatic stop');
    await until(async()=> (await h.tasks())[0]?.history?.[1]?.wakeDisposition==='delivered','recorded change wake');
    const [task]=await h.tasks();
    assert.equal(task.history.length,2);
    assert.equal(task.history[0].wakeDisposition,'suppressed');
    assert.equal(task.history[1].wakeReason,'change');
    assert.equal(h.wakes.length,1);
    assert.equal(calls,2);
    assert.equal(task.nextRun,undefined);
  } finally {await h.close();}
});

test('expiry wins over the next backed-off run while retaining completed run history', async () => {
  let calls=0;
  const h=await harness(__dirname+'/..',async()=>{calls++;return {code:1,stdout:'pending',stderr:''};});
  try {
    await h.start();
    await h.call('schedule_task',{action:'shell',type:'interval',schedule:'0.02s',command:'check',wakeOn:'change',stopOn:'success',expiresIn:'0.1s',backoff:{factor:10,maxInterval:'1s'}});
    await until(async()=> (await h.tasks())[0]?.status==='expired','expiry before next backed-off run');
    const [task]=await h.tasks();
    assert.equal(task.history.length,1);
    assert.equal(calls,1);
    assert.equal(h.wakes.length,0);
    assert.equal(task.nextRun,undefined);
  } finally {await h.close();}
});
