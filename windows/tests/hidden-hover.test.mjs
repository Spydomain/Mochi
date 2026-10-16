import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { Island } = await import("../src/island/island.ts");
const { IslandStateMachine } = await import("../src/island/fsm.ts");
const { State } = await import("../src/core/state.ts");
let previousMode;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  previousMode = State.mode;
});
afterEach(() => {
  State.mode = previousMode;
  mock.timers.reset();
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
