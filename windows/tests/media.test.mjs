// The generic Media card is backed by Linux MPRIS. Keep its compact custom
// picker and all transport commands covered: a native <select> previously grew
// tall enough to hide the buttons, while the backend had no selected target.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import { renderIntegrationCard } from "../src/views/integrations.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { IDLE_SPOTIFY, Spotify } from "../src/core/spotify.ts";
import { ICONS } from "../src/views/icons.ts";

installFakeDom();

const task = {
  id: "integration_media", name: "Media", color: "#F5A524", state: "idle", stepIndex: 0, steps: [],
  source: "n8n", isIntegration: true,
};

const hooks = { detailOpen: false, openDetail() {}, closeDetail() {}, openSettings() {} };

beforeEach(() => {
  calls.length = 0;
  State.os = "linux";
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: ["integration_media"] };
  State.integrations = {
    integration_media: {
      loaded: true, configured: true, error: null,
      data: {
        activeBus: "org.mpris.MediaPlayer2.brave.instance1",
        players: [
          { bus: "org.mpris.MediaPlayer2.brave.instance1", name: "Brave", title: "Afreen Afreen", artist: "Rahat", album: "Topic", playing: true },
          { bus: "org.mpris.MediaPlayer2.vlc", name: "VLC", title: "Other track", artist: "", album: "", playing: false },
        ],
      },
    },
  };
  Spotify.state = { ...IDLE_SPOTIFY };
});

test("Media has a compact picker and sends every transport action to its selected player", () => {
  const card = renderIntegrationCard(task, hooks);
  assert.ok(card.classList.contains("media-card"));
  assert.match(card.textContent, /Afreen Afreen.*Rahat.*Topic.*Brave/);

  const [picker, brave, vlc, previous, playPause, next] = card.find("BUTTON");
  picker.fire("click");
  assert.ok(card.querySelector("media-picker-menu").classList.contains("open"));
  vlc.fire("click");
  previous.fire("click");
  playPause.fire("click");
  next.fire("click");

  assert.deepEqual(sent("media_set_player"), [{ bus: "org.mpris.MediaPlayer2.vlc" }]);
  assert.deepEqual(sent("media_control"), [
    { action: "previous", bus: "org.mpris.MediaPlayer2.vlc" },
    { action: "play", bus: "org.mpris.MediaPlayer2.vlc" },
    { action: "next", bus: "org.mpris.MediaPlayer2.vlc" },
  ]);
  assert.equal(brave.textContent, "Brave ▶");
});

test("selecting a player immediately syncs metadata, toggle capability, label and glyph without a native event", () => {
  const players = State.integrations.integration_media.data.players;
  players[0].canPause = false;
  players[1].artist = "Other artist";
  players[1].album = "Other album";
  players[1].canPlay = true;
  const card = renderIntegrationCard(task, hooks);
  const [picker, brave, vlc, , playPause] = card.find("BUTTON");
  const glyph = () => playPause.find("PATH")[0].getAttribute("d");
  assert.equal(playPause.getAttribute("disabled"), "");
  picker.fire("click");
  vlc.fire("click");
  assert.equal(card.querySelector(".np-title").textContent, "Other track");
  assert.equal(card.querySelector(".np-sub").textContent, "Other artist · Other album · VLC");
  assert.equal(card.querySelector(".media-picker-button").textContent, "VLC");
  assert.equal(playPause.getAttribute("title"), "Play playback");
  assert.equal(playPause.getAttribute("aria-label"), "Play playback");
  assert.equal(playPause.getAttribute("disabled"), null);
  assert.equal(glyph(), ICONS.play);
  assert.ok(!card.querySelector(".media-picker-menu").classList.contains("open"));
  playPause.fire("click");
  assert.deepEqual(sent("media_control"), [{ action: "play", bus: players[1].bus }]);

  picker.fire("click");
  brave.fire("click");
  assert.equal(card.querySelector(".np-title").textContent, "Afreen Afreen");
  assert.equal(card.querySelector(".np-sub").textContent, "Rahat · Topic · Brave");
  assert.equal(playPause.getAttribute("title"), "Pause playback");
  assert.equal(playPause.getAttribute("aria-label"), "Pause playback");
  assert.equal(playPause.getAttribute("disabled"), "");
  assert.equal(glyph(), ICONS.pause);
  playPause.fire("click");
  assert.equal(sent("media_control").length, 1, "do not send a forbidden toggle");
});

test("a browser reporting no skip capability still lets MPRIS handle skip commands", () => {
  State.integrations.integration_media.data = {
    activeBus: "org.mpris.MediaPlayer2.firefox.instance2",
    players: [{ bus: "org.mpris.MediaPlayer2.firefox.instance2", name: "Firefox",
      title: "Live stream", playing: true, canPlay: true, canPause: true,
      canGoNext: false, canGoPrevious: false }],
  };
  const card = renderIntegrationCard(task, hooks);
  const [picker, option, previous, playPause, next] = card.find("BUTTON");
  assert.equal(picker.getAttribute("disabled"), null);
  assert.equal(option.getAttribute("disabled"), null);
  assert.equal(previous.getAttribute("disabled"), null);
  assert.equal(next.getAttribute("disabled"), null);
  previous.fire("click");
  next.fire("click");
  playPause.fire("click");
  assert.deepEqual(sent("media_control"), [
    { action: "previous", bus: "org.mpris.MediaPlayer2.firefox.instance2" },
    { action: "next", bus: "org.mpris.MediaPlayer2.firefox.instance2" },
    { action: "pause", bus: "org.mpris.MediaPlayer2.firefox.instance2" },
  ]);
});

test("Media playback joins Spotify in Mochi's dance state only when the pill is declared", () => {
  assert.ok(State.mediaPlaying);
  assert.ok(State.musicPlaying);
  State.settings.activeIntegrations = [];
  assert.ok(!State.mediaPlaying);
  assert.ok(!State.musicPlaying);
});
