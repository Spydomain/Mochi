import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { weatherDescription, weatherScene } from "../src/core/weather.ts";
import { WeatherBackdrop } from "../src/island/weather.ts";
import { Bridge } from "../src/core/bridge.ts";
import { deviceWeatherLocation, locateMe } from "../src/core/location.ts";
import { State } from "../src/core/state.ts";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const report = (weatherCode, isDay, precipitationMm = 0) => ({
  weatherCode, isDay, precipitationMm, temperatureC: 12, highC: 17, lowC: 8, observedAt: "2026-10-12T10:45",
});

test("night sky works offline and daytime remains quiet", () => {
  assert.equal(weatherScene(null, 23), "night");
  assert.equal(weatherScene(null, 2), "night");
  assert.equal(weatherScene(null, 12), "day");
});

test("live rain and snow take priority over the clear night sky", () => {
  assert.equal(weatherScene(report(61, false), 23), "rain");
  assert.equal(weatherScene(report(0, true, 0.3), 12), "rain");
  assert.equal(weatherScene(report(73, false), 23), "snow");
  assert.equal(weatherScene(report(0, false), 12), "night");
  assert.equal(weatherScene(report(3, true), 12), "cloudy");
  assert.equal(weatherDescription(95), "Thunderstorm");
});

test("weather animation runs only behind the focused Clock card", () => {
  const backdrop = new WeatherBackdrop();
  const oldTasks = State.tasks;
  const oldFocus = State.focusId;
  const oldMode = State.mode;
  const oldView = State.view;
  const oldPaused = State.paused;
  try {
    State.tasks = [{ id: "integration_clock" }, { id: "integration_media" }];
    State.focusId = "integration_clock";
    State.view = "overview";
    State.mode = "expanded";
    State.paused = false;
    backdrop.sync();
    assert.notEqual(document.body.dataset.weatherScene, "off");
    State.focusId = "integration_media";
    backdrop.sync();
    assert.equal(document.body.dataset.weatherScene, "off");
    State.focusId = "integration_clock";
    State.mode = "compact";
    backdrop.sync();
    assert.equal(document.body.dataset.weatherScene, "off");
    State.mode = "expanded";
    State.paused = true;
    backdrop.sync();
    assert.equal(document.body.dataset.weatherScene, "off");
  } finally {
    State.tasks = oldTasks;
    State.focusId = oldFocus;
    State.mode = oldMode;
    State.view = oldView;
    State.paused = oldPaused;
  }
});

test("automatic location checks only after opt-in and once a day", async () => {
  const backdrop = new WeatherBackdrop();
  const oldMethod = Bridge.weatherAutoLocation;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let calls = 0;
  Bridge.weatherAutoLocation = async () => { calls++; return null; };
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: false, weatherLocationUpdatedAt: 0 };
    await backdrop.refreshLocation();
    assert.equal(calls, 0);
    State.settings.weatherAutoLocation = true;
    State.settings.weatherLocationUpdatedAt = Date.now();
    await backdrop.refreshLocation();
    assert.equal(calls, 0);
    State.settings.weatherLocationUpdatedAt = 0;
    await backdrop.refreshLocation();
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
    State.paused = true;
    backdrop.lastLocationAttempt = 0;
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
  } finally {
    Bridge.weatherAutoLocation = oldMethod;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("Locate me rechecks on startup but preserves the saved city when the device fix is coarse", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldAuto = Bridge.weatherAutoLocation;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let calls = 0;
  let ipCalls = 0;
  const location = { name: "Kathmandu, Nepal (approximate IP location)", latitude: 27.7, longitude: 85.3 };
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) {
      calls++;
      success({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    },
  } });
  Bridge.weatherAutoLocation = async () => { ipCalls++; return null; };
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: true, weatherLocation: location, weatherLocationUpdatedAt: Date.now() };
    const backdrop = new WeatherBackdrop();
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
    assert.equal(ipCalls, 0);
    assert.deepEqual(State.settings.weatherLocation, location);
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    Bridge.weatherAutoLocation = oldAuto;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("each app start rechecks Locate me even with a recent saved location", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let calls = 0;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) {
      calls++;
      success({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    },
  } });
  try {
    State.paused = false;
    const saved = { name: "Kathmandu, Nepal", latitude: 27.70169, longitude: 85.3206 };
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: true, weatherLocation: saved, weatherLocationUpdatedAt: Date.now() };
    await new WeatherBackdrop().refreshLocation();
    await new WeatherBackdrop().refreshLocation(); // Simulate a fresh app after reboot.
    assert.equal(calls, 2);
    assert.deepEqual(State.settings.weatherLocation, saved);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("Locate me retries shortly after login, then backs off after three failed fixes", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldNow = Date.now;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let now = 1_800_000_000_000;
  let calls = 0;
  Date.now = () => now;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) {
      calls++;
      success({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    },
  } });
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: true, weatherLocationUpdatedAt: now - 1_000 };
    const backdrop = new WeatherBackdrop();
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
    now += 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
    now += 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 2);
    now += 10 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 3);
    now += 60 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 3);
    now += 24 * 60 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 4);
  } finally {
    Date.now = oldNow;
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("a later accurate startup fix replaces the saved city and ends startup retries", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldDevice = Bridge.weatherSetDeviceLocation;
  const oldNow = Date.now;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let now = 1_800_000_000_000;
  let calls = 0;
  Date.now = () => now;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) {
      calls++;
      success({ coords: calls === 1
        ? { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 }
        : { latitude: 28.2096, longitude: 83.9856, accuracy: 100 } });
    },
  } });
  Bridge.weatherSetDeviceLocation = async (latitude, longitude) =>
    ({ name: "Pokhara, Nepal", latitude, longitude });
  try {
    State.paused = false;
    const saved = { name: "Kathmandu, Nepal", latitude: 27.7, longitude: 85.3 };
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: true, weatherLocation: saved, weatherLocationUpdatedAt: now - 1_000 };
    const backdrop = new WeatherBackdrop();
    await backdrop.refreshLocation();
    assert.deepEqual(State.settings.weatherLocation, saved);
    now += 2 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(State.settings.weatherLocation.name, "Pokhara, Nepal");
    assert.equal(State.settings.weatherLocationUpdatedAt, now);
    now += 10 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 2);
  } finally {
    Date.now = oldNow;
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    Bridge.weatherSetDeviceLocation = oldDevice;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("an in-flight IP lookup cannot replace Locate me's saved city", async () => {
  const oldAuto = Bridge.weatherAutoLocation;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let finish;
  Bridge.weatherAutoLocation = () => new Promise((resolve) => { finish = resolve; });
  try {
    State.paused = false;
    const saved = { name: "Kathmandu, Nepal", latitude: 27.7, longitude: 85.3 };
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: false, weatherLocation: saved, weatherLocationUpdatedAt: 0 };
    const pending = new WeatherBackdrop().refreshLocation();
    State.settings.weatherLocateMe = true;
    finish({ name: "Birgunj, Nepal (approximate IP location)", latitude: 27.0174, longitude: 84.8805 });
    await pending;
    assert.deepEqual(State.settings.weatherLocation, saved);
  } finally {
    Bridge.weatherAutoLocation = oldAuto;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("failed Locate me checks retry daily, not hourly", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let calls = 0;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) {
      calls++;
      success({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    },
  } });
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: true, weatherLocationUpdatedAt: 0 };
    const backdrop = new WeatherBackdrop();
    backdrop.startupLocationCheck = false;
    backdrop.lastLocationAttempt = Date.now() - 2 * 60 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 0);
    backdrop.lastLocationAttempt = Date.now() - 25 * 60 * 60_000;
    await backdrop.refreshLocation();
    assert.equal(calls, 1);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("Locate me prefers a device position and does not call the IP provider", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldDevice = Bridge.weatherSetDeviceLocation;
  const oldAuto = Bridge.weatherAutoLocation;
  let deviceCalls = 0;
  let ipCalls = 0;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success, _error, options) {
      assert.equal(options.enableHighAccuracy, true);
      success({ coords: { latitude: 27.7, longitude: 85.3, accuracy: 50 } });
    },
  } });
  Bridge.weatherSetDeviceLocation = async (latitude, longitude, accuracyMeters) => {
    deviceCalls++;
    assert.deepEqual([latitude, longitude, accuracyMeters], [27.7, 85.3, 50]);
    return { name: "Kathmandu, Nepal", latitude, longitude };
  };
  Bridge.weatherAutoLocation = async () => { ipCalls++; return null; };
  try {
    assert.equal((await locateMe())?.name, "Kathmandu, Nepal");
    assert.equal(deviceCalls, 1);
    assert.equal(ipCalls, 0);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    Bridge.weatherSetDeviceLocation = oldDevice;
    Bridge.weatherAutoLocation = oldAuto;
  }
});

test("Locate me never switches to an IP city when device naming fails", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldDevice = Bridge.weatherSetDeviceLocation;
  const oldAuto = Bridge.weatherAutoLocation;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) { success({ coords: { latitude: 27.7, longitude: 85.3, accuracy: 100 } }); },
  } });
  Bridge.weatherSetDeviceLocation = async () => null;
  let ipCalls = 0;
  Bridge.weatherAutoLocation = async () => { ipCalls++; return null; };
  try {
    assert.equal(await locateMe(), null);
    assert.equal(ipCalls, 0);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    Bridge.weatherSetDeviceLocation = oldDevice;
    Bridge.weatherAutoLocation = oldAuto;
  }
});

test("a 25 km GeoClue fix is not accepted as a precise city", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(success) {
      success({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    },
  } });
  try {
    assert.equal(await deviceWeatherLocation(), null);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
  }
});

test("Locate me waits for a better Wi-Fi fix and releases the location watch", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  let update;
  const cleared = [];
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    watchPosition(success, _error, options) {
      assert.equal(options.enableHighAccuracy, true);
      update = success;
      return 42;
    },
    clearWatch(id) { cleared.push(id); },
  } });
  try {
    let settled = false;
    const pending = deviceWeatherLocation().then((fix) => { settled = true; return fix; });
    update({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    await Promise.resolve();
    assert.equal(settled, false);
    update({ coords: { latitude: 27.7, longitude: 85.3, accuracy: 250 } });
    const fix = await pending;
    assert.deepEqual([fix.latitude, fix.longitude, fix.accuracyMeters], [27.7, 85.3, 250]);
    assert.deepEqual(cleared, [42]);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
  }
});

test("a watch with only coarse fixes times out without naming the wrong city", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldTimeout = window.setTimeout;
  const oldClearTimeout = window.clearTimeout;
  let expire;
  let update;
  let cleared = false;
  window.setTimeout = (callback) => { expire = callback; return 9; };
  window.clearTimeout = () => {};
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    watchPosition(success) { update = success; return 42; },
    clearWatch(id) { assert.equal(id, 42); cleared = true; },
  } });
  try {
    const pending = deviceWeatherLocation();
    update({ coords: { latitude: 27.0174, longitude: 84.8805, accuracy: 25_000 } });
    expire();
    assert.equal(await pending, null);
    assert.equal(cleared, true);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    window.setTimeout = oldTimeout;
    window.clearTimeout = oldClearTimeout;
  }
});

test("an older IP-only opt-in never requests device positioning", async () => {
  const oldGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const oldAuto = Bridge.weatherAutoLocation;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  let deviceCalls = 0;
  let ipCalls = 0;
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition() { deviceCalls++; },
  } });
  Bridge.weatherAutoLocation = async () => { ipCalls++; return null; };
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: false, weatherLocationUpdatedAt: 0 };
    await new WeatherBackdrop().refreshLocation();
    assert.equal(deviceCalls, 0);
    assert.equal(ipCalls, 1);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    Bridge.weatherAutoLocation = oldAuto;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("automatic location starts a forecast even if the startup event was missed", async () => {
  const oldAuto = Bridge.weatherAutoLocation;
  const oldForecast = Bridge.weatherForecast;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  const location = { name: "Kathmandu, Nepal (approximate IP location)", latitude: 27.7, longitude: 85.3 };
  let forecasts = 0;
  Bridge.weatherAutoLocation = async () => location;
  Bridge.weatherForecast = async () => { forecasts++; return report(0, true); };
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocation: null, weatherLocationUpdatedAt: 0 };
    const backdrop = new WeatherBackdrop();
    await backdrop.refreshLocation();
    assert.deepEqual(State.settings.weatherLocation, location);
    assert.ok(State.settings.weatherLocationUpdatedAt > 0);
    assert.equal(forecasts, 1);
  } finally {
    Bridge.weatherAutoLocation = oldAuto;
    Bridge.weatherForecast = oldForecast;
    State.settings = oldSettings;
    State.paused = oldPaused;
  }
});

test("one forecast feeds both the Clock details and the clear-day scene", async () => {
  const oldMethod = Bridge.weatherForecast;
  const oldSettings = State.settings;
  const oldReport = State.weatherReport;
  const oldFetchedAt = State.weatherFetchedAt;
  const oldMode = State.mode;
  const oldTasks = State.tasks;
  const oldFocus = State.focusId;
  const oldView = State.view;
  const oldPaused = State.paused;
  const sample = report(0, true);
  Bridge.weatherForecast = async () => sample;
  try {
    State.mode = "expanded";
    State.tasks = [{ id: "integration_clock" }];
    State.focusId = "integration_clock";
    State.view = "overview";
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherLocation: {
      name: "Kathmandu, Nepal", latitude: 27.7, longitude: 85.3,
    } };
    const backdrop = new WeatherBackdrop();
    await backdrop.refresh();
    assert.equal(State.weatherReport, sample);
    assert.equal(document.body.dataset.weatherScene, "day");
    assert.equal(document.body.dataset.weatherLive, "true");
  } finally {
    Bridge.weatherForecast = oldMethod;
    State.settings = oldSettings;
    State.weatherReport = oldReport;
    State.weatherFetchedAt = oldFetchedAt;
    State.mode = oldMode;
    State.tasks = oldTasks;
    State.focusId = oldFocus;
    State.view = oldView;
    State.paused = oldPaused;
  }
});

test("the weather layer stays inside the Clock card and below its text", () => {
  const island = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(island, /this\.weather\.el/);
  assert.match(css, /\.weather-backdrop\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.clock-card > :not\(\.weather-backdrop\)\s*\{[^}]*z-index:\s*1/);
});

test("Settings offers Locate me and Find city without a second automatic-location button", () => {
  const settings = readFileSync(new URL("../src/settings/main.ts", import.meta.url), "utf8");
  assert.match(settings, /text: "Locate me"/);
  assert.match(settings, /text: "Find city"/);
  assert.doesNotMatch(settings, /text: "Use automatic location"|text: "Use current location/);
});
