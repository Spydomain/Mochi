import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { miniBotVisible } = await import("../src/mochi/minibots.ts");

test("mini Mochis are painted only in their visible capsule mode", () => {
  assert.equal(miniBotVisible("compact", true, false), true);
  assert.equal(miniBotVisible("compact", false, true), false);
  assert.equal(miniBotVisible("expanded", true, false), false);
  assert.equal(miniBotVisible("expanded", false, true), true);
  assert.equal(miniBotVisible("expanded", false, false), false);
  assert.equal(miniBotVisible("hidden", true, true), false);
});
