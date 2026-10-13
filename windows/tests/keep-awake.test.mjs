import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";
import { calls, internals } from "./tauri.mjs";
import { State, DEFAULT_SETTINGS } from "../src/core/state.ts";
import { buildHeader } from "../src/views/views.ts";

installFakeDom();

test("Awake button follows the Codex badge and releases the system policy on click", async () => {
  const originalInvoke = internals.invoke;
  State.settings = { ...DEFAULT_SETTINGS, showCodexPlanInNotch: true };
  State.view = "overview";
  State.os = "linux";
  State.keepAwake = false;
  State.keepAwakePending = false;
  State.keepAwakeError = "";
  internals.invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "set_keep_awake") return args.enabled;
    return null;
  };
  try {
    const header = buildHeader({});
    const button = header.el.querySelector(".keep-awake-pill");
    header.sync();
    assert.equal(button.style.display, "");
    assert.equal(button.getAttribute("aria-pressed"), "false");

    button.fire("click");
    await new Promise(setImmediate);
    header.sync();
    assert.equal(State.keepAwake, true);
    assert.equal(button.getAttribute("aria-pressed"), "true");

    // The switch remains accessible if the Codex plan badge is later hidden.
    State.settings.showCodexPlanInNotch = false;
    header.sync();
    assert.equal(button.style.display, "");
    button.fire("click");
    await new Promise(setImmediate);
    header.sync();
    assert.equal(State.keepAwake, false);
    assert.equal(button.style.display, "none");
    assert.deepEqual(calls.filter(([cmd]) => cmd === "set_keep_awake").map(([, args]) => args.enabled), [true, false]);
  } finally {
    internals.invoke = originalInvoke;
  }
});

test("a failed inhibition request leaves the switch off and reports the failure", async () => {
  const originalInvoke = internals.invoke;
  State.settings = { ...DEFAULT_SETTINGS, showCodexPlanInNotch: true };
  State.view = "overview";
  State.os = "linux";
  State.keepAwake = false;
  State.keepAwakePending = false;
  State.keepAwakeError = "";
  internals.invoke = async (cmd) => {
    if (cmd === "set_keep_awake") throw new Error("No desktop inhibitor");
    return null;
  };
  try {
    const header = buildHeader({});
    const button = header.el.querySelector(".keep-awake-pill");
    header.sync();
    button.fire("click");
    await new Promise(setImmediate);
    header.sync();
    assert.equal(State.keepAwake, false);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.match(button.title, /No desktop inhibitor/);
    assert.match(button.textContent, /Unavailable/);
  } finally {
    internals.invoke = originalInvoke;
  }
});
