import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/core/bridge.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { emit } from "./tauri.mjs";

let recover, asked;
const task = () => State.tasks.find(task => task.id === "agent_opencode");
const settle = () => new Promise(setImmediate);
const hook = (event, id, extra = {}) => emit("hook", {
  mochi_agent: "opencode", hook_event_name: event, session_id: id, cwd: "/project", ...extra,
});

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  State.tasks = [];
  State.agentSessions.clear();
  State.settings = { ...DEFAULT_SETTINGS };
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.pendingApproval = null;
  State.loadIntegrationTasks();
  asked = [];
  recover = registerHookHandlers({
    reveal: () => asked.push("reveal"), alert() {}, setView() {}, dropPin() {},
  });
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
  mock.restoreAll();
});

test("restart discovers already-running OpenCode sessions across project directories", async () => {
  mock.method(Bridge, "opencodeActiveSessions", async () => [
    { id: "ses_one", cwd: "/first" }, { id: "ses_two", cwd: "/second" },
  ]);
  await recover();
  assert.equal(task().state, "thinking");
  assert.equal(task().sessionId, "ses_two");
  assert.equal(task().sessionCwd, "/second");
  assert.ok(asked.includes("reveal"));
  hook("Stop", "ses_two");
  assert.equal(task().sessionId, "ses_one", "finishing one recovered session keeps the other active");
  assert.equal(task().sessionCwd, "/first");
  hook("Interrupt", "ses_one");
  assert.equal(task().state, "idle");
});

test("an empty active snapshot does not revive saved or completed sessions", async () => {
  mock.method(Bridge, "opencodeActiveSessions", async () => []);
  await recover();
  assert.equal(task(), undefined);
  assert.deepEqual(asked, []);
});

test("a stop arriving during startup lookup wins over the old snapshot", async () => {
  let reply;
  mock.method(Bridge, "opencodeActiveSessions", () => new Promise(resolve => { reply = resolve; }));
  const pending = recover();
  await settle();
  hook("Interrupt", "ses_done");
  reply([{ id: "ses_done", cwd: "/old" }]);
  await pending;
  assert.equal(task(), undefined);
  assert.equal(State.agentSessions.remaining("agent_opencode"), undefined);
  assert.deepEqual(asked, []);
});

test("startup lookup never overwrites newer live tool state or its directory", async () => {
  let reply;
  mock.method(Bridge, "opencodeActiveSessions", () => new Promise(resolve => { reply = resolve; }));
  const pending = recover();
  await settle();
  hook("PreToolUse", "ses_live", { cwd: "/new", tool_name: "Read", tool_input: { path: "/new/file" } });
  const steps = [...task().steps];
  reply([{ id: "ses_live", cwd: "/old" }]);
  await pending;
  assert.equal(task().state, "working");
  assert.equal(task().sessionCwd, "/new");
  assert.deepEqual(task().steps, steps);
});

test("startup retries a temporarily unavailable service without needing a new hook", async () => {
  let reads = 0;
  mock.method(Bridge, "opencodeActiveSessions", async () => ++reads === 1 ? null : [{ id: "ses_live", cwd: "/project" }]);
  const pending = recover();
  await settle();
  assert.equal(reads, 1);
  mock.timers.tick(1_000);
  await pending;
  assert.equal(reads, 2);
  assert.equal(task().sessionId, "ses_live");
});

test("a paused island does not reveal recovered work", async () => {
  State.paused = true;
  mock.method(Bridge, "opencodeActiveSessions", async () => [{ id: "ses_live", cwd: "/project" }]);
  await recover();
  assert.equal(task(), undefined);
  assert.deepEqual(asked, []);
});
