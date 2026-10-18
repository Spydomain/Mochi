// AirDrop's island views. The native receiver owns AWDL; Mochi only presents
// status and relays a short-lived, explicit accept/decline decision.
import { Bridge, type AirDropTransfer } from "../core/bridge";
import { State } from "../core/state";
import { h, clear, svg } from "./dom";
import { ICONS } from "./icons";
import { t } from "../i18n/i18n";
import type { IslandMode } from "../core/layout";

export const AIRDROP_AUTO_CLOSE_MS = 600;

/** Receive warnings belong to this workflow, never a later send or radio state. */
export function applyAirDropReceive(transfer: AirDropTransfer | null, completedAt: number, now = Date.now()): number {
  if (transfer?.state === "complete" || transfer?.state === "failed") {
    if (!completedAt || (transfer.state === "complete" && State.airdropReceiveError)) completedAt = now;
    State.airdropReceiveError = transfer.state === "failed"
      ? transfer.message || "AirDrop transfer incomplete. Any complete files were saved. Unfinished data is kept in Mochi's private recovery folder; please retry."
      : "";
    State.airdropTransfer = now - completedAt < 5000 ? transfer.state : null;
  } else {
    completedAt = 0;
    State.airdropReceiveError = "";
    State.airdropTransfer = transfer?.state ?? null;
  }
  State.airdropProgress = State.airdropTransfer && transfer
    ? { receivedBytes: transfer.receivedBytes, totalBytes: transfer.totalBytes } : null;
  State.airdropReceiveDetail = State.airdropTransfer ? transfer : null;
  return completedAt;
}

type CompactTransfer = typeof State.airdropTransfer | "sending" | "searching";

function incomingActiveTransfer(): boolean {
  return !!State.airdropTransfer && !["complete", "failed"].includes(State.airdropTransfer);
}

export function airDropActivity(): { state: CompactTransfer; progress: typeof State.airdropProgress; label?: string } {
  const outbound = State.airdropOutbound;
  const incomingActive = incomingActiveTransfer();
  if (outbound && outbound.phase !== "cancelled" && !(!State.airdropSending && incomingActive && ["complete", "failed"].includes(outbound.phase))) {
    const terminal = outbound.phase === "complete" || outbound.phase === "failed";
    return { state: terminal ? outbound.phase as "complete" | "failed" : "sending",
      progress: ["sending", "stalled", "confirming"].includes(outbound.phase)
        ? { receivedBytes: outbound.sentBytes, totalBytes: outbound.totalBytes } : null,
      label: outboundLabel() };
  }
  if (State.airdropSending) return { state: "sending", progress: null, label: "Preparing an AirDrop send" };
  if (State.airdropTransfer) return { state: State.airdropTransfer, progress: State.airdropProgress,
    label: (State.airdropReceiveDetail?.state === State.airdropTransfer ? State.airdropReceiveDetail.message : null) ||
      (State.airdropTransfer === "verifying" ? "Verifying and saving files · upload received…" : undefined) };
  if (State.airdropDiscovering) return { state: "searching", progress: null, label: "Looking for nearby AirDrop devices" };
  return { state: null, progress: null };
}

function outboundLabel(): string {
  const labels: Record<string, string> = {
    choosing: "Choose files in the desktop chooser", waking: "Waking the selected iPhone…",
    discovering: "Checking the selected iPhone connection…", connecting: "Connecting securely to the iPhone…",
    asking: "Waiting for the iPhone's acceptance reply…",
    accepted: "iPhone accepted · processing its reply…", preparing: "Preparing the file archive…",
    sending: "Sending bytes to the iPhone…", confirming: "Bytes sent · waiting for the iPhone to confirm…",
    stalled: "Connection paused · waiting for the iPhone to acknowledge more bytes…",
    complete: "AirDrop transfer complete.", failed: "AirDrop did not confirm delivery.", cancelled: "Send cancelled.",
  };
  return labels[State.airdropOutbound?.phase || ""] || "";
}

/** Receive counters measure the archive; outgoing counters use TCP ACKs where
 * available (TLS-write fallback). Neither claims success before confirmation. */
export function buildAirDropCompactStatus() {
  const detail = h("span", { class: "airdrop-compact-detail", "aria-hidden": "true" });
  const el = h("div", { id: "airdrop-compact-status", role: "status", "aria-live": "polite" },
    h("span", { class: "airdrop-compact-icon", "aria-hidden": "true" },
      svg(ICONS.airDrop, 20, { stroke: 1.5 })),
    detail,
    h("span", { class: "airdrop-ring", "aria-hidden": "true" }),
  );
  return { el, sync(mode: IslandMode, transfer: CompactTransfer,
    progress: typeof State.airdropProgress = null, label?: string) {
    const visible = mode === "compact" && transfer !== null;
    const received = progress?.receivedBytes;
    const total = progress?.totalBytes;
    const percent = (transfer === "receiving" || transfer === "sending" || transfer === "verifying") && received != null && total != null &&
      Number.isFinite(received) && Number.isFinite(total) && received >= 0 && total > 0
      ? Math.min(99, Math.floor(100 * received / total)) : null;
    el.style.display = visible ? "flex" : "none";
    el.classList.toggle("waiting", transfer === "waiting");
    el.classList.toggle("receiving", transfer === "receiving");
    el.classList.toggle("sending", transfer === "sending");
    el.classList.toggle("searching", transfer === "searching");
    el.classList.toggle("complete", transfer === "complete");
    el.classList.toggle("failed", transfer === "failed");
    el.classList.toggle("determinate", percent !== null);
    el.style.setProperty("--airdrop-progress", `${percent ?? 0}%`);
    detail.textContent = percent !== null ? `${percent}%` : transfer === "receiving" && received != null
      ? byteLabel(State.airdropReceiveDetail?.wireBytes ?? received) : transfer === "sending" ? t("Sending…")
      : transfer === "verifying" ? "Verifying…" : transfer === "receiving" ? "Receiving…" : transfer === "searching" ? "Finding…" : transfer === "complete" ? t("Done") : transfer === "failed" ? "Incomplete" : "Waiting…";
    el.setAttribute("aria-label", label ? `${label}${percent === null ? "" : ` · ${percent}%`}` : transfer === "complete"
      ? "AirDrop transfer complete" : transfer === "failed"
        ? "AirDrop transfer incomplete; try again" : transfer === "receiving"
          ? `Receiving an AirDrop file${percent === null ? "" : ` · ${percent}%`}` : "Waiting for an AirDrop file");
  } };
}
let toggleGeneration = 0;
let discoveryGeneration = 0;
let sendGeneration = 0;
let pollingDiscovery = false;
let pollingOutbound = false;

export async function toggleAirDropDiscovery() {
  if (State.airdropPending || State.airdropSending || !State.airdropStatus?.visible) return;
  const generation = ++discoveryGeneration;
  const enabled = !State.airdropDiscovering;
  State.airdropDiscovering = enabled;
  State.airdropNotice = "";
  State.airdropError = "";
  State.notify();
  try {
    const discovery = await Bridge.airdropDiscoverySet(enabled);
    if (generation !== discoveryGeneration) return;
    State.airdropDiscovering = discovery.running;
    State.airdropPeers = discovery.peers;
    if (!discovery.supported && enabled) await refreshAirDropPeers(true);
    else if (discovery.error) State.airdropError = discovery.error;
  } catch (error) {
    if (generation !== discoveryGeneration) return;
    State.airdropDiscovering = false;
    State.airdropError = String(error);
  } finally { if (generation === discoveryGeneration) State.notify(); }
}

export async function refreshAirDropActivity() {
  if (State.os !== "linux") return;
  const generation = toggleGeneration;
  const searchGeneration = discoveryGeneration;
  const sendingGeneration = sendGeneration;
  try {
    const discoveryCheck = async () => {
      if (pollingDiscovery || !(State.airdropStatus?.visible || State.airdropDiscovering || State.airdropSending || State.airdropOutbound || State.airdropPeers.some(peer => peer.lastSeen != null))) return;
      pollingDiscovery = true;
      try {
        const snapshot = await Bridge.airdropDiscovery();
        if (snapshot?.supported && generation === toggleGeneration && searchGeneration === discoveryGeneration) {
          const changed = snapshot.running !== State.airdropDiscovering || JSON.stringify(snapshot.peers) !== JSON.stringify(State.airdropPeers);
          State.airdropDiscovering = snapshot.running;
          State.airdropPeers = snapshot.peers;
          if (snapshot.error) State.airdropError = snapshot.error;
          if (changed || snapshot.error) State.notify();
        }
      } finally { pollingDiscovery = false; }
    };
    const sendCheck = async () => {
      if (pollingOutbound || !(State.airdropSending || State.airdropOutbound)) return;
      pollingOutbound = true;
      try {
        const outbound = await Bridge.airdropOutbound();
        if (generation === toggleGeneration && sendingGeneration === sendGeneration && (outbound || !State.airdropSending) &&
            JSON.stringify(outbound) !== JSON.stringify(State.airdropOutbound)) {
          State.airdropOutbound = outbound;
          State.notify();
        }
      } finally { pollingOutbound = false; }
    };
    // A delayed/rejected discovery IPC must never strand send progress behind
    // it. The two read-only snapshots are independent.
    const results = await Promise.allSettled([discoveryCheck(), sendCheck()]);
    for (const result of results) if (result.status === "rejected") console.error("[mochi] AirDrop activity check failed", result.reason);
  } catch (error) { console.error("[mochi] AirDrop activity check failed", error); }
}

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
  if (State.airdropPending || State.airdropScanning || State.airdropSending || !State.airdropStatus?.visible) return;
  const generation = toggleGeneration;
  State.airdropScanning = true;
  State.airdropNotice = "";
  State.airdropError = "";
  State.notify();
  try {
    const peers = await Bridge.airdropPeers(named);
    if (generation !== toggleGeneration) return;
    const knownNames = new Map(State.airdropPeers.filter(peer => peer.name).map(peer => [peer.mac, peer.name]));
    State.airdropPeers = peers.map(peer => ({ ...peer, name: peer.name || knownNames.get(peer.mac) || null }));
    State.airdropError = "";
  } catch (err) {
    if (generation === toggleGeneration) State.airdropError = String(err);
  } finally {
    State.airdropScanning = false;
    State.notify();
  }
}

export async function toggleAirDrop() {
  const enabled = !State.airdropStatus?.receiving;
  // Off cancels native work; starting a second workflow still waits for it.
  if (State.airdropPending || (enabled && (State.airdropScanning || State.airdropSending))) return;
  if (enabled && State.airdropStatus?.installed === false) return;
  toggleGeneration++;
  discoveryGeneration++;
  State.airdropDiscovering = false;
  State.airdropPending = true;
  State.airdropError = "";
  State.airdropReceiveError = "";
  State.airdropNotice = "";
  State.notify();
  try {
    const status = await Bridge.airdropSet(enabled);
    State.airdropStatus = status;
    State.airdropPeers = [];
    if (status.receiving) {
      State.airdropActiveName = State.settings.airdropName;
      State.airdropActiveDirectory = State.settings.airdropDirectory;
    } else {
      State.airdropTransfer = null;
      State.airdropProgress = null;
      State.airdropReceiveDetail = null;
      State.airdropOutbound = null;
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
  if (State.airdropSending || State.airdropPending || State.airdropScanning || !State.airdropStatus?.visible ||
      State.airdropTransfer === "receiving" || State.airdropTransfer === "verifying" ||
      !State.airdropPeers.some(peer => peer.mac === mac && peer.name)) return;
  const generation = toggleGeneration;
  sendGeneration++;
  State.airdropSending = true;
  State.airdropOutbound = { phase: "choosing", sentBytes: null, totalBytes: null, elapsedMs: 0 };
  State.airdropNotice = "Choose files to send. Keep the iPhone unlocked and close its Share sheet.";
  State.airdropError = "";
  State.notify();
  try {
    const notice = await Bridge.airdropSend(mac);
    if (generation === toggleGeneration) State.airdropNotice = notice;
  } catch (err) {
    if (generation === toggleGeneration) {
      State.airdropNotice = "";
      State.airdropError = String(err);
    }
  } finally {
    State.airdropSending = false;
    // Fetch the native terminal phase; it expires after five seconds. Never
    // fabricate sent byte totals or let a receiving poll replace this status.
    if (generation === toggleGeneration) await refreshAirDropActivity();
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
    pill.classList.toggle("failed", !!(State.airdropError || State.airdropReceiveError) && !!State.airdropStatus?.receiving);
    pill.setAttribute("aria-pressed", String(receiving));
    pill.title = State.airdropPending
      ? receiving ? "AirDrop is turning off…" : "AirDrop is turning on…"
      : receiving ? "AirDrop is on · open details" : "AirDrop is off · open details";
  } };
}

export function airDropPanelHeight(headHeight: number, bodyHeight: number): number {
  if (!Number.isFinite(headHeight + bodyHeight)) return 160;
  return Math.min(300, Math.max(160, Math.ceil(headHeight + bodyHeight + 48)));
}

function byteLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** One detailed progress component for both transfer directions. */
export function buildAirDropTransferProgress() {
  const heading = h("span");
  const count = h("span");
  const bar = h("progress", { class: "airdrop-transfer-bar", max: "100", "aria-label": "AirDrop transfer progress" });
  const el = h("div", { class: "airdrop-transfer-progress", role: "status", "aria-live": "polite" },
    h("div", { class: "airdrop-transfer-labels" }, heading, count), bar);
  return { el, sync() {
    const activity = airDropActivity();
    const visible = activity.state !== null && activity.state !== "searching";
    el.style.display = visible ? "flex" : "none";
    if (!visible) return;
    const receiving = !State.airdropSending && (!State.airdropOutbound || State.airdropOutbound.phase === "cancelled" ||
      (incomingActiveTransfer() && ["complete", "failed"].includes(State.airdropOutbound.phase)));
    heading.textContent = receiving ? activity.label || (activity.state === "verifying" ? "Verifying and saving…"
      : activity.state === "receiving" ? "Receiving from iPhone…" : activity.state === "waiting" ? "Waiting for upload…"
        : activity.state === "complete" ? "Files saved" : "Receive incomplete")
      : outboundLabel() || t("Sending…");
    bar.style.display = activity.state === "failed" ? "none" : "";
    const got = activity.progress?.receivedBytes;
    const total = activity.progress?.totalBytes;
    const percent = got != null && total != null && Number.isFinite(got) && Number.isFinite(total) && got >= 0 && total > 0
      ? Math.min(99, Math.floor(100 * got / total)) : null;
    if (activity.state === "complete") bar.setAttribute("value", "100");
    else if (percent !== null) bar.setAttribute("value", String(percent));
    else bar.removeAttribute("value");
    const bytes = receiving ? State.airdropReceiveDetail?.wireBytes ?? got : got;
    const speed = receiving ? State.airdropReceiveDetail?.bytesPerSecond : State.airdropOutbound?.bytesPerSecond;
    count.textContent = [percent !== null && activity.state !== "complete" ? `${percent}%` : "",
      bytes != null ? byteLabel(bytes) : "", speed != null ? `${byteLabel(speed)}/s` : ""].filter(Boolean).join(" · ");
  } };
}

export function buildAirDropView(openSettings: () => void, back: () => void, resized: () => void = () => {}) {
  const title = h("strong", { text: t("AirDrop") });
  const info = h("div", { class: "airdrop-view-info", role: "status" });
  const destination = h("div", { class: "airdrop-view-destination" });
  const peers = h("div", { class: "airdrop-view-peers" });
  const transfer = buildAirDropTransferProgress();
  const power = h("button", { class: "airdrop-view-power", onclick: () => void toggleAirDrop() });
  const scan = h("button", { onclick: () => void toggleAirDropDiscovery() }, "Find iPhone");
  const settings = h("button", { onclick: openSettings }, "Save folder & name ↗");
  const setup = h("button", { onclick: () => void Bridge.openUrl(statusSetupUrl()) }, "Radio setup ↗");
  const done = h("button", { class: "airdrop-view-done", type: "button", onclick: returnToOverview }, t("Done"));
  let hovering = false;
  let nativeInside: boolean | null = null;
  const el = h("div", {
    class: "view airdrop-view",
    onmouseenter: () => {
      if (nativeInside !== false) setHover(true);
    },
    onmouseleave: () => {
      // Keep the panel only while hovered, with a short grace for crossing its
      // edge. Closing the view never cancels discovery, a chooser or a send.
      setHover(false);
    },
  },
    h("div", { class: "airdrop-view-head" }, title, done),
    h("div", { class: "airdrop-view-body" }, info, destination, transfer.el, peers,
      h("div", { class: "airdrop-view-actions" }, power, scan, settings, setup)));
  let shown = false;
  let peerSignature = "";
  let closeTimer: number | null = null;
  function setHover(inside: boolean) {
    if (inside === hovering && (inside || closeTimer != null)) return;
    hovering = inside;
    if (inside) {
      if (closeTimer != null) window.clearTimeout(closeTimer);
      closeTimer = null;
    } else armAutoClose();
  }
  function measureContent() {
    if (State.view !== "airdrop" || State.mode !== "expanded") return;
    const head = el.querySelector(".airdrop-view-head")!;
    const body = el.querySelector(".airdrop-view-body")!;
    const height = airDropPanelHeight(head.getBoundingClientRect().height, body.scrollHeight);
    if (height === State.airdropPanelHeight) return;
    State.airdropPanelHeight = height;
    resized();
  }
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(measureContent);
    observer.observe(el.querySelector(".airdrop-view-head")!);
    observer.observe(el.querySelector(".airdrop-view-body")!);
  }

  function armAutoClose() {
    if (closeTimer != null) window.clearTimeout(closeTimer);
    closeTimer = null;
    if (hovering) return;
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
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
  return { el, pointerInside(inside: boolean) {
    nativeInside = inside;
    setHover(inside);
  }, sync() {
    // Hover owns idle visibility, not whether the radio is enabled. Polling
    // must not keep restarting the short mouse-leave countdown.
    if (!shown) {
      shown = true;
      armAutoClose();
    }
    const status = State.airdropStatus;
    const on = !!status?.receiving;
    const starting = State.airdropPending && !on;
    power.textContent = State.airdropPending ? on ? "Turning off…" : "Turning on…" : on ? "Turn off" : "Turn on";
    scan.textContent = State.airdropDiscovering ? "Stop finding" : State.airdropScanning ? "Scanning…" : "Find iPhone";
    power.disabled = State.airdropPending || (!on && (State.airdropScanning || State.airdropSending));
    done.disabled = false;
    scan.disabled = State.airdropPending || !status?.visible || State.airdropScanning || State.airdropSending;
    scan.style.display = on ? "" : "none";
    // A discovery result is guidance, not a broken radio installation. Keeping
    // this optional fourth control out of that case keeps the compact card to a
    // single action row.
    setup.style.display = status?.installed === false ? "" : "none";
    info.classList.toggle("failed", !!(State.airdropError || State.airdropReceiveError));
    info.textContent = State.airdropError || State.airdropReceiveError || State.airdropReceiveDetail?.message || (State.airdropOutbound ? outboundLabel() : "") || State.airdropNotice || (State.airdropDiscovering
      ? State.airdropPeers.some(peer => peer.connection)
        ? "Nearby AirDrop service detected · checking its connection. Send unlocks when its name is verified."
        : "Finding nearby devices · keep the iPhone unlocked in Everyone mode."
      : State.airdropScanning
      ? "Keep the iPhone unlocked, Everyone for 10 Minutes enabled, and its Share sheet closed."
      : starting ? "Starting AirDrop radio…" : status?.message) || (on
      ? `${status?.name || State.airdropActiveName ? `Receiving as ${status?.name || State.airdropActiveName}` : "Receiver running"} · ready for an iPhone`
      : "Off · turn on to receive from an iPhone");
    destination.textContent = on
      ? status?.directory ? `Saves to ${status.directory}`
        : State.airdropActiveDirectory ? `Saves to ${State.airdropActiveDirectory}`
          : `Configured save folder: ${State.settings.airdropDirectory || "~/Downloads"} · active receiver destination unverified`
      : "";
    destination.title = destination.textContent || "";
    transfer.sync();
    requestAnimationFrame(measureContent);
    const receiveBusy = State.airdropTransfer === "receiving" || State.airdropTransfer === "verifying";
    const signature = JSON.stringify([State.airdropScanning, State.airdropSending, State.airdropPending, receiveBusy, State.airdropPeers.slice(0, 32)]);
    if (signature === peerSignature) return;
    peerSignature = signature;
    clear(peers);
    if (State.airdropScanning) peers.append(h("span", { text: "Looking for nearby devices…" }));
    for (const peer of State.airdropPeers.slice(0, 32)) {
      const recent = !!peer.name && peer.lastSeen != null && !peer.fresh;
      const connecting = peer.connection === "connecting" || peer.connection === "retrying";
      const peerLabel = connecting ? `AirDrop device · ${peer.connection === "retrying" ? "connection slow, retrying" : "connecting…"}`
        : `${peer.name || `Apple device · ${peer.mac}`}${recent ? " · recently seen" : ""}`;
      peers.append(h("div", { class: "airdrop-view-peer" },
        h("span", { class: "airdrop-view-peer-name",
          title: recent ? `${peer.name} · recently seen; connection will be checked before sending` : peerLabel,
          text: peerLabel }),
        h("button", { class: "airdrop-view-send", type: "button", disabled: !peer.name || State.airdropSending || State.airdropScanning || State.airdropPending || receiveBusy,
          onclick: () => void sendAirDrop(peer.mac) }, connecting ? "Checking…" : State.airdropSending ? t("Sending…") : t("Send"))));
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
