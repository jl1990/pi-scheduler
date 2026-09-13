const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, stripTypeScriptTypes } = require('node:module');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');

async function harness(root, exec) {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-scheduler-runtime-'));
  const stateFile = path.join(stateDir, 'tasks.json');
  const localRequire = createRequire(path.join(root, 'extensions/scheduler/index.ts'));
  const source = stripTypeScriptTypes(readFileSync(path.join(root, 'extensions/scheduler/index.ts'), 'utf8'))
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default function schedulerExtension', 'function schedulerExtension');
  const events = {}, tools = {}, commands = {}, wakes = [], messages = [];
  const context = {
    cwd: root, hasUI: false, isIdle: () => true,
    sessionManager: {getSessionFile: () => path.join(stateDir, 'session.jsonl')},
  };
  const pi = {
    on: (name, fn) => events[name] = fn,
    registerTool: tool => tools[tool.name] = tool,
    registerCommand: (name, command) => commands[name] = command,
    registerMessageRenderer: () => {},
    sendUserMessage: (text, options) => wakes.push({text, options}),
    sendMessage: (message, options) => messages.push({message, options}),
    exec,
  };
  const sandbox = {
    require: localRequire, process: {...process, env: {...process.env, PI_SCHEDULER_STATE_FILE: stateFile}},
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Cron: localRequire('croner').Cron, randomUUID, homedir: () => stateDir, join: path.join,
    StringEnum: values => ({enum: values}), Text: class {},
    Type: new Proxy({}, {get: (_, key) => value => key === 'Object' ? {properties: value} : value}),
  };
  vm.runInNewContext(source + '\nschedulerExtension(pi);', {...sandbox, pi}, {filename: path.join(root, 'extensions/scheduler/index.ts')});
  return {
    events, tools, commands, wakes, messages, stateFile, context,
    start: () => events.session_start({}, context),
    call: (name, args) => tools[name].execute('test', args, undefined, undefined, context),
    tasks: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')).tasks,
    close: async () => {await events.session_shutdown({}, context); await fs.rm(stateDir, {recursive: true, force: true});},
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
module.exports = {harness, until};
