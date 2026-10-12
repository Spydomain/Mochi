import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { Island } = await import("../src/island/island.ts");
const { State } = await import("../src/core/state.ts");

test("a wellbeing notice opens the capsule, stays inside, and resumes auto-close", () => {
  const island = Object.create(Island.prototype);
  island.root = document.createElement("div");
  island.notice = document.createElement("div");
  island.clipEl = document.createElement("div");
  island.clipEl.append(island.notice);
  island.wasInIsland = false;
  island.ensureRunning = () => {};
  const events = [];
  island.fsm = { forceHome: () => events.push("open"), mouseLeft: () => events.push("auto-close") };
  State.paused = false;
  State.pendingApproval = null;
  const originalTimeout = window.setTimeout;
  let expire;
  window.setTimeout = (fn) => { expire = fn; return 1; };
  try {
    island.showNotice("Good night. Time to rest.");
    assert.equal(island.notice.parentElement, island.clipEl);
    assert.equal(island.notice.textContent, "Good night. Time to rest.");
    assert.equal(island.noticeActive, true);
    assert.ok(island.root.classList.contains("notice-active"));
    assert.deepEqual(events, ["open"]);
    expire();
    assert.equal(island.noticeActive, false);
    assert.ok(!island.root.classList.contains("notice-active"));
    assert.deepEqual(events, ["open", "auto-close"]);
  } finally {
    window.setTimeout = originalTimeout;
  }
});
