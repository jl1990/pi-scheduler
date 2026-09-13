"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");

async function createMultiprocessHarness(root) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scheduler-multiprocess-"));
  const stateFile = path.join(dir, "tasks.json");
  const sessionFile = path.join(dir, "session.jsonl");
  const workerFile = path.join(root, "test/helpers/multiprocess-worker.cjs");
  const children = [];
  function worker(name) {
    const child = fork(workerFile, [root, stateFile, sessionFile], { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const pending = new Map();
    let exited = false;
    const exitPromise = new Promise((resolve) => {
      const finish = () => { exited = true; for (const request of pending.values()) request.reject(new Error("worker terminated")); pending.clear(); resolve(); };
      child.once("exit", finish);
      child.once("error", () => { if (!child.pid) finish(); });
    });
    child.on("error", (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); });
    child.on("message", (message) => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.ok ? request.resolve(message.result) : request.reject(new Error(message.error));
    });
    const api = { name, child, exitPromise, call(op, args) { return new Promise((resolve, reject) => {
      if (exited || !child.connected) return reject(new Error("worker is not connected"));
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for worker operation: ${op}`)); }, 10_000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      child.send({ id, op, args }, (error) => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    }); } };
    children.push(api);
    return api;
  }
  async function tasks() { return JSON.parse(await fs.readFile(stateFile, "utf8")); }
  function crash(child) {
    if (!Number.isInteger(child.child.pid) || child.child.pid <= 0) return;
    try { process.kill(-child.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  async function close() {
    await Promise.all(children.map(async (child) => {
      if (!child.child.killed && child.child.connected) {
        try { await child.call("shutdown"); } catch { crash(child); }
      }
      const fallback = setTimeout(() => crash(child), 1000);
      try { await child.exitPromise; } finally { clearTimeout(fallback); }
    }));
    await Promise.all(children.map((child) => child.exitPromise));
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { dir, stateFile, markerFile: path.join(dir, "executions.log"), worker, tasks, crash, close };
}
module.exports = { createMultiprocessHarness };
