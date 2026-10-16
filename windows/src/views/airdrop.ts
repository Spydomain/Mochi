// AirDrop's island views. The native receiver owns AWDL; Mochi only presents
// status and relays a short-lived, explicit accept/decline decision.
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { h, clear, svg } from "./dom";
import { ICONS } from "./icons";
import { t } from "../i18n/i18n";
import type { IslandMode } from "../core/layout";

export const AIRDROP_AUTO_CLOSE_MS = 3_000;

/** The compact island's transfer display. Show measured raw upload bytes only
 * when both a valid TotalBytes header and its matching archive are available. */
export function buildAirDropCompactStatus() {
  const el = h("div", { id: "airdrop-compact-status", role: "status", "aria-live": "polite" },
    h("span", { class: "airdrop-compact-icon", "aria-hidden": "true" },
      svg(ICONS.airDrop, 27, { stroke: 1.5 })),
    h("span", { class: "airdrop-ring", "aria-hidden": "true" }),
  );
  return { el, sync(mode: IslandMode, transfer: typeof State.airdropTransfer,
    progress: typeof State.airdropProgress = null) {
    const visible = mode === "compact" && transfer !== null;
    const received = progress?.receivedBytes;
    const total = progress?.totalBytes;
    const percent = transfer === "receiving" && received != null && total != null &&
      Number.isFinite(received) && Number.isFinite(total) && received >= 0 && total > 0
      ? Math.min(99, Math.floor(100 * received / total)) : null;
    el.style.display = visible ? "flex" : "none";
    el.classList.toggle("waiting", transfer === "waiting");
    el.classList.toggle("receiving", transfer === "receiving");
    el.classList.toggle("complete", transfer === "complete");
    el.classList.toggle("failed", transfer === "failed");
    el.classList.toggle("determinate", percent !== null);
    el.style.setProperty("--airdrop-progress", `${percent ?? 0}%`);
    el.setAttribute("aria-label", transfer === "complete"
      ? "AirDrop transfer complete" : transfer === "failed"
        ? "AirDrop transfer incomplete; try again" : transfer === "receiving"
          ? `Receiving an AirDrop file${percent === null ? "" : ` · ${percent}%`}` : "Waiting for an AirDrop file");
  } };
}
let toggleGeneration = 0;

export async function refreshAirDrop() {
  if (State.os !== "linux" || State.airdropPending) return;
  const generation = toggleGeneration;
  let changed = false;
  try {
    const status = await Bridge.airdropStatus();
    // A poll begun before a toggle must not replace its verified result.
    if (generation !== toggleGeneration) return;
    if (!State.airdropPending) {
      changed = JSON.stringify(State.airdropStatus) !== JSON.stringify(status);
      State.airdropStatus = status;
    }
  } catch (err) {
    if (generation !== toggleGeneration || State.airdropPending) return;
    const message = String(err);
    changed = State.airdropError !== message;
    State.airdropError = message;
  }
  if (changed) State.notify();
}

export async function refreshAirDropPeers(named = false) {
  if (State.airdropScanning || State.airdropSending || !State.airdropStatus?.visible) return;
  State.airdropScanning = true;
  State.notify();
  try {
    const peers = await Bridge.airdropPeers(named);
    const knownNames = new Map(State.airdropPeers.filter(peer => peer.name).map(peer => [peer.mac, peer.name]));
    State.airdropPeers = peers.map(peer => ({ ...peer, name: peer.name || knownNames.get(peer.mac) || null }));
    State.airdropError = "";
  } catch (err) {
    State.airdropError = String(err);
  } finally {
    State.airdropScanning = false;
    State.notify();
  }
}

export async function toggleAirDrop() {
  if (State.airdropPending || State.airdropScanning || State.airdropSending) return;
  if (State.airdropStatus?.installed === false) return;
  toggleGeneration++;
  State.airdropPending = true;
  State.airdropError = "";
  State.notify();
  try {
    const status = await Bridge.airdropSet(!State.airdropStatus?.receiving);
    State.airdropStatus = status;
    State.airdropPeers = [];
    if (status.receiving) {
      State.airdropActiveName = State.settings.airdropName;
      State.airdropActiveDirectory = State.settings.airdropDirectory;
    } else {
      State.airdropTransfer = null;
      State.airdropProgress = null;
      State.airdropActiveName = null;
      State.airdropActiveDirectory = null;
    }
  } catch (err) {
    State.airdropError = String(err);
    try { State.airdropStatus = await Bridge.airdropStatus(); } catch { /* preserve error */ }
  } finally {
    State.airdropPending = false;
    State.notify();
  }
}

export async function sendAirDrop(mac: string) {
  if (State.airdropSending || State.airdropPending || !State.airdropStatus?.visible ||
      !State.airdropPeers.some(peer => peer.mac === mac && peer.name)) return;
  State.airdropSending = true;
  State.airdropNotice = "Choose files to send. Keep the iPhone unlocked and close its Share sheet.";
  State.airdropError = "";
  State.notify();
  try {
    State.airdropNotice = await Bridge.airdropSend(mac);
  } catch (err) {
    State.airdropNotice = "";
    State.airdropError = String(err);
  } finally {
    State.airdropSending = false;
    State.notify();
  }
}

export function buildAirDrop(open: () => void) {
  const pill = h("button", {
    class: "airdrop-pill", type: "button",
    onclick: () => open(),
  }, h("span", { class: "airdrop-dot" }), h("span", { text: t("AirDrop") }));
  return { pill, sync() {
    const active = State.os === "linux" && State.view === "overview" && State.settings.showAirDropInNotch;
    pill.style.display = active ? "" : "none";
    const receiving = !!State.airdropStatus?.receiving;
    pill.classList.toggle("on", receiving);
    // "off" is not an error. A stale backend message must not leave the pill
    // highlighted after stopping; the error is shown on the AirDrop view.
    pill.classList.toggle("failed", !!State.airdropError && !!State.airdropStatus?.receiving);
    pill.setAttribute("aria-pressed", String(receiving));
    pill.title = State.airdropPending
      ? receiving ? "AirDrop is turning off…" : "AirDrop is turning on…"
      : receiving ? "AirDrop is on · open details" : "AirDrop is off · open details";
  } };
}

export function buildAirDropView(openSettings: () => void, back: () => void) {
  const title = h("strong", { text: t("AirDrop") });
  const info = h("div", { class: "airdrop-view-info", role: "status" });
  const destination = h("div", { class: "airdrop-view-destination" });
  const peers = h("div", { class: "airdrop-view-peers" });
  const power = h("button", { class: "airdrop-view-power", onclick: () => void toggleAirDrop() });
  const scan = h("button", { onclick: () => void refreshAirDropPeers(true) }, "Find iPhone");
  const settings = h("button", { onclick: openSettings }, "Save folder & name ↗");
  const setup = h("button", { onclick: () => void Bridge.openUrl(statusSetupUrl()) }, "Radio setup ↗");
  let hovering = false;
  const el = h("div", {
    class: "view airdrop-view",
    onmouseenter: () => { hovering = true; },
    onmouseleave: () => {
      hovering = false;
      // The detail card is deliberately transient. Once the cursor leaves it,
      // return to the ordinary island immediately rather than hiding it while
      // the user is trying to read or use one of its controls.
      if (!State.airdropPending) returnToOverview();
    },
  },
    h("div", { class: "airdrop-view-head" }, title),
    h("div", { class: "airdrop-view-body" }, info, destination, peers,
      h("div", { class: "airdrop-view-actions" }, power, scan, settings, setup)));
  let shown = false;
  let closeTimer: number | null = null;
  let restartCloseWhenReady = false;

  function armAutoClose() {
    if (closeTimer != null) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      // Startup must not be hidden behind the normal transient-card timeout.
      // The action resolves only after Rust has verified the HTTPS listener.
      if (State.airdropPending) {
        restartCloseWhenReady = true;
        return;
      }
      if (!hovering) returnToOverview();
    }, AIRDROP_AUTO_CLOSE_MS);
  }

  function returnToOverview() {
    if (closeTimer != null) window.clearTimeout(closeTimer);
    closeTimer = null;
    shown = false;
    if (State.view === "airdrop") back();
  }

  function statusSetupUrl() {
    return State.airdropStatus?.message?.includes("MT7922")
      ? "https://github.com/jedbillyb/airdrop-mt7921#install"
      : "https://github.com/t4t5/omdrop-owl#install";
  }
  return { el, sync() {
    // This is a transient detail card, not a persistent full-screen panel.
    // Starting the timer only once prevents status polling from postponing it.
    if (!shown) {
      shown = true;
      armAutoClose();
    }
    const status = State.airdropStatus;
    const on = !!status?.receiving;
    const starting = State.airdropPending && !on;
    if (State.airdropPending) {
      // Do not let the normal three-second transient timeout close the detail
      // before the real receiver status returns.
      if (closeTimer != null) window.clearTimeout(closeTimer);
      closeTimer = null;
      restartCloseWhenReady = true;
    } else if (restartCloseWhenReady) {
      restartCloseWhenReady = false;
      armAutoClose();
    }
    power.textContent = State.airdropPending ? on ? "Turning off…" : "Turning on…" : on ? "Turn off" : "Turn on";
    power.disabled = State.airdropPending || State.airdropScanning || State.airdropSending;
    scan.disabled = !status?.visible || State.airdropScanning || State.airdropSending;
    scan.style.display = on ? "" : "none";
    // A discovery result is guidance, not a broken radio installation. Keeping
    // this optional fourth control out of that case keeps the compact card to a
    // single action row.
    setup.style.display = status?.installed === false || !!State.airdropError ? "" : "none";
    info.textContent = State.airdropError || (starting ? "Starting AirDrop radio…" : status?.message) || (on
      ? `${status?.name || State.airdropActiveName ? `Receiving as ${status?.name || State.airdropActiveName}` : "Receiver running"} · ready for an iPhone`
      : "Off · turn on to receive from an iPhone");
    destination.textContent = on
      ? status?.directory ? `Saves to ${status.directory}`
        : State.airdropActiveDirectory ? `Saves to ${State.airdropActiveDirectory}`
          : `Configured save folder: ${State.settings.airdropDirectory || "~/Downloads"} · active receiver destination unverified`
      : "";
    // The island closes after three seconds; detailed send/receive guidance is
    // available after reopening rather than overflowing this compact card.
    clear(peers);
    if (State.airdropScanning) peers.append(h("span", { text: "Looking for nearby devices…" }));
    for (const peer of State.airdropPeers.slice(0, 4)) {
      peers.append(h("div", { class: "airdrop-view-peer" },
        h("span", { text: peer.name || `Apple device · ${peer.mac}` }),
        h("button", { class: "airdrop-view-send", type: "button", disabled: !peer.name || State.airdropSending,
          onclick: () => void sendAirDrop(peer.mac) }, t("Send"))));
    }
  } };
}

export function buildAirDropRequest() {
  const title = h("strong", { text: "Incoming AirDrop" });
  const from = h("div", { class: "airdrop-request-from" });
  const detail = h("div", { class: "airdrop-request-detail" });
  const feedback = h("div", { class: "airdrop-request-feedback", role: "status" });
  let shownId = "";
  let shownAt = 0;
  const decide = async (accept: boolean) => {
    const request = State.airdropRequest;
    if (!request || State.airdropDeciding || performance.now() - shownAt < 600) return;
    State.airdropDeciding = true;
    State.notify();
    try {
      await Bridge.airdropDecide(request.id, accept);
      State.airdropAnsweredId = request.id;
      State.airdropRequest = null;
      if (accept) State.airdropTransfer = "waiting";
    } catch (err) {
      State.airdropError = String(err);
    } finally {
      State.airdropDeciding = false;
      State.notify();
    }
  };
  const decline = h("button", { class: "airdrop-decline", onclick: () => void decide(false) }, "Decline");
  const accept = h("button", { class: "airdrop-accept", onclick: () => void decide(true) }, "Accept");
  const el = h("div", { class: "view airdrop-request-view" },
    h("div", { class: "airdrop-request-body" }, title, from, detail, feedback,
      h("div", { class: "airdrop-request-actions" }, decline, accept)));
  return { el, sync() {
    const request = State.airdropRequest;
    if (request?.id !== shownId) { shownId = request?.id || ""; shownAt = performance.now(); }
    from.textContent = request?.sender || "Unknown sender";
    detail.textContent = request?.detail || "Incoming item";
    feedback.textContent = State.airdropError || "Only accept a transfer you recognize. Unanswered requests expire automatically.";
    decline.disabled = accept.disabled = !request || State.airdropDeciding;
  } };
}
