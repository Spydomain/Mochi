import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { AgentSessions } from "../src/core/agent-sessions.ts";

async function harness() {
  const sent = [], hooks = new Map(), polls = [];
  const queue = [], waiters = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = value => { sent.push(JSON.parse(value)); queueMicrotask(() => child.emit("close", 0)); };
    child.unref = () => {};
    child.kill = () => child.emit("close", 1);
    return child;
  };
  const source = readFileSync(new URL("../scripts/mochi-opencode.js", import.meta.url), "utf8")
    .replace("import { spawn } from 'node:child_process';", "")
    .replace("{HOOK}", '"/test/mochi-hook"').replace("export default", "return");
  const plugin = new Function("spawn", "setInterval", "clearInterval", source)(spawn,
    callback => { polls.push(callback); return { unref() {} }; }, () => {});
  const register = domain => async (name, callback) => {
    hooks.set(`${domain}.${name}`, callback);
    return { dispose: async () => hooks.delete(`${domain}.${name}`) };
  };
  let running = {};
  const ctx = { location: { directory: "/project" },
    session: { hook: register("session"), active: async () => running },
    tool: { hook: register("tool") },
    event: { subscribe({ signal }) {
      signal.addEventListener("abort", () => { for (const next of waiters.splice(0)) next({ done: true }); });
      return { [Symbol.asyncIterator]() { return this; }, next() {
        if (signal.aborted) return Promise.resolve({ done: true });
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        return new Promise(resolve => waiters.push(resolve));
      } };
    } },
  };
  const cleanup = await plugin.setup(ctx);
  return { sent, hooks, cleanup, ctx,
    setRunning: value => { running = value; },
    start: id => hooks.get("tool.execute.before")({ sessionID: id, tool: "patch" }),
    event(type, sessionID, extra = {}) {
      const value = { type, data: { sessionID }, location: { directory: "/project" }, ...extra };
      const next = waiters.shift();
      if (next) next({ value, done: false }); else queue.push(value);
    },
    poll: () => polls[0](),
    async flush() { for (let i = 0; i < 25; i++) await new Promise(setImmediate); },
  };
}

test("OpenCode V2 execution completion carries the exact session ID and late tools cannot resurrect it", async () => {
  const h = await harness();
  try {
    h.start("ses_one");
    h.hooks.get("tool.execute.after")({ sessionID: "ses_one", tool: "patch" });
    h.event("session.execution.succeeded", "ses_one");
    await h.flush();
    h.hooks.get("tool.execute.after")({ sessionID: "ses_one", tool: "patch" });
    await h.flush();
    assert.deepEqual(h.sent.map(e => e.hook_event_name), ["PreToolUse", "PostToolUse", "Stop"]);
    assert.ok(h.sent.every(e => e.session_id === "ses_one"));
  } finally { await h.cleanup(); }
});

test("OpenCode completion, errors and user interruption map to distinct terminal states", async () => {
  const h = await harness();
  try {
    for (const [type, expected] of [["succeeded", "Stop"], ["failed", "StopFailure"], ["interrupted", "Interrupt"]]) {
      h.event("session.execution.started", "ses_one");
      h.event(`session.execution.${type}`, "ses_one");
      await h.flush();
      assert.equal(h.sent.at(-1).hook_event_name, expected);
    }
  } finally { await h.cleanup(); }
});

test("one OpenCode session stopping does not stop another running session or another location", async () => {
  const h = await harness();
  try {
    h.start("ses_one"); h.start("ses_two");
    h.event("session.execution.succeeded", "ses_one");
    h.event("session.execution.started", "ses_other", { location: { directory: "/elsewhere" } });
    await h.flush();
    assert.equal(h.sent.at(-1).session_id, "ses_one");
    assert.equal(h.sent.at(-1).hook_event_name, "Stop");
    h.event("session.execution.interrupted", "ses_two");
    await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "Interrupt");
    assert.equal(h.sent.some(e => e.session_id === "ses_other"), false);
  } finally { await h.cleanup(); }
});

test("authoritative activity reconciliation clears missed stops but never times out a quiet running tool", async () => {
  const h = await harness();
  try {
    h.start("ses_one");
    h.setRunning({ data: { ses_one: { type: "running" } } });
    h.poll(); await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "PreToolUse");
    h.setRunning({ data: {} });
    h.poll(); await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "Interrupt");
    h.start("ses_two");
    h.ctx.session.active = async () => { throw new Error("disconnected"); };
    h.poll(); await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "PreToolUse");
  } finally { await h.cleanup(); }
});

test("a delayed activity reply cannot idle a newer turn", async () => {
  const h = await harness();
  try {
    h.start("ses_one");
    let reply;
    h.ctx.session.active = () => new Promise(resolve => { reply = resolve; });
    h.poll();
    h.start("ses_one");
    reply({}); await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "PreToolUse");
  } finally { await h.cleanup(); }
});

test("terminal events clear pre-reload activity even when this plugin never saw its start", async () => {
  const h = await harness();
  try {
    h.event("session.execution.interrupted", "ses_before_reload");
    await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "Interrupt");
    assert.equal(h.sent.at(-1).session_id, "ses_before_reload");
  } finally { await h.cleanup(); }
});

test("plugin cleanup withdraws owned sessions and stale hook callbacks cannot revive them", async () => {
  const h = await harness();
  h.start("ses_shutdown");
  await h.flush();
  const before = h.hooks.get("tool.execute.before");
  const after = h.hooks.get("tool.execute.after");
  await h.cleanup();
  await h.flush();
  assert.equal(h.sent.at(-1).hook_event_name, "Interrupt");
  const count = h.sent.length;
  before({ sessionID: "ses_shutdown", tool: "shell" });
  after({ sessionID: "ses_shutdown", tool: "shell" });
  await h.flush();
  assert.equal(h.sent.length, count);
});

test("activity checks never accumulate while an earlier request is stuck", async () => {
  const h = await harness();
  try {
    h.start("ses_one");
    let answer, count = 0;
    h.ctx.session.active = () => { count++; return new Promise(resolve => { answer = resolve; }); };
    h.poll(); h.poll(); h.poll();
    assert.equal(count, 1);
    answer({}); await h.flush();
    assert.equal(h.sent.at(-1).hook_event_name, "Interrupt");
  } finally { await h.cleanup(); }
});

test("all concurrent plugin sessions reach terminal state in the island registry", async () => {
  const h = await harness();
  const registry = new AgentSessions();
  let disposed = false;
  try {
    h.start("ses_first"); h.start("ses_second");
    h.event("session.execution.succeeded", "ses_first");
    await h.flush();
    for (const payload of h.sent.splice(0)) registry.observe("opencode", payload.session_id, payload.hook_event_name, payload.cwd);
    assert.equal(registry.remaining("opencode").id, "ses_second");
    await h.cleanup(); disposed = true; await h.flush();
    for (const payload of h.sent) registry.observe("opencode", payload.session_id, payload.hook_event_name, payload.cwd);
    assert.equal(registry.remaining("opencode"), undefined);
  } finally { if (!disposed) await h.cleanup(); }
});
