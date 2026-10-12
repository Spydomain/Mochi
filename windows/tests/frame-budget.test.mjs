import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { compactFrameDelay, compactMiniTasks } = await import("../src/island/island.ts");

test("compact mode caps redraws even with music or agent activity", () => {
  assert.equal(compactFrameDelay("compact", false), 66);
  assert.equal(compactFrameDelay("compact", false, true), 32);
  assert.equal(compactFrameDelay("compact", false, false, true), 100);
  assert.equal(compactFrameDelay("compact", false, true, true), 50);
  assert.equal(compactFrameDelay("compact", true), 0);
  assert.equal(compactFrameDelay("expanded", false), 0);
  assert.equal(compactFrameDelay("hidden", false), 0);
});

test("compact cluster keeps clock in one of four 2×2 slots", () => {
  const tasks = ["a", "b", "integration_clock", "c", "d"].map((id) => ({ id }));
  assert.deepEqual(compactMiniTasks(tasks).map((task) => task.id), ["a", "b", "integration_clock", "c"]);
});
