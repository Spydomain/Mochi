import { test } from "node:test";
import assert from "node:assert/strict";

const { danceBpm } = await import("../src/core/music-mood.ts");

test("player BPM takes priority, with safe genre-based visual pacing", () => {
  assert.equal(danceBpm(145, "ambient"), 145);
  assert.equal(danceBpm(0, "ambient"), 76);
  assert.equal(danceBpm(null, "jazz"), 92);
  assert.equal(danceBpm(undefined, "drum and bass"), 160);
  assert.equal(danceBpm(999, "house"), 130);
});
