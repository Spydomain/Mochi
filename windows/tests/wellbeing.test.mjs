import { test } from "node:test";
import assert from "node:assert/strict";

const { periodAt, greetingFor, careReminder, companionMoodState, Wellbeing } = await import("../src/island/wellbeing.ts");
const { State } = await import("../src/core/state.ts");

test("greetings follow local time and remain English", () => {
  assert.equal(periodAt(5), "night");
  assert.equal(periodAt(8), "morning");
  assert.equal(periodAt(14), "afternoon");
  assert.equal(periodAt(19), "evening");
  assert.equal(periodAt(23), "night");
  assert.match(greetingFor(8), /^Good morning!/);
  assert.match(greetingFor(19), /^Good evening!/);
  assert.match(greetingFor(23), /^Good night!/);
  assert.match(careReminder(23), /sleeping/);
  assert.match(careReminder(13), /Stretch/);
});

test("night mood sleeps only when idle and music is off", () => {
  assert.equal(companionMoodState("idle", true, false), "sleeping");
  assert.equal(companionMoodState("idle", true, true), "idle");
  assert.equal(companionMoodState("working", true, false), "working");
  assert.equal(companionMoodState("idle", false, false), "idle");
});

test("active companion greets once and reminds after two hours", () => {
  const stored = new Map();
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  State.paused = false;
  State.pendingApproval = null;
  State.mode = "compact";
  State.view = "overview";
  const notices = [];
  const moods = [];
  const wellbeing = new Wellbeing({
    showNotice: (message) => notices.push(message),
    setNightMood: (on) => moods.push(on),
  });
  const now = new Date();
  wellbeing.check(now);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^Good /);
  assert.equal(moods.at(-1), periodAt(now.getHours()) === "night");
  wellbeing.check(now);
  assert.equal(notices.length, 1);

  const later = new Date(now.getTime() + 2 * 60 * 60 * 1000 + 60_000);
  stored.set("mochi.lastGreeting", `${later.getFullYear()}-${later.getMonth() + 1}-${later.getDate()}.${periodAt(later.getHours())}`);
  wellbeing.check(later);
  assert.equal(notices.length, 2);
  assert.equal(notices[1], careReminder(later.getHours()));
  wellbeing.check(later);
  assert.equal(notices.length, 2);
});

test("12:37 AM activates sleep and gives a good-night reminder without interrupting work", () => {
  const stored = new Map();
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  State.paused = false;
  State.pendingApproval = null;
  State.mode = "compact";
  State.view = "overview";
  const notices = [];
  const moods = [];
  const wellbeing = new Wellbeing({
    showNotice: (message) => notices.push(message),
    setNightMood: (on) => moods.push(on),
  });
  const night = new Date(2026, 9, 10, 0, 37);
  wellbeing.startedAt = night.getTime();
  wellbeing.lastReminder = night.getTime();
  wellbeing.check(night);
  assert.equal(moods.at(-1), true);
  assert.match(notices[0], /^Good night!/);

  State.view = "prompt";
  State.mode = "expanded";
  wellbeing.check(new Date(2026, 9, 10, 1, 38));
  assert.equal(moods.at(-1), true);
  assert.equal(notices.length, 1, "chat should not be interrupted by a reminder");

  State.view = "overview";
  State.mode = "compact";
  wellbeing.check(new Date(2026, 9, 10, 1, 39));
  assert.match(notices.at(-1), /^Good night\./);
  wellbeing.check(new Date(2026, 9, 10, 7, 0));
  assert.equal(moods.at(-1), false);
});

test("starting wellbeing applies the current sleep state immediately", () => {
  const moods = [];
  const wellbeing = new Wellbeing({ showNotice: () => {}, setNightMood: (on) => moods.push(on) });
  const originalInterval = window.setInterval;
  let intervalMs;
  window.setInterval = (_fn, ms) => { intervalMs = ms; return 1; };
  try {
    wellbeing.start();
    assert.equal(moods[0], periodAt(new Date().getHours()) === "night");
    assert.equal(intervalMs, 60_000);
  } finally {
    window.setInterval = originalInterval;
  }
});

test("restarting at night reminds when due but does not nag on repeated restarts", () => {
  const night = new Date(2026, 9, 10, 0, 37);
  const key = `${night.getFullYear()}-${night.getMonth() + 1}-${night.getDate()}.night`;
  const stored = new Map([["mochi.lastGreeting", key]]);
  globalThis.localStorage = {
    getItem: (name) => stored.get(name) ?? null,
    setItem: (name, value) => stored.set(name, value),
  };
  State.paused = false;
  State.pendingApproval = null;
  State.mode = "compact";
  State.view = "overview";
  const notices = [];
  const host = { showNotice: (message) => notices.push(message), setNightMood: () => {} };
  const first = new Wellbeing(host);
  first.startedAt = night.getTime();
  first.lastReminder = night.getTime();
  first.check(night);
  assert.match(notices[0], /^Good night\./);

  const second = new Wellbeing(host);
  second.check(new Date(night.getTime() + 10 * 60_000));
  assert.equal(notices.length, 1);
  second.check(new Date(night.getTime() + 61 * 60_000));
  assert.equal(notices.length, 2);
  assert.match(notices[1], /^Good night\./);
});
