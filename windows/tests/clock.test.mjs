import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { buildClockCard, clockText, clockWeatherText } from "../src/views/clock.ts";
import { State } from "../src/core/state.ts";
import { Bridge } from "../src/core/bridge.ts";
import { WeatherBackdrop } from "../src/island/weather.ts";

installFakeDom();

test("Clock stays loading during initial and retry forecasts and reports failure only after completion", async () => {
  const oldForecast = Bridge.weatherForecast;
  const oldNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const saved = { settings: State.settings, paused: State.paused,
    weatherReport: State.weatherReport, weatherFetchedAt: State.weatherFetchedAt,
    weatherAttemptedAt: State.weatherAttemptedAt };
  const oldSet = window.setTimeout;
  const oldClear = window.clearTimeout;
  window.setTimeout = () => 1;
  window.clearTimeout = () => {};
  let finish;
  let pending;
  let unsubscribe = () => {};
  Bridge.weatherForecast = () => new Promise((resolve) => { finish = resolve; });
  try {
    State.paused = false;
    State.settings = { ...saved.settings, weatherEnabled: true, weatherAutoLocation: false,
      weatherLocation: { name: "Kathmandu, Nepal", latitude: 27.7, longitude: 85.3 } };
    State.weatherReport = null;
    State.weatherFetchedAt = 0;
    State.weatherAttemptedAt = 0;
    const clock = buildClockCard();
    const weather = clock.el.querySelector(".clock-card-weather");
    clock.sync(true);
    assert.equal(weather.textContent, "Loading weather…");
    const updates = [];
    unsubscribe = State.subscribe(() => { clock.sync(true); updates.push(weather.textContent); });
    const backdrop = new WeatherBackdrop();
    pending = backdrop.refresh();
    clock.sync(true);
    assert.ok(State.weatherAttemptedAt > 0);
    assert.equal(weather.textContent, "Loading weather…");
    assert.ok(updates.includes("Loading weather…"), "starting a request notifies the focused card");
    finish(null);
    await pending;
    assert.equal(weather.textContent, "Weather unavailable", "completion notifies the focused card");
    now += 15 * 60_000;
    pending = backdrop.refresh();
    assert.equal(weather.textContent, "Loading weather…", "a previous failure does not hide a pending retry");
    finish({ weatherCode: 0, isDay: true, temperatureC: 24, precipitationMm: 0,
      highC: null, lowC: null, observedAt: "2026-10-12T11:20" });
    await pending;
    assert.equal(weather.textContent, "Kathmandu · 24°C · Clear");
    clock.sync(false);
  } finally {
    finish?.(null);
    await pending;
    unsubscribe();
    Bridge.weatherForecast = oldForecast;
    Date.now = oldNow;
    Object.assign(State, saved);
    window.setTimeout = oldSet;
    window.clearTimeout = oldClear;
  }
});

test("Clock retains and labels stale weather during a refresh and after an offline failure", async () => {
  const oldForecast = Bridge.weatherForecast;
  const oldNow = Date.now;
  const saved = { settings: State.settings, paused: State.paused,
    weatherReport: State.weatherReport, weatherFetchedAt: State.weatherFetchedAt,
    weatherAttemptedAt: State.weatherAttemptedAt };
  const oldSet = window.setTimeout;
  const oldClear = window.clearTimeout;
  window.setTimeout = () => 1;
  window.clearTimeout = () => {};
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const sample = { weatherCode: 0, isDay: true, temperatureC: 24, precipitationMm: 0,
    highC: 25, lowC: 16, observedAt: "2026-10-12T11:20" };
  let finish;
  let pending;
  let unsubscribe = () => {};
  try {
    State.paused = false;
    State.settings = { ...saved.settings, weatherEnabled: true, weatherAutoLocation: false,
      weatherLocation: { name: "Kathmandu, Nepal", latitude: 27.7, longitude: 85.3 } };
    Bridge.weatherForecast = async () => sample;
    const backdrop = new WeatherBackdrop();
    await backdrop.refresh();
    const fetchedAt = State.weatherFetchedAt;
    now += 46 * 60_000;
    const clock = buildClockCard();
    const weather = clock.el.querySelector(".clock-card-weather");
    clock.sync(true);
    assert.equal(weather.textContent, "Kathmandu · 24°C · Clear · Stale");
    assert.match(weather.title, /Last updated/);
    unsubscribe = State.subscribe(() => clock.sync(true));
    Bridge.weatherForecast = () => new Promise((resolve) => { finish = resolve; });
    pending = backdrop.refresh();
    assert.equal(weather.textContent, "Kathmandu · 24°C · Clear · Stale");
    finish(null);
    await pending;
    assert.equal(State.weatherReport, sample);
    assert.equal(State.weatherFetchedAt, fetchedAt, "a failed refresh cannot make old data appear fresh");
    assert.equal(weather.textContent, "Kathmandu · 24°C · Clear · Stale");
    assert.equal(document.body.dataset.weatherLive, "false");
    clock.sync(false);
  } finally {
    finish?.(null);
    await pending;
    unsubscribe();
    Bridge.weatherForecast = oldForecast;
    Date.now = oldNow;
    Object.assign(State, saved);
    window.setTimeout = oldSet;
    window.clearTimeout = oldClear;
  }
});

test("clock uses local 12-hour time, including midnight and noon", () => {
  assert.equal(clockText(new Date(2026, 9, 11, 0, 5)), "12:05 AM");
  assert.equal(clockText(new Date(2026, 9, 11, 12, 0)), "12:00 PM");
  assert.equal(clockText(new Date(2026, 9, 11, 21, 37)), "9:37 PM");
});

test("clock schedules one aligned update only while the overview is visible", () => {
  const originalSet = window.setTimeout;
  const originalClear = window.clearTimeout;
  const scheduled = [];
  const cancelled = [];
  window.setTimeout = (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; };
  window.clearTimeout = (id) => cancelled.push(id);
  try {
    const clock = buildClockCard();
    assert.ok(clock.el.children[0].classList.contains("clock-weather"));
    assert.equal(scheduled.length, 0);
    clock.sync(true);
    assert.match(clock.el.textContent, /\d{1,2}:\d\d [AP]M/);
    assert.match(clock.el.textContent, /ClockLocal time/);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0].delay > 0 && scheduled[0].delay <= 60_000);
    clock.sync(true);
    assert.equal(scheduled.length, 1);
    clock.sync(false);
    assert.deepEqual(cancelled, [1]);
    clock.sync(true);
    assert.equal(scheduled.length, 2);
    clock.sync(false);
  } finally {
    window.setTimeout = originalSet;
    window.clearTimeout = originalClear;
  }
});

test("focused Clock shows the selected city's live weather without overflow", () => {
  const oldSettings = State.settings;
  const oldReport = State.weatherReport;
  const oldFetchedAt = State.weatherFetchedAt;
  const oldSet = window.setTimeout;
  const oldClear = window.clearTimeout;
  window.setTimeout = () => 1;
  window.clearTimeout = () => {};
  const report = { weatherCode: 0, isDay: true, temperatureC: 24, precipitationMm: 0,
    highC: 25, lowC: 16, observedAt: "2026-10-12T11:20" };
  try {
    State.settings = { ...oldSettings, weatherEnabled: true, weatherLocation: {
      name: "Kathmandu, Nepal", latitude: 27.7, longitude: 85.3,
    } };
    State.weatherReport = report;
    State.weatherFetchedAt = Date.now();
    const clock = buildClockCard();
    clock.sync(true);
    const weather = clock.el.querySelector(".clock-card-weather");
    assert.equal(weather.textContent, "Kathmandu · 24°C · Clear");
    assert.equal(weather.title, "Kathmandu · 24°C · Clear · High 25°C · Low 16°C");
    assert.equal(clockWeatherText({ name: "Kathmandu, Nepal (approximate IP location)", latitude: 27.7, longitude: 85.3 }, report), "Approx. Kathmandu · 24°C · Clear");
    State.settings.weatherEnabled = false;
    clock.sync(true);
    assert.equal(clock.el.querySelector(".clock-card-weather").textContent, "");
    clock.sync(false);
  } finally {
    State.settings = oldSettings;
    State.weatherReport = oldReport;
    State.weatherFetchedAt = oldFetchedAt;
    window.setTimeout = oldSet;
    window.clearTimeout = oldClear;
  }
});
