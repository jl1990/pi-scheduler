const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extensions/scheduler/scheduler-core.cjs');
const {harness, until} = require('./helpers/runtime-harness.cjs');
const NOW = new Date('2026-09-13T12:00:00Z');
const make = (extra = {}) => core.createScheduledTask({action:'shell', type:'interval', schedule:'1m', command:'check', expiresIn:'1s', ...extra}, NOW, ()=>'task');

test('expired cron tasks cannot enter catch-up selection or due lists', () => {
  const task = make({type:'cron', schedule:'* * * * * *'});
  const later = new Date(NOW.getTime() + 2000);
  assert.deepEqual(core.selectCatchUpCronTasks([task], later, {windowHours:24, maxFire:5}), []);
  assert.deepEqual(core.dueTasks([task], later), []);
});

test('invalid and empty durations rejected; elapsed disabled task requires renewal to enable via update', () => {
  for (const expiresIn of ['', '0s', '-1s', 'bogus', '999999999999999999999999d']) {
    assert.throws(()=>make({expiresIn}), /expiresIn/);
  }
  const task = make({enabled:false});
  assert.throws(()=>core.updateScheduledTask([task],task.id,{enabled:true},new Date(NOW.getTime()+2000)), /expired/);
});

test('expiry before first due prevents execution and survives restart', async () => {
  let calls=0;
  const h=await harness(__dirname+'/..',async()=>{calls++;return {code:0,stdout:'',stderr:''};});
  try {
    await h.start();
    await h.call('schedule_task',{action:'shell',type:'once',schedule:'0.2s',command:'check',expiresIn:'0.04s'});
    await until(async()=> (await h.tasks())[0]?.status==='expired','expiry before execution');
    await h.events.session_shutdown({},h.context);
    await h.start();
    await new Promise(resolve=>setTimeout(resolve,220));
    assert.equal(calls,0);
    assert.equal(h.wakes.length,0);
  } finally {await h.close();}
});

test('running command completes across expiry without another execution', async () => {
  let calls=0, release;
  const h=await harness(__dirname+'/..',()=>{calls++;return new Promise(resolve=>release=resolve);});
  try {
    await h.start();
    await h.call('schedule_task',{action:'shell',type:'interval',schedule:'0.02s',command:'check',expiresIn:'0.06s'});
    await until(()=>release,'command started');
    await new Promise(resolve=>setTimeout(resolve,80));
    const [running]=await h.tasks();
    assert.ok(running.runOwner);
    release({code:0,stdout:'',stderr:''});
    await until(async()=> (await h.tasks())[0]?.status==='expired','completion expires');
    assert.equal((await h.tasks())[0].runOwner,undefined);
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(calls,1);
  } finally {await h.close();}
});

test('renewing a running task retains ownership and does not launch an overlapping run', async () => {
  let calls=0, release;
  const h=await harness(__dirname+'/..',()=>{calls++;return new Promise(resolve=>release=resolve);});
  try {
    await h.start();
    const created=await h.call('schedule_task',{action:'shell',type:'interval',schedule:'0.02s',command:'check',expiresIn:'0.05s'});
    await until(()=>release,'first command');
    const owner=(await h.tasks())[0].runOwner.attemptId;
    await new Promise(resolve=>setTimeout(resolve,60));
    await h.call('manage_scheduled_task',{action:'update',id:created.details.task.id,expiresIn:'1h',schedule:'1h'});
    assert.equal((await h.tasks())[0].runOwner.attemptId,owner);
    assert.equal((await h.tasks())[0].status,'running');
    release({code:0,stdout:'',stderr:''});
    await until(async()=> (await h.tasks())[0]?.runCount===1,'completion after renewal');
    assert.equal((await h.tasks())[0].status,'pending');
    assert.equal(calls,1);
  } finally {await h.close();}
});

test('disabled task still reaches expired state without executing', async () => {
  let calls=0;
  const h=await harness(__dirname+'/..',async()=>{calls++;return {code:0};});
  try {
    await h.start();
    await h.call('schedule_task',{action:'shell',type:'interval',schedule:'1h',command:'check',expiresIn:'0.03s',enabled:false});
    await until(async()=> (await h.tasks())[0]?.status==='expired','disabled deadline');
    assert.equal(calls,0);
  } finally {await h.close();}
});
