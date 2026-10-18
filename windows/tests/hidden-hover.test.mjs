import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { Island } = await import("../src/island/island.ts");
const { IslandStateMachine } = await import("../src/island/fsm.ts");
const { State } = await import("../src/core/state.ts");
let previousMode;
let previousView;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  previousMode = State.mode;
  previousView = State.view;
});
afterEach(() => {
  State.mode = previousMode;
  State.view = previousView;
  State.airdropTransfer = null;
  State.paused = false;
  mock.timers.reset();
});

test("AirDrop progress wakes and holds compact, but idle radio and pause do not", () => {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  State.mode = "hidden";
  State.airdropTransfer = null;
  State.paused = false;
  island.syncAirDropTransfer();
  assert.equal(island.fsm.state, "hidden");
  State.airdropTransfer = "receiving";
  island.syncAirDropTransfer();
  assert.equal(island.fsm.state, "petit");
  mock.timers.tick(60_000);
  assert.equal(island.fsm.state, "petit");
  State.airdropTransfer = "complete";
  island.syncAirDropTransfer();
  mock.timers.tick(5_000);
  assert.equal(island.fsm.state, "petit");
  State.airdropTransfer = null;
  island.syncAirDropTransfer();
  mock.timers.tick(2_000);
  assert.equal(island.fsm.state, "hidden");
  State.paused = true;
  State.airdropTransfer = "receiving";
  island.syncAirDropTransfer();
  assert.equal(island.fsm.state, "hidden");
});

test("compositor enter after an idle wake cancels a stale leave countdown", () => {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.pointerInside = false;
  island.wasInIsland = false;
  State.mode = "expanded";

  island.fsm.mouseEntered();
  island.fsm.mouseLeft();
  island.setPointerInside(true);
  assert.equal(island.wasInIsland, true);
  mock.timers.tick(1_000);
  assert.equal(island.fsm.state, "home");
});

test("compositor leave reaches AirDrop without requiring another mousemove", () => {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  const hover = [];
  island.views = new Map([["airdrop", { pointerInside: inside => hover.push(inside) }]]);
  State.mode = "expanded";
  State.view = "airdrop";
  island.pointerInside = true;
  island.setPointerInside(false);
  assert.deepEqual(hover, [false]);
});

test("a long-hidden island wakes from a mousemove despite the parked compositor's stale outside report", () => {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.pointerInside = false;
  island.wasInIsland = false;
  island.botHovering = false;
  island.islandRect = () => ({ x: 268, y: 0, w: 184, h: 32 });
  island.isBotHit = () => false;
  island.ensureRunning = () => {};
  State.mode = "hidden";
  island.onCursor(330, 7);
  assert.equal(island.fsm.state, "home", "the center of the hidden strip must wake on hover");
  assert.equal(island.wasInIsland, true);

  // After opening, the compositor watch resumes; its live outside report still
  // rejects a late WebKit mousemove rather than pinning the island open.
  State.mode = "expanded";
  island.wasInIsland = false;
  island.onCursor(330, 7);
  assert.equal(island.wasInIsland, false);
});
