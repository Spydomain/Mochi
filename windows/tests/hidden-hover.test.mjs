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
  const island = hoverIsland();
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
  island.islandRect = () => ({ x: 268, y: 0, w: 184, h: 0 });
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

function hoverIsland() {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.pointerInside = false;
  island.wasInIsland = false;
  island.botHovering = false;
  island.islandRect = () => ({ x: 268, y: 0, w: 184, h: 0 });
  island.isBotHit = () => false;
  island.ensureRunning = () => {};
  island.fsm.onTransition = (_from, to) => {
    State.mode = to === "home" ? "expanded" : to === "petit" ? "compact" : "hidden";
    if (to === "petit" && !island.wasInIsland) island.fsm.mouseLeft();
  };
  State.mode = "hidden";
  State.view = "overview";
  return island;
}

test("the full invisible wake strip works with a zero-height hidden island", () => {
  for (const x of [241, 330, 479]) {
    const island = hoverIsland();
    island.onCursor(x, 8);
    assert.equal(island.fsm.state, "home", `wake at x=${x}`);
    assert.equal(island.wasInIsland, true);
  }
  for (const [x, y] of [[239, 8], [481, 8], [360, 17]]) {
    const island = hoverIsland();
    island.onCursor(x, y);
    assert.equal(island.fsm.state, "hidden");
  }
});

test("compositor enter wakes even when WebKit misses the strip's mouseenter", () => {
  const island = hoverIsland();
  island.setPointerInside(true);
  assert.equal(island.fsm.state, "home");
  assert.equal(island.wasInIsland, true);
});

test("native input keeps the wake area reachable before the opening animation grows", () => {
  const island = hoverIsland();
  assert.deepEqual(island.inputRect(), { x: 240, y: 0, w: 240, h: 16 });
  island.onCursor(241, 8);
  const input = island.inputRect();
  assert.ok(input.x <= 241 && input.x + input.w >= 241);
  assert.ok(input.h >= 16);
  // Once settled, compact input retains its original, narrow shape.
  State.mode = "compact";
  island.islandRect = () => ({ x: 216, y: 0, w: 288, h: 32 });
  assert.deepEqual(island.inputRect(), island.islandRect());
});

test("a quick wake and leave before the native watch's first tick still closes", () => {
  const island = hoverIsland();
  island.onCursor(360, 8);
  // No native enter was observed between restarting the watch and leaving.
  island.setPointerInside(false);
  mock.timers.tick(600);
  assert.equal(island.fsm.state, "petit");
  mock.timers.tick(2_000);
  assert.equal(island.fsm.state, "hidden");
});

test("hover remains inside while the island springs open, then leaves without another mousemove", () => {
  const island = hoverIsland();
  island.onCursor(241, 8);
  island.setPointerInside(true);
  // The visual geometry has not grown yet, but the pointer is still in the strip.
  island.onCursor(241, 9);
  mock.timers.tick(1_000);
  assert.equal(island.fsm.state, "home");
  assert.equal(island.wasInIsland, true);

  island.setPointerInside(false);
  assert.equal(island.wasInIsland, false);
  mock.timers.tick(600);
  assert.equal(island.fsm.state, "petit");
  mock.timers.tick(2_000);
  assert.equal(island.fsm.state, "hidden");
});

test("repeated idle hover cycles neither stick open nor lose the wake area", () => {
  const island = hoverIsland();
  for (let cycle = 0; cycle < 5; cycle++) {
    island.onCursor(360, 8);
    island.setPointerInside(true);
    island.onCursor(360, 9);
    assert.equal(island.fsm.state, "home");
    island.setPointerInside(false);
    // A queued WebKit move after a real leave must not reopen the island.
    island.onCursor(360, 9);
    mock.timers.tick(600);
    assert.equal(island.fsm.state, "petit");
    mock.timers.tick(2_000);
    assert.equal(island.fsm.state, "hidden");
    mock.timers.tick(60_000);
  }
});
