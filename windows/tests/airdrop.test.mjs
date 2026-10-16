import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installFakeDom } from "./fakedom.mjs";
import { calls, internals } from "./tauri.mjs";
import { State, DEFAULT_SETTINGS } from "../src/core/state.ts";
import { buildHeader } from "../src/views/views.ts";
import { AIRDROP_AUTO_CLOSE_MS, buildAirDropCompactStatus, buildAirDropView, buildAirDropRequest, refreshAirDrop, refreshAirDropPeers, toggleAirDrop } from "../src/views/airdrop.ts";
import { islandSize } from "../src/core/layout.ts";

installFakeDom();

function reset() {
  State.settings = { ...DEFAULT_SETTINGS };
  State.os = "linux";
  State.mode = "expanded";
  State.view = "overview";
  State.airdropStatus = { installed: true, receiving: false, visible: false, name: null,
    remaining: null, directory: null, canSendNearby: false, message: null };
  State.airdropPeers = [];
  State.airdropPending = false;
  State.airdropProgress = null;
  State.airdropScanning = false;
  State.airdropSending = false;
  State.airdropError = "";
  State.airdropNotice = "";
  State.airdropDeciding = false;
  State.airdropRequest = null;
  State.airdropAnsweredId = null;
  calls.length = 0;
}

test("AirDrop status polling redraws only when status changes", async () => {
  reset();
  const original = internals.invoke;
  let status = { ...State.airdropStatus };
  let redraws = 0;
  const unsubscribe = State.subscribe(() => { redraws += 1; });
  internals.invoke = async (cmd) => cmd === "airdrop_status" ? { ...status } : null;
  try {
    await refreshAirDrop();
    assert.equal(redraws, 0);
    status = { ...status, receiving: true, visible: true };
    await refreshAirDrop();
    await refreshAirDrop();
    assert.equal(redraws, 1);
  } finally {
    unsubscribe();
    internals.invoke = original;
  }
});

test("AirDrop pill opens its own island view and the off state loses its highlight", async () => {
  reset();
  const original = internals.invoke;
  const opened = [];
  internals.invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "airdrop_set") return { ...State.airdropStatus, receiving: args.enabled, visible: args.enabled };
    return null;
  };
  try {
    const header = buildHeader({ setView: v => opened.push(v), blip: () => {} });
    const view = buildAirDropView(() => {}, () => {});
    header.sync();
    const pill = header.el.querySelector(".airdrop-pill");
    pill.fire("click");
    assert.deepEqual(opened, ["airdrop"]);
    assert.equal(header.el.querySelector(".airdrop-panel"), null);
    view.sync();
    view.el.querySelector(".airdrop-view-power").fire("click");
    await new Promise(setImmediate);
    header.sync();
    assert.equal(pill.getAttribute("aria-pressed"), "true");
    view.sync();
    view.el.querySelector(".airdrop-view-power").fire("click");
    await new Promise(setImmediate);
    header.sync();
    assert.equal(pill.getAttribute("aria-pressed"), "false");
    assert.equal(pill.classList.contains("failed"), false);
    assert.deepEqual(calls.filter(([cmd]) => cmd === "airdrop_set").map(([, args]) => args.enabled), [true, false]);
  } finally { internals.invoke = original; }
});

test("AirDrop compact view only enables sending to a named phone", async () => {
  reset();
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  const original = internals.invoke;
  internals.invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "airdrop_peers") return [{ mac: "aabbccddeeff", name: args.named ? "My iPhone" : null, rssi: null }];
    if (cmd === "airdrop_send") return "Transfer complete";
    return null;
  };
  try {
    const view = buildAirDropView(() => {}, () => {});
    view.sync();
    assert.match(view.el.textContent, /AirDrop/);
    await refreshAirDropPeers();
    view.sync();
    assert.equal(view.el.querySelector(".airdrop-view-send").getAttribute("disabled"), "");
    await refreshAirDropPeers(true);
    view.sync();
    view.el.querySelector(".airdrop-view-send").fire("click");
    await new Promise(setImmediate);
    assert.deepEqual(calls.filter(([cmd]) => cmd === "airdrop_send").map(([, args]) => args.mac), ["aabbccddeeff"]);
  } finally { internals.invoke = original; }
});

test("AirDrop reports its radio starting immediately", () => {
  reset();
  State.airdropPending = true;
  const view = buildAirDropView(() => {}, () => {});
  view.sync();
  assert.match(view.el.textContent, /Starting AirDrop radio/);
  assert.match(view.el.querySelector(".airdrop-view-power").textContent, /Turning on/);
});

test("a restarted app displays the live receiver folder, never invents Downloads", () => {
  reset();
  State.settings.airdropDirectory = "/user/selected/folder";
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true,
    directory: "/receiver/actual/folder" };
  const view = buildAirDropView(() => {}, () => {});
  view.sync();
  assert.match(view.el.textContent, /Saves to \/receiver\/actual\/folder/);
  assert.doesNotMatch(view.el.textContent, /Saves to \/user\/selected\/folder/);
  State.airdropStatus = { ...State.airdropStatus, directory: null };
  view.sync();
  assert.match(view.el.textContent, /Configured save folder: \/user\/selected\/folder/);
  assert.match(view.el.textContent, /destination unverified/);
});

test("AirDrop compact ring uses measured upload bytes, never fabricated progress", () => {
  reset();
  const indicator = buildAirDropCompactStatus();
  const glyph = indicator.el.querySelector(".airdrop-compact-icon");
  const ring = indicator.el.querySelector(".airdrop-ring");
  assert.equal(glyph.find("svg").length, 1);
  assert.ok(ring);
  assert.deepEqual(islandSize("compact", "overview"), { w: 288, h: 32 });

  indicator.sync("compact", null);
  assert.equal(indicator.el.style.display, "none", "an idle radio is not a transfer");
  indicator.sync("compact", "waiting");
  assert.equal(indicator.el.style.display, "flex");
  assert.equal(indicator.el.getAttribute("aria-label"), "Waiting for an AirDrop file");
  assert.equal(indicator.el.getAttribute("aria-valuenow"), null, "no guessed percentage");
  indicator.sync("compact", "receiving");
  assert.equal(indicator.el.classList.contains("receiving"), true);
  assert.equal(indicator.el.getAttribute("aria-label"), "Receiving an AirDrop file");
  indicator.sync("compact", "receiving", { receivedBytes: 25, totalBytes: 100 });
  assert.equal(indicator.el.classList.contains("determinate"), true);
  assert.equal(indicator.el.style["--airdrop-progress"], "25%");
  assert.match(indicator.el.getAttribute("aria-label"), /25%/);
  indicator.sync("compact", "receiving", { receivedBytes: 75, totalBytes: 100 });
  assert.equal(indicator.el.style["--airdrop-progress"], "75%");
  indicator.sync("compact", "receiving", { receivedBytes: 101, totalBytes: 100 });
  assert.equal(indicator.el.style["--airdrop-progress"], "99%", "only verified success reaches 100%");
  indicator.sync("compact", "receiving", { receivedBytes: null, totalBytes: 100 });
  assert.equal(indicator.el.classList.contains("determinate"), false);
  assert.equal(indicator.el.getAttribute("aria-valuenow"), null);
  // A real iOS 26 dvzip transfer: the ring must move, not spin forever. This
  // regressed once because the declared total was suppressed for dvzip.
  indicator.sync("compact", "receiving", { receivedBytes: 16_286_916, totalBytes: 456_877_337 });
  assert.equal(indicator.el.classList.contains("determinate"), true, "dvzip still reports measured progress");
  assert.equal(indicator.el.style["--airdrop-progress"], "3%", "3.4% of a stalled 457 MB transfer rounds to 3%");
  // A stalled transfer never claims to be finished before it is verified.
  indicator.sync("compact", "receiving", { receivedBytes: 456_800_000, totalBytes: 456_877_337 });
  assert.equal(indicator.el.style["--airdrop-progress"], "99%");
  indicator.sync("compact", "complete");
  assert.equal(indicator.el.classList.contains("complete"), true);
  assert.equal(indicator.el.classList.contains("receiving"), false);
  indicator.sync("compact", "failed");
  assert.equal(indicator.el.classList.contains("failed"), true);
  assert.equal(indicator.el.getAttribute("aria-label"), "AirDrop transfer incomplete; try again");
  indicator.sync("expanded", "receiving");
  assert.equal(indicator.el.style.display, "none");
  indicator.sync("hidden", "receiving");
  assert.equal(indicator.el.style.display, "none");
});

test("AirDrop stays visible while its radio is starting, then starts a fresh dismissal timer", () => {
  reset();
  State.view = "airdrop";
  const originalTimeout = window.setTimeout;
  const originalClear = window.clearTimeout;
  const timers = [];
  window.setTimeout = (callback, delay) => { timers.push({ callback, delay, cleared: false }); return timers.length; };
  window.clearTimeout = (id) => { timers[id - 1].cleared = true; };
  try {
    const returned = [];
    const view = buildAirDropView(() => {}, () => returned.push("overview"));
    view.sync();
    assert.equal(timers.length, 1);
    State.airdropPending = true;
    view.sync();
    assert.equal(timers[0].cleared, true);
    State.airdropPending = false;
    State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
    view.sync();
    assert.equal(timers.length, 2);
    assert.equal(timers[1].delay, AIRDROP_AUTO_CLOSE_MS);
    timers[1].callback();
    assert.deepEqual(returned, ["overview"]);
  } finally {
    window.setTimeout = originalTimeout;
    window.clearTimeout = originalClear;
  }
});

test("turning on stays off until verification and ignores a stale status poll", async () => {
  reset();
  const original = internals.invoke;
  let resolveSet;
  let resolveOldPoll;
  internals.invoke = (cmd, args) => {
    if (cmd === "airdrop_status") return new Promise(resolve => { resolveOldPoll = resolve; });
    if (cmd === "airdrop_set") {
      assert.equal(args.enabled, true);
      return new Promise(resolve => { resolveSet = resolve; });
    }
    return Promise.resolve(null);
  };
  try {
    const header = buildHeader({});
    const pill = header.el.querySelector(".airdrop-pill");
    const poll = refreshAirDrop();
    const toggle = toggleAirDrop();
    header.sync();
    assert.equal(State.airdropPending, true);
    assert.equal(pill.getAttribute("aria-pressed"), "false");
    assert.match(pill.title, /turning on/);

    resolveSet({ ...State.airdropStatus, receiving: true, visible: true });
    await toggle;
    header.sync();
    assert.equal(pill.getAttribute("aria-pressed"), "true");

    resolveOldPoll({ ...State.airdropStatus, receiving: false, visible: false });
    await poll;
    header.sync();
    assert.equal(pill.getAttribute("aria-pressed"), "true");
  } finally { internals.invoke = original; }
});

test("AirDrop detail has no close button and stays open while hovered", () => {
  reset();
  State.view = "airdrop";
  let timer = null;
  const originalTimeout = window.setTimeout;
  window.setTimeout = (callback, delay) => { timer = { callback, delay }; return 1; };
  try {
    const returned = [];
    const view = buildAirDropView(() => {}, () => returned.push("overview"));
    view.sync();
    assert.equal(view.el.querySelector(".airdrop-view-close"), null);
    assert.equal(timer.delay, AIRDROP_AUTO_CLOSE_MS);
    view.el.fire("mouseenter");
    timer.callback();
    assert.deepEqual(returned, []);
    view.el.fire("mouseleave");
    assert.deepEqual(returned, ["overview"]);
  } finally {
    window.setTimeout = originalTimeout;
  }
});

test("incoming consent shows sender and requires explicit answer for the matching request", async () => {
  reset();
  State.airdropRequest = { id: "f".repeat(32), sender: "Nearby iPhone", detail: "Photo.JPG" };
  const original = internals.invoke;
  internals.invoke = async (cmd, args) => { calls.push([cmd, args]); return null; };
  try {
    const view = buildAirDropRequest();
    view.sync();
    assert.match(view.el.textContent, /Nearby iPhone/);
    assert.match(view.el.textContent, /Photo.JPG/);
    view.el.querySelector(".airdrop-accept").fire("click");
    await new Promise(setImmediate);
    assert.equal(calls.length, 0, "a click under the new card cannot accept");
    // The guard is wall-clock based, not the arbitrary fake DOM render timing.
    const now = performance.now;
    performance.now = () => now.call(performance) + 650;
    try {
      view.el.querySelector(".airdrop-decline").fire("click");
      await new Promise(setImmediate);
    } finally { performance.now = now; }
    assert.deepEqual(calls, [["airdrop_decide", { id: "f".repeat(32), accept: false }]]);
    assert.equal(State.airdropRequest, null);
  } finally { internals.invoke = original; }
});

test("consent gets a native wake event and an independent fallback poll, never behind transfer reads", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  // A hidden WebKit page may throttle timers. Rust watches the request file
  // and emits an event; the fallback also covers startup and missed events.
  const consent = source.slice(
    source.indexOf("const checkIncoming = () => {"),
    source.indexOf("window.setInterval(() => {\n    if (State.os !== \"linux\" || checkingTransfer)"),
  );
  assert.ok(consent.length > 500, "consent callback must be independent");
  assert.match(consent, /checkingIncoming = false;/);
  assert.match(consent, /onEvent<null>\("airdrop-incoming", checkIncoming\)/);
  assert.match(consent, /window\.setInterval\(checkIncoming, 200\)/);
  assert.match(consent, /island\.alert\("airdropRequest"\)/);
  assert.doesNotMatch(consent, /if \(!State\.airdropStatus\?\.receiving\)|lastTransferCheck|Bridge\.airdropTransfer/);
});

test("the consent card is released as soon as the request file is gone", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  // A decline clears State.airdropRequest inside decide() before the file is
  // observed. Keying the release on a *changed* request id never fired, and
  // the pinned island stayed open on a dead card for the rest of the session.
  const start = source.indexOf("const request = pending?.id === State.airdropAnsweredId");
  const consent = source.slice(start, source.indexOf("checkingIncoming = false;", start));
  assert.match(consent, /else if \(State\.airdropRequest \|\| State\.view === "airdropRequest"\)/);
  assert.match(consent, /island\.finishAirDropRequest\(\)/);
  // The release must not depend on the request id differing.
  assert.doesNotMatch(consent, /hadRequest/);
});

test("incoming consent preempts a busy or hover-open island and restores the prior approval", async () => {
  const { Island } = await import("../src/island/island.ts");
  const { IslandStateMachine } = await import("../src/island/fsm.ts");
  reset();
  State.mode = "hidden";
  State.view = "approval";
  State.airdropRequest = { id: "f".repeat(32), sender: "Nearby iPhone", detail: "Photo" };
  State.pendingApproval = { questions: null };
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.setMode = mode => { State.mode = mode; };
  island.animateGeometry = () => {};
  island.noticeTimer = null;
  island.noticeActive = false;
  island.notice = { classList: { remove() {} } };
  island.root = { classList: { remove() {} } };
  island.powerActive = false;
  island.wasInIsland = true;
  try {
    island.alert("overview");
    assert.equal(State.mode, "expanded", "the prompt opens from a long-hidden island");
    assert.equal(State.view, "airdropRequest");
    assert.equal(island.fsm.pinned, true);
    island.setView("finished");
    assert.equal(State.view, "airdropRequest", "other agent events cannot hide consent");
    island.collapse();
    assert.equal(State.view, "airdropRequest");
    State.airdropRequest = null;
    island.finishAirDropRequest();
    assert.equal(State.view, "approval");
    assert.equal(island.fsm.pinned, true);
  } finally {
    State.airdropRequest = null;
    State.pendingApproval = null;
    State.mode = "hidden";
    State.view = "overview";
  }
});

test("finishing a request always unpins the island when nothing is waiting", async () => {
  const { Island } = await import("../src/island/island.ts");
  const { IslandStateMachine } = await import("../src/island/fsm.ts");
  reset();
  State.mode = "expanded";
  State.view = "airdropRequest";
  State.airdropRequest = null;
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.pinned = true;
  island.animateGeometry = () => {};
  island.wasInIsland = false;
  State.pendingApproval = null;
  try {
    island.finishAirDropRequest();
    assert.equal(island.fsm.pinned, false, "a finished consent must not keep the bar pinned open");
    assert.notEqual(State.view, "airdropRequest", "the dead consent card must be left");
  } finally {
    State.mode = "hidden";
    State.view = "overview";
  }
});
