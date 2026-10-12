import { test } from "node:test";
import assert from "node:assert/strict";
import { SoundEngine } from "../src/core/sound.ts";
import { Bridge } from "../src/core/bridge.ts";

test("sound decodes frequent cues at startup and rare cues only when played", async () => {
  const oldCtor = window.AudioContext;
  const oldFetch = globalThis.fetch;
  const oldCustom = Bridge.customSounds;
  const fetched = [];
  const started = [];
  class FakeContext {
    state = "running";
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    createBufferSource() { return { connect() {}, start() { started.push(true); } }; }
    async decodeAudioData() { return {}; }
    async resume() { this.state = "running"; }
  }
  window.AudioContext = FakeContext;
  Bridge.customSounds = async () => [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  };
  try {
    const engine = new SoundEngine();
    await engine.preload();
    assert.deepEqual(fetched, ["/sounds/peek.wav", "/sounds/open.wav",
      "/sounds/close.wav", "/sounds/greeting.wav"]);
    engine.play("love");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetched.filter((x) => x === "/sounds/love.wav").length, 1);
    assert.equal(started.length, 1);
    engine.play("love");
    assert.equal(started.length, 2);
    engine.setEnabled(false);
    engine.play("error");
    assert.equal(fetched.includes("/sounds/error.wav"), false);
  } finally {
    window.AudioContext = oldCtor;
    globalThis.fetch = oldFetch;
    Bridge.customSounds = oldCustom;
  }
});
