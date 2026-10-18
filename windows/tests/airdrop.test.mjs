import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installFakeDom } from "./fakedom.mjs";
import { calls, internals } from "./tauri.mjs";
import { State, DEFAULT_SETTINGS } from "../src/core/state.ts";
import { buildHeader } from "../src/views/views.ts";
import { AIRDROP_AUTO_CLOSE_MS, applyAirDropReceive, airDropActivity, buildAirDropCompactStatus, buildAirDropView, buildAirDropRequest, refreshAirDrop, refreshAirDropPeers, refreshAirDropActivity, sendAirDrop, toggleAirDrop, toggleAirDropDiscovery } from "../src/views/airdrop.ts";
import { islandSize } from "../src/core/layout.ts";
import { buildAirDropTransferProgress } from "../src/views/airdrop.ts";

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
  State.airdropReceiveDetail = null;
  State.airdropScanning = false;
  State.airdropSending = false;
  State.airdropDiscovering = false;
  State.airdropOutbound = null;
  State.airdropTransfer = null;
  State.airdropError = "";
  State.airdropReceiveError = "";
  State.airdropNotice = "";
  State.airdropDeciding = false;
  State.airdropRequest = null;
  State.airdropAnsweredId = null;
  calls.length = 0;
}

test("a later successful receive clears the old no-upload warning and gets its own completion display", () => {
  reset();
  const failed = { state: "failed", receivedBytes: null, totalBytes: null, message: "The upload has not reached Mochi after 90 seconds." };
  let completedAt = applyAirDropReceive(failed, 0, 10000);
  assert.match(State.airdropReceiveError, /90 seconds/);
  completedAt = applyAirDropReceive(failed, completedAt, 16000);
  assert.equal(State.airdropTransfer, null);
  completedAt = applyAirDropReceive({ state: "complete", receivedBytes: null, totalBytes: null }, completedAt, 17000);
  assert.equal(State.airdropReceiveError, "");
  assert.equal(State.airdropTransfer, "complete");
  assert.equal(completedAt, 17000);
  const view = buildAirDropView();
  view.sync();
  assert.doesNotMatch(view.el.textContent, /90 seconds/);
});

test("receiver-off or absent state clears receive warnings and stale progress, not unrelated errors", () => {
  reset();
  State.airdropError = "Unrelated outgoing failure";
  applyAirDropReceive({ state: "failed", receivedBytes: null, totalBytes: null, message: "Old receive warning" }, 0, 10000);
  assert.equal(State.airdropError, "Unrelated outgoing failure");
  applyAirDropReceive(null, 10000, 11000);
  assert.equal(State.airdropReceiveError, "");
  assert.equal(State.airdropReceiveDetail, null);
  assert.equal(State.airdropProgress, null);
  assert.equal(State.airdropError, "Unrelated outgoing failure");
});

test("a delayed upload supersedes the no-upload warning when it really starts", () => {
  reset();
  const completedAt = applyAirDropReceive({ state: "failed", receivedBytes: null, totalBytes: null }, 0, 10000);
  assert.ok(State.airdropReceiveError);
  assert.equal(applyAirDropReceive({ state: "receiving", receivedBytes: 42, totalBytes: 100 }, completedAt, 11000), 0);
  assert.equal(State.airdropReceiveError, "");
  assert.equal(State.airdropTransfer, "receiving");
  assert.equal(State.airdropProgress.receivedBytes, 42);
});

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

test("sending and receiving share one detailed progress bar, with receive bytes and speed", () => {
  reset();
  const view = buildAirDropTransferProgress();
  const bar = view.el.querySelector(".airdrop-transfer-bar");
  State.airdropTransfer = "receiving";
  State.airdropProgress = { receivedBytes: 500, totalBytes: 1000 };
  State.airdropReceiveDetail = { state: "receiving", receivedBytes: 500, totalBytes: 1000, wireBytes: 256, bytesPerSecond: 128 };
  view.sync();
  assert.equal(bar.getAttribute("value"), "50");
  assert.match(view.el.textContent, /Receiving from iPhone/);
  assert.match(view.el.textContent, /50% · 256 B · 128 B\/s/);
  State.airdropSending = true;
  State.airdropOutbound = { phase: "sending", sentBytes: 750, totalBytes: 1000, elapsedMs: 1000 };
  view.sync();
  assert.equal(bar.getAttribute("value"), "75");
  assert.match(view.el.textContent, /Sending bytes/);
  assert.equal(view.el.querySelector(".airdrop-transfer-bar"), bar, "same control in both directions");
});

test("unknown receive totals show measured bytes rather than fake percentages, then verify below 100%", () => {
  reset();
  const view = buildAirDropTransferProgress();
  const bar = view.el.querySelector(".airdrop-transfer-bar");
  State.airdropTransfer = "receiving";
  State.airdropProgress = { receivedBytes: 2048, totalBytes: null };
  State.airdropReceiveDetail = { state: "receiving", receivedBytes: 2048, totalBytes: null, wireBytes: 2048, bytesPerSecond: 1024 };
  view.sync();
  assert.equal(bar.getAttribute("value"), null);
  assert.match(view.el.textContent, /2.0 KiB · 1.0 KiB\/s/);
  assert.equal(view.el.textContent.includes("%"), false);
  const compact = buildAirDropCompactStatus();
  compact.sync("compact", "receiving", State.airdropProgress);
  assert.match(compact.el.textContent, /2.0 KiB/);
  State.airdropTransfer = "verifying";
  State.airdropProgress = { receivedBytes: 4096, totalBytes: 4096 };
  view.sync();
  assert.equal(bar.getAttribute("value"), "99");
  assert.match(view.el.textContent, /Verifying and saving/);
  State.airdropTransfer = "complete";
  view.sync();
  assert.equal(bar.getAttribute("value"), "100");
  assert.match(view.el.textContent, /Files saved/);
});

test("accepted requests explain delayed uploads and hide failure progress without stale send labels", () => {
  reset();
  const view = buildAirDropTransferProgress();
  const bar = view.el.querySelector(".airdrop-transfer-bar");
  State.airdropOutbound = { phase: "complete", sentBytes: 100, totalBytes: 100, elapsedMs: 1000 };
  State.airdropTransfer = "waiting";
  State.airdropReceiveDetail = { state: "waiting", receivedBytes: null, totalBytes: null,
    message: "Connection delayed · accepted, but no upload has reached Mochi yet." };
  view.sync();
  assert.match(view.el.textContent, /Connection delayed/);
  assert.equal(bar.getAttribute("value"), null);
  State.airdropOutbound = null;
  State.airdropTransfer = "failed";
  State.airdropReceiveDetail = { ...State.airdropReceiveDetail, state: "failed", message: "No file bytes were received for this request." };
  view.sync();
  assert.match(view.el.textContent, /No file bytes were received/);
  assert.equal(bar.style.display, "none");
  State.airdropTransfer = "receiving";
  view.sync();
  assert.match(view.el.textContent, /Receiving from iPhone/);
  assert.equal(view.el.textContent.includes("No file bytes"), false, "an old status cannot describe a new phase");
  assert.equal(bar.style.display, "");
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

test("AirDrop mouse-leave dismissal does not cancel radio startup", () => {
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
    assert.equal(timers[0].cleared, false, "startup must not pin the card open");
    State.airdropPending = false;
    State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
    view.sync();
    assert.equal(timers.length, 1, "polls must not keep restarting dismissal");
    view.el.fire("mouseleave");
    assert.deepEqual(returned, []);
    timers.at(-1).callback();
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

test("AirDrop stays open while hovered and folds shortly after leaving or closes with Done", () => {
  reset();
  State.view = "airdrop";
  let timer = null;
  const originalTimeout = window.setTimeout;
  window.setTimeout = (callback, delay) => { timer = { callback, delay }; return 1; };
  try {
    const returned = [];
    const view = buildAirDropView(() => {}, () => returned.push("overview"));
    view.sync();
    assert.ok(view.el.querySelector(".airdrop-view-done"));
    assert.equal(AIRDROP_AUTO_CLOSE_MS, 600);
    assert.equal(timer.delay, AIRDROP_AUTO_CLOSE_MS);
    view.el.fire("mouseenter");
    timer.callback();
    assert.deepEqual(returned, []);
    view.el.fire("mouseleave");
    assert.deepEqual(returned, [], "leaving must not immediately dismiss the panel");
    assert.equal(timer.delay, 600);
    timer.callback();
    assert.deepEqual(returned, ["overview"]);
  } finally {
    window.setTimeout = originalTimeout;
  }
});

test("native pointer leave folds a busy AirDrop card even when the chooser swallows DOM mouseleave", () => {
  reset();
  State.view = "airdrop";
  State.airdropSending = true;
  const oldTimeout = window.setTimeout, oldClear = window.clearTimeout;
  const timers = [];
  window.setTimeout = (callback, delay) => { timers.push({ callback, delay, cleared: false }); return timers.length; };
  window.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  try {
    const closed = [];
    const view = buildAirDropView(() => {}, () => closed.push(true));
    view.sync();
    view.el.fire("mouseenter");
    view.pointerInside(false); // No DOM mouseleave event is delivered.
    const leaveTimer = timers.at(-1);
    assert.equal(leaveTimer.delay, AIRDROP_AUTO_CLOSE_MS);
    for (let i = 0; i < 10; i++) { view.sync(); view.pointerInside(false); }
    view.el.fire("mouseenter"); // Late WebKit event queued before native leave.
    assert.equal(leaveTimer.cleared, false);
    assert.equal(timers.at(-1), leaveTimer, "polling cannot extend the 600ms countdown");
    leaveTimer.callback();
    assert.deepEqual(closed, [true]);
    assert.equal(State.airdropSending, true, "folding does not cancel sending");
    assert.deepEqual(calls, []);
    view.pointerInside(true);
    view.pointerInside(false);
    const pending = timers.at(-1);
    view.pointerInside(true);
    assert.equal(pending.cleared, true, "native reentry still keeps the card open");
  } finally { window.setTimeout = oldTimeout; window.clearTimeout = oldClear; }
});

test("a delayed discovery check does not prevent later outgoing progress polls", async () => {
  reset();
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  State.airdropSending = true;
  State.airdropOutbound = { phase: "choosing", sentBytes: null, totalBytes: null, elapsedMs: 0 };
  const original = internals.invoke;
  let resolveDiscovery, sent = 25;
  internals.invoke = async command => {
    if (command === "airdrop_discovery") return new Promise(resolve => { resolveDiscovery = resolve; });
    if (command === "airdrop_outbound") return { phase: "sending", sentBytes: sent, totalBytes: 100, elapsedMs: 1000 };
    return null;
  };
  try {
    const first = refreshAirDropActivity();
    await new Promise(setImmediate);
    assert.equal(State.airdropOutbound.sentBytes, 25);
    sent = 75;
    await refreshAirDropActivity();
    assert.equal(State.airdropOutbound.sentBytes, 75);
    resolveDiscovery({ supported: true, running: false, peers: [], error: null });
    await first;
  } finally { internals.invoke = original; }
});

test("AirDrop has room for whole recipient buttons and does not treat send failures as setup failures", () => {
  reset();
  State.view = "airdrop";
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  State.airdropPeers = [{ mac: "aabbccddeeff", name: "My iPhone", rssi: null }];
  State.airdropError = "The iPhone's receiving connection changed or closed. Find iPhone again.";
  const returned = [];
  const view = buildAirDropView(() => {}, () => returned.push("overview"));
  view.sync();
  assert.equal(islandSize("expanded", "airdrop").h, 160);
  assert.equal(islandSize("expanded", "airdropRequest").h, 182);
  assert.equal(view.el.querySelector(".airdrop-view-info").classList.contains("failed"), true);
  const setup = view.el.querySelector(".airdrop-view-actions").children.find(child => child.textContent === "Radio setup ↗");
  assert.equal(setup.style.display, "none", "delivery errors are not broken radio installs");
  State.airdropScanning = true;
  view.sync();
  assert.equal(view.el.querySelector(".airdrop-view-send").getAttribute("disabled"), "");
  State.airdropScanning = false;
  view.sync();
  view.el.querySelector(".airdrop-view-done").fire("click");
  assert.deepEqual(returned, ["overview"]);
});

test("AirDrop folds while scan/send/search work continues without cancelling it", () => {
  for (const busy of ["airdropScanning", "airdropSending", "airdropDiscovering"]) {
    reset();
    State.view = "airdrop";
    State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
    const originalTimeout = window.setTimeout;
    const originalClear = window.clearTimeout;
    const timers = [];
    window.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    window.clearTimeout = () => {};
    try {
      const returned = [];
      const view = buildAirDropView(() => {}, () => returned.push("overview"));
      view.sync();
      State[busy] = true;
      view.sync();
      view.el.fire("mouseleave");
      assert.deepEqual(returned, []);
      if (busy === "airdropScanning") {
        assert.match(view.el.textContent, /Share sheet closed/);
        assert.match(view.el.textContent, /Scanning…/);
      }
      assert.equal(timers.at(-1).delay, AIRDROP_AUTO_CLOSE_MS);
      timers.at(-1).callback();
      assert.deepEqual(returned, ["overview"]);
      assert.equal(State[busy], true, "folding must leave native work alone");
      assert.equal(view.el.querySelector(".airdrop-view-done").disabled, false);
      assert.deepEqual(calls, [], "closing must not toggle/cancel the receiver or send");
    } finally {
      window.setTimeout = originalTimeout;
      window.clearTimeout = originalClear;
    }
  }
});

test("continuous finding publishes new peers without pinning the view or blocking a named Send", async () => {
  reset();
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  const original = internals.invoke;
  const first = { mac: "000000000000", name: "My iPhone", rssi: null };
  const second = { mac: "abcdef123456", name: "Second iPhone", rssi: null };
  internals.invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "airdrop_discovery_set") return { supported: true, running: args.enabled, peers: args.enabled ? [first] : [], error: null };
    if (command === "airdrop_discovery") return { supported: true, running: true, peers: [first, second], error: null };
    return null;
  };
  try {
    await toggleAirDropDiscovery();
    assert.equal(State.airdropDiscovering, true);
    State.view = "overview";
    State.mode = "compact";
    await refreshAirDropActivity();
    assert.deepEqual(State.airdropPeers, [first, second]);
    assert.equal(airDropActivity().state, "searching");
    const view = buildAirDropView(() => {}, () => {});
    view.sync();
    assert.match(view.el.textContent, /Stop finding/);
    assert.equal(view.el.querySelector(".airdrop-view-send").getAttribute("disabled"), null);
    await toggleAirDropDiscovery();
    assert.equal(State.airdropDiscovering, false);
    assert.deepEqual(State.airdropPeers, []);
    assert.equal(calls.some(([command]) => command === "airdrop_send" || command === "airdrop_decide"), false);
  } finally { internals.invoke = original; }
});

test("late discovery polls cannot restart a search after Stop finding", async () => {
  reset();
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  const original = internals.invoke;
  let finish;
  internals.invoke = async (command, args) => {
    if (command === "airdrop_discovery_set") return { supported: true, running: args.enabled, peers: [], error: null };
    if (command === "airdrop_discovery") return new Promise(resolve => { finish = resolve; });
    return null;
  };
  try {
    await toggleAirDropDiscovery();
    const poll = refreshAirDropActivity();
    await new Promise(setImmediate);
    await toggleAirDropDiscovery();
    finish({ supported: true, running: true, peers: [{ mac: "000000000000", name: "Stale phone" }], error: null });
    await poll;
    assert.equal(State.airdropDiscovering, false);
    assert.deepEqual(State.airdropPeers, []);
  } finally { internals.invoke = original; }
});

test("recently seen phones stay selectable while background discovery publishes new devices", async () => {
  reset();
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  State.airdropDiscovering = true;
  const recent = { mac: "000000000000", name: "My iPhone", rssi: null, lastSeen: Date.now() - 60000, fresh: false };
  const newPhone = { mac: "abcdef123456", name: "New iPhone", rssi: null, lastSeen: Date.now(), fresh: true };
  const original = internals.invoke;
  internals.invoke = async command => command === "airdrop_discovery"
    ? { supported: true, running: true, peers: [recent, newPhone], error: null } : null;
  try {
    State.view = "overview";
    State.mode = "compact";
    await refreshAirDropActivity();
    assert.deepEqual(State.airdropPeers, [recent, newPhone]);
    const view = buildAirDropView(() => {}, () => {});
    view.sync();
    assert.match(view.el.textContent, /My iPhone · recently seen/);
    assert.match(view.el.textContent, /New iPhone/);
    assert.equal(view.el.querySelector(".airdrop-view-send").getAttribute("disabled"), null);
    assert.equal(State.view, "overview", "background updates never open the card");
    assert.equal(State.mode, "compact");
  } finally { internals.invoke = original; }
});

test("a detected AirDrop service is shown while connecting without inventing a name or enabling Send", async () => {
  reset();
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  State.airdropDiscovering = true;
  const peer = { mac: "000000000000", name: null, rssi: null, lastSeen: Date.now(), fresh: false, connection: "connecting" };
  State.airdropPeers = [peer];
  const view = buildAirDropView(() => {}, () => {});
  view.sync();
  assert.match(view.el.textContent, /service detected/);
  assert.match(view.el.textContent, /AirDrop device · connecting/);
  assert.notEqual(view.el.querySelector(".airdrop-view-send").getAttribute("disabled"), null);
  await sendAirDrop(peer.mac);
  assert.equal(calls.some(([command]) => command === "airdrop_send"), false);
  State.airdropPeers = [{ ...peer, connection: "retrying" }];
  view.sync();
  assert.match(view.el.textContent, /connection slow, retrying/);
});

test("cached devices keep expiring and resumed search is observed after sending", async () => {
  reset();
  State.airdropPeers = [{ mac: "000000000000", name: "Recent iPhone", rssi: null, lastSeen: Date.now() - 179000, fresh: false }];
  State.airdropDiscovering = false;
  const original = internals.invoke;
  let running = false;
  internals.invoke = async command => command === "airdrop_discovery"
    ? { supported: true, running, peers: [], error: null } : null;
  try {
    await refreshAirDropActivity();
    assert.deepEqual(State.airdropPeers, [], "expired cached rows disappear even when search is stopped");
    State.airdropOutbound = { phase: "complete", sentBytes: 10, totalBytes: 10, elapsedMs: 1000 };
    running = true;
    await refreshAirDropActivity();
    assert.equal(State.airdropDiscovering, true, "temporary send pause does not lose the user's ongoing search");
  } finally { internals.invoke = original; }
});

test("sending has a compact phase/progress ring independent of receiving and waits for confirmation", () => {
  reset();
  const ring = buildAirDropCompactStatus();
  State.airdropSending = true;
  State.airdropOutbound = { phase: "asking", sentBytes: null, totalBytes: null, elapsedMs: 1000 };
  const sync = () => { const active = airDropActivity(); ring.sync("compact", active.state, active.progress, active.label); };
  sync();
  assert.equal(ring.el.classList.contains("sending"), true);
  assert.match(ring.el.getAttribute("aria-label"), /acceptance/);
  assert.equal(ring.el.classList.contains("determinate"), false);
  State.airdropTransfer = "receiving";
  State.airdropOutbound = { phase: "sending", sentBytes: 50, totalBytes: 100, elapsedMs: 1100 };
  sync();
  assert.equal(ring.el.style["--airdrop-progress"], "50%");
  assert.equal(ring.el.classList.contains("receiving"), false);
  State.airdropOutbound = { ...State.airdropOutbound, phase: "confirming", sentBytes: 100 };
  sync();
  assert.equal(ring.el.style["--airdrop-progress"], "99%");
  assert.match(ring.el.getAttribute("aria-label"), /confirm/);
  assert.equal(ring.el.classList.contains("complete"), false);
  State.airdropOutbound = { ...State.airdropOutbound, phase: "complete" };
  sync();
  assert.equal(ring.el.classList.contains("complete"), true);
});

test("reentering AirDrop cancels dismissal and a completed action remains open while hovered", () => {
  reset();
  State.view = "airdrop";
  State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
  const originalTimeout = window.setTimeout;
  const originalClear = window.clearTimeout;
  const timers = [];
  window.setTimeout = (callback, delay) => { timers.push({ callback, delay, cleared: false }); return timers.length; };
  window.clearTimeout = id => { timers[id - 1].cleared = true; };
  try {
    const returned = [];
    const view = buildAirDropView(() => {}, () => returned.push("overview"));
    view.sync();
    view.el.fire("mouseenter");
    assert.equal(timers[0].cleared, true);
    view.el.fire("mouseleave");
    const leave = timers.at(-1);
    view.el.fire("mouseenter");
    assert.equal(leave.cleared, true);
    leave.callback();
    assert.deepEqual(returned, [], "an already-queued callback must respect reentry");
    State.airdropSending = true;
    view.sync();
    State.airdropSending = false;
    view.sync();
    assert.equal(timers.length, 2, "completion must not arm dismissal while hovered");
    view.el.fire("mouseleave");
    timers.at(-1).callback();
    assert.deepEqual(returned, ["overview"]);
    assert.equal(State.airdropStatus.receiving, true, "closing the panel must not stop AirDrop");
  } finally {
    window.setTimeout = originalTimeout;
    window.clearTimeout = originalClear;
  }
});

test("Turn off remains usable during scan and send, and late results cannot revive the workflow", async () => {
  for (const phase of ["scan", "send"]) {
    for (const fail of [false, true]) {
      reset();
      State.view = "airdrop";
      State.airdropStatus = { ...State.airdropStatus, receiving: true, visible: true };
      State.airdropPeers = [{ mac: "aabbccddeeff", name: "Selected iPhone", rssi: null }];
      const original = internals.invoke;
      let finish;
      let reject;
      let stopped = false;
      const pending = new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
      internals.invoke = async (command, args) => {
        if (command === "airdrop_peers" || command === "airdrop_send") return pending;
        if (command === "airdrop_set") {
          assert.equal(args.enabled, false, "off must reach native code before the work finishes");
          stopped = true;
          return { ...State.airdropStatus, receiving: false, visible: false };
        }
        return null;
      };
      try {
        const operation = phase === "scan" ? refreshAirDropPeers(true) : sendAirDrop("aabbccddeeff");
        await new Promise(setImmediate);
        const busy = phase === "scan" ? "airdropScanning" : "airdropSending";
        assert.equal(State[busy], true);
        const view = buildAirDropView(() => {}, () => {});
        view.sync();
        assert.equal(view.el.querySelector(".airdrop-view-power").disabled, false);
        await toggleAirDrop();
        assert.equal(stopped, true);
        assert.equal(State.airdropStatus.receiving, false);
        if (fail) reject(new Error("synthetic cancelled operation"));
        else finish(phase === "scan"
          ? [{ mac: "aabbccddeeff", name: "Stale result", rssi: null }] : "Stale successful send");
        await operation;
        assert.equal(State[busy], false);
        assert.deepEqual(State.airdropPeers, []);
        assert.equal(State.airdropError, "", "an off-induced cancellation must not replace the off result");
        assert.equal(State.airdropNotice, "", "a late send result must not announce delivery after off");
      } finally {
        finish(null);
        internals.invoke = original;
      }
    }
  }
});

test("busy work blocks a new enable but never blocks an explicit disable", async () => {
  reset();
  State.airdropScanning = true;
  const original = internals.invoke;
  let invoked = 0;
  internals.invoke = async () => { invoked += 1; return null; };
  try {
    await toggleAirDrop();
    assert.equal(invoked, 0);
    const view = buildAirDropView(() => {}, () => {});
    view.sync();
    assert.equal(view.el.querySelector(".airdrop-view-power").disabled, true);
  } finally {
    State.airdropScanning = false;
    internals.invoke = original;
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
