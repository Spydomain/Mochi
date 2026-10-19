// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerShortcutHandlers } from "./island/shortcuts";
import { Wellbeing } from "./island/wellbeing";
import { applySpotify, registerSpotifyHandlers } from "./island/spotify";
import { SPOTIFY_ID } from "./core/spotify";
import { Recap } from "./recap/recap";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";
import { applyAirDropReceive, refreshAirDrop, refreshAirDropActivity } from "./views/airdrop";

/** Shows the language Settings asks for ("" = the system's, when Mochi has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  const island = new Island(root);
  const wellbeing = new Wellbeing(island);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  void Bridge.keepAwakeStatus().then((enabled) => {
    if (enabled !== null && !State.keepAwakePending) {
      State.keepAwake = enabled;
      State.notify();
    }
  });
  void refreshAirDrop();
  window.setInterval(() => {
    if (State.os !== "linux") return;
    void refreshAirDrop();
  }, 8_000);
  let checkingIncoming = false;
  let incomingCheckQueued = false;
  let checkingTransfer = false;
  let completedAt = 0;
  let lastTransferCheck = 0;
  const checkIncoming = () => {
    // Native file-change notification wakes a long-hidden WebKit page; the
    // fallback poll recovers events missed while the page was starting.
    if (State.os !== "linux") return;
    if (checkingIncoming) { incomingCheckQueued = true; return; }
    checkingIncoming = true;
    void (async () => {
      try {
        const pending = await Bridge.airdropIncoming();
        if (!pending) State.airdropAnsweredId = null;
        const request = pending?.id === State.airdropAnsweredId ? null : pending;
        if (request) {
          if (request.id !== State.airdropRequest?.id) {
            State.airdropRequest = request;
            State.airdropError = "";
            State.airdropReceiveError = "";
            State.notify();
          }
          // A busy agent or a stale hidden-state transition must not strand an
          // existing request behind another card. Never answer it implicitly.
          if (State.view !== "airdropRequest" || State.mode !== "expanded") island.alert("airdropRequest");
        } else if (State.airdropRequest || State.view === "airdropRequest") {
          // Answered, declined or expired: the request file is gone, so release
          // the pinned consent card. This must not depend on a *change* in
          // request id - decide() already cleared State.airdropRequest, which
          // left the island pinned open on a dead card forever.
          State.airdropRequest = null;
          if (State.view === "airdropRequest") {
            island.finishAirDropRequest();
            if (State.airdropTransfer && !State.pendingApproval) island.collapse();
          }
          State.notify();
        }
      } catch (err) {
        console.error("[mochi] AirDrop consent check failed", err);
      } finally {
        checkingIncoming = false;
        if (incomingCheckQueued) {
          incomingCheckQueued = false;
          checkIncoming();
        }
      }
    })();
  };
  await onEvent<null>("airdrop-incoming", checkIncoming);
  checkIncoming();
  window.setInterval(checkIncoming, 200);
  window.setInterval(() => { void refreshAirDropActivity(); }, 350);
  window.setInterval(() => {
    if (State.os !== "linux" || checkingTransfer) return;
    if (!State.airdropStatus?.receiving) {
      if (State.airdropTransfer || State.airdropProgress || State.airdropReceiveDetail || State.airdropReceiveError) {
        completedAt = applyAirDropReceive(null, 0);
        State.notify();
      }
      return;
    }
    // Archive reads may be slow. They must never delay the consent poll.
    checkingTransfer = true;
    void (async () => {
      try {
        const now = Date.now();
        if (now - lastTransferCheck < (["receiving", "verifying"].includes(State.airdropTransfer || "") ? 200 : 1_000)) return;
        lastTransferCheck = now;
        const transfer = await Bridge.airdropTransfer();
        // A read started before Turn off must not resurrect its old warning.
        if (!State.airdropStatus?.receiving) return;
        const previous = State.airdropTransfer;
        const previousReceived = State.airdropProgress?.receivedBytes;
        const previousTotal = State.airdropProgress?.totalBytes;
        const previousDetail = JSON.stringify(State.airdropReceiveDetail);
        const previousError = State.airdropReceiveError;
        completedAt = applyAirDropReceive(transfer, completedAt);
        if (State.airdropTransfer !== previous || State.airdropProgress?.receivedBytes !== previousReceived ||
            State.airdropProgress?.totalBytes !== previousTotal || State.airdropReceiveError !== previousError ||
            JSON.stringify(State.airdropReceiveDetail) !== previousDetail) State.notify();
      } catch (err) {
        console.error("[mochi] AirDrop transfer check failed", err);
      } finally { checkingTransfer = false; }
    })();
  }, 350);
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  island.weather.start();
  if (State.settings.soundEnabled) void Sound.preload();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();
  await island.desktop.init();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<boolean>("pointer-inside", (inside) => island.setPointerInside(inside));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    island.weather.sync();
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "wardrobe":
        setPaused(false);
        island.alert("wardrobe");
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const previousMain = State.mainPillId;
    const previousWeather = JSON.stringify([State.settings.weatherEnabled, State.settings.weatherLocation,
      State.settings.weatherAutoLocation, State.settings.weatherLocateMe, State.settings.weatherLocationUpdatedAt]);
    State.settings = { ...State.settings, ...s };
    if (previousWeather !== JSON.stringify([s.weatherEnabled, s.weatherLocation,
      s.weatherAutoLocation, s.weatherLocateMe, s.weatherLocationUpdatedAt])) island.weather.settingsChanged();
    applyLanguage();
    island.applySettings();
    State.loadIntegrationTasks();
    // A new main tool comes to the front, as on macOS.
    if (State.mainPillId !== previousMain) State.setFocus(State.mainPillId);
    void refreshConfigured();
  });

  const recoverAgentSessions = registerHookHandlers(island);
  registerIntegrationHandlers(island);
  registerShortcutHandlers(island, () => setPaused(false));
  registerSpotifyHandlers(island);
  // Rust may have read Spotify before this page listened: ask once.
  if (State.settings.activeIntegrations.includes(SPOTIFY_ID)) {
    void Bridge.spotifyRefresh().then((s) => s && applySpotify(island, s));
  }

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  island.onGreetingDone = () => {
    checkRecap();
    window.setTimeout(() => wellbeing.check(), 900);
  };
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  island.launch();
  void recoverAgentSessions();
  wellbeing.start();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
