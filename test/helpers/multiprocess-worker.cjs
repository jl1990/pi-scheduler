"use strict";

const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire, stripTypeScriptTypes } = require("node:module");
const { randomUUID } = require("node:crypto");

const [root, stateFile, sessionFile] = process.argv.slice(2);
const source = stripTypeScriptTypes(readFileSync(path.join(root, "extensions/scheduler/index.ts"), "utf8"))
  .replace(/^import .*;\s*$/gm, "")
  .replace("export default function schedulerExtension", "function schedulerExtension");
const localRequire = createRequire(path.join(root, "extensions/scheduler/index.ts"));
const events = {}, tools = {}, commands = {};
const context = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: { getSessionFile: () => sessionFile } };

function execShell(_program, args, options = {}) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] === "-lc" ? "bash" : _program, args[0] === "-lc" ? ["-lc", args[1]] : args, { cwd: options.cwd });
    let stdout = "", stderr = "", timer;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (options.timeout) timer = setTimeout(() => child.kill("SIGTERM"), options.timeout);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, signal, killed: signal !== null, stdout, stderr });
    });
  });
}

const pi = {
  on: (name, fn) => { events[name] = fn; },
  registerTool: (tool) => { tools[tool.name] = tool; },
  registerCommand: (name, command) => { commands[name] = command; },
  registerMessageRenderer: () => {},
  sendUserMessage: () => {}, sendMessage: () => {}, exec: execShell,
};
const sandbox = {
  require: localRequire,
  process: { ...process, env: { ...process.env, PI_SCHEDULER_STATE_FILE: stateFile } },
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Cron: localRequire("croner").Cron, randomUUID, homedir: () => path.dirname(stateFile), join: path.join,
  StringEnum: (values) => ({ enum: values }), Text: class {},
  Type: new Proxy({}, { get: (_, key) => (value) => key === "Object" ? { properties: value } : value }),
};
vm.runInNewContext(source + "\nschedulerExtension(pi);", { ...sandbox, pi }, { filename: path.join(root, "extensions/scheduler/index.ts") });

const reply = (id, ok, result) => process.send?.({ id, ok, ...(ok ? { result } : { error: String(result?.message ?? result) }) });
process.on("message", async (message) => {
  try {
    let result;
    if (message.op === "start") result = await events.session_start({}, context);
    else if (message.op === "schedule") result = await tools.schedule_task.execute("multiprocess", message.args, undefined, undefined, context);
    else if (message.op === "tasks") result = JSON.parse(await fs.readFile(stateFile, "utf8"));
    else if (message.op === "shutdown") { result = await events.session_shutdown({}, context); }
    else throw new Error(`Unknown worker operation: ${message.op}`);
    reply(message.id, true, result);
    if (message.op === "shutdown") process.exit(0);
  } catch (error) { reply(message.id, false, error); }
});
