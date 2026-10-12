import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { buildClockCard, clockText, clockWeatherText } from "../src/views/clock.ts";
import { State } from "../src/core/state.ts";

installFakeDom();

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
