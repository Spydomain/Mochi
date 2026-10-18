import { test } from "node:test";
import assert from "node:assert/strict";
import { AIRDROP_COMPACT_W, AIRDROP_COMPACT_H, COMPACT_W, NOTCH_H,
  PANEL_W, VIEW_LAYOUTS, islandSize } from "../src/core/layout.ts";
import { installFakeDom } from "./fakedom.mjs";
import { State } from "../src/core/state.ts";
import { airDropPanelHeight } from "../src/views/airdrop.ts";

installFakeDom();
const { Island } = await import("../src/island/island.ts");

test("AirDrop starts at normal size and grows only to fit measured content, with bounded overflow", () => {
  assert.equal(VIEW_LAYOUTS.airdrop.height, VIEW_LAYOUTS.overview.height);
  assert.equal(airDropPanelHeight(20, 70), 160);
  assert.equal(airDropPanelHeight(24, 140), 212);
  assert.equal(airDropPanelHeight(24, 1000), 300);
  assert.equal(airDropPanelHeight(NaN, 70), 160);
  assert.equal(airDropPanelHeight(20, 70), 160, "the card shrinks again after results/errors disappear");
});

test("only compact AirDrop transfer sessions use the smaller strip", () => {
  for (const view of Object.keys(VIEW_LAYOUTS)) {
    assert.deepEqual(islandSize("compact", view), { w: COMPACT_W, h: NOTCH_H });
    assert.deepEqual(islandSize("compact", view, 0, true),
      { w: AIRDROP_COMPACT_W, h: AIRDROP_COMPACT_H });
    for (const mode of ["hidden", "expanded"]) {
      assert.deepEqual(islandSize(mode, view, 3, true), islandSize(mode, view, 3),
        `${mode} ${view} must not change for AirDrop sessions`);
    }
  }
  assert.equal(AIRDROP_COMPACT_W, 160);
  assert.equal(AIRDROP_COMPACT_H, 24);
  assert.ok(AIRDROP_COMPACT_W < COMPACT_W);
  assert.ok(AIRDROP_COMPACT_H < NOTCH_H);
  assert.equal((PANEL_W - AIRDROP_COMPACT_W) / 2, 280, "native input rect remains centered");
});

test("a transfer starting or ending while compact animates to the appropriate size once", () => {
  const previous = { mode: State.mode, view: State.view, paused: State.paused,
    airdropTransfer: State.airdropTransfer };
  try {
    State.mode = "compact";
    State.view = "overview";
    State.paused = false;
    State.airdropTransfer = null;
    const animations = [];
    const host = { airDropCompactActive: false, fsm: { state: "petit" },
      animateGeometry: shrinking => animations.push(shrinking) };
    const sync = () => Island.prototype.syncAirDropTransfer.call(host);
    sync();
    State.airdropTransfer = "receiving";
    sync();
    assert.equal(host.fsm.keepCompact, true);
    assert.deepEqual(animations, [true]);
    State.airdropTransfer = "complete";
    sync();
    assert.deepEqual(animations, [true], "progress/status polling must not restart animation");
    State.airdropTransfer = null;
    sync();
    assert.equal(host.fsm.keepCompact, false);
    assert.deepEqual(animations, [true, false]);
    State.mode = "expanded";
    State.airdropTransfer = "receiving";
    sync();
    assert.deepEqual(animations, [true, false], "expanded cards retain their geometry");
  } finally { Object.assign(State, previous); }
});
