const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, stripTypeScriptTypes } = require('node:module');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');

async function harness(root, exec, sandboxOverrides = {}) {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-scheduler-runtime-'));
  const stateFile = path.join(stateDir, 'tasks.json');
  const localRequire = createRequire(path.join(root, 'extensions/scheduler/index.ts'));
  const pending = new Set();
  const backgroundErrors = [];
  function track(work) {
    const promise = Promise.resolve(work);
    pending.add(promise);
    promise.then(() => pending.delete(promise), error => {
      pending.delete(promise);
      backgroundErrors.push(error);
    });
    return promise;
  }
  async function settle(timeout = 4000) {
    let timer;
    try {
      await Promise.race([
        (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          if (backgroundErrors.length) throw new AggregateError(backgroundErrors.splice(0), 'Scheduler background work failed');
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out draining scheduler background work')), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function trackedRequire(id) {
    const module = (sandboxOverrides.require ?? localRequire)(id);
    if (id !== './scheduler-coordination.cjs') return module;
    return { ...module, runInBackground: (...args) => track(module.runInBackground(...args)) };
  }
  const source = stripTypeScriptTypes(readFileSync(path.join(root, 'extensions/scheduler/index.ts'), 'utf8'))
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default function schedulerExtension', 'function schedulerExtension');
  const events = {}, tools = {}, commands = {}, wakes = [], messages = [], userMessages = [];
  const context = {
    cwd: root, hasUI: false, isIdle: () => true,
    sessionManager: {getSessionFile: () => path.join(stateDir, 'session.jsonl')},
  };
  const pi = {
    on: (name, fn) => events[name] = fn,
    registerTool: tool => tools[tool.name] = tool,
    registerCommand: (name, command) => commands[name] = command,
    registerMessageRenderer: () => {},
    sendUserMessage: (text, options) => {
      userMessages.push({text, options});
      wakes.push({text, options});
    },
    sendMessage: (message, options) => {
      if (options?.triggerTurn && options?.deliverAs === 'followUp') {
        wakes.push({text: message.content, options});
      }
      messages.push({message, options});
    },
    exec,
  };
  const sandbox = {
    require: localRequire, process: {...process, env: {...process.env, PI_SCHEDULER_STATE_FILE: stateFile}},
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Cron: localRequire('croner').Cron, randomUUID, homedir: () => stateDir, join: path.join,
    AgentSession: class { dequeueUserMessages() {} },
    StringEnum: values => ({enum: values}), Text: class {},
    Type: new Proxy({}, {get: (_, key) => value => key === 'Object' ? {properties: value} : value}),
    ...sandboxOverrides,
    require: trackedRequire,
    setInterval: (callback, delay) => (sandboxOverrides.setInterval ?? setInterval)(
      (...args) => track(Promise.resolve().then(() => callback(...args))), delay,
    ),
  };
  vm.runInNewContext(source + '\nschedulerExtension(pi);', {...sandbox, pi}, {filename: path.join(root, 'extensions/scheduler/index.ts')});
  return {
    events, tools, commands, wakes, messages, userMessages, stateFile, context,
    start: () => events.session_start({}, context),
    call: (name, args) => tools[name].execute('test', args, undefined, undefined, context),
    tasks: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')).tasks,
    settle,
    close: async () => {
      await events.session_shutdown({}, context);
      // Shutdown disarms timers but deliberately lets running tasks finish.
      // Keep their store alive until completion, wake persistence, and unlock finish.
      await settle();
      await fs.rm(stateDir, {recursive: true, force: true});
    },
  };
}
async function until(predicate, description, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out: ' + description);
}
// Keep real deadlines and real store I/O, but let a test advance exactly one
// scheduler timer and drain its work before inspecting intermediate run state.
function controlledTimers() {
  const timers = new Map();
  return {
    sandbox: {
      setTimeout(callback, delay) {
        const handle = {};
        timers.set(handle, {callback, deadline: Date.now() + delay});
        return handle;
      },
      clearTimeout: handle => timers.delete(handle),
      setInterval: () => ({unref() {}}),
      clearInterval() {},
    },
    async runNext(runtime) {
      if (timers.size !== 1) throw new Error(`Expected one armed timer, got ${timers.size}`);
      const [handle, timer] = timers.entries().next().value;
      while (Date.now() < timer.deadline) {
        await new Promise(resolve => setTimeout(resolve, timer.deadline - Date.now()));
      }
      timers.delete(handle);
      timer.callback();
      await runtime.settle();
    },
  };
}
module.exports = {harness, until, controlledTimers};
