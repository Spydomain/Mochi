import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { weatherDescription, weatherScene } from "../src/core/weather.ts";
import { WeatherBackdrop } from "../src/island/weather.ts";
import { Bridge } from "../src/core/bridge.ts";
import { locateMe } from "../src/core/location.ts";
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

test("Locate me rechecks on startup even with a recent saved IP position", async () => {
  const oldAuto = Bridge.weatherAutoLocation;
  const oldSettings = State.settings;
  const oldPaused = State.paused;
  const calls = [];
  const location = { name: "Kathmandu, Nepal (approximate IP location)", latitude: 27.7, longitude: 85.3 };
  Bridge.weatherAutoLocation = async (force) => { calls.push(force); return location; };
  try {
    State.paused = false;
    State.settings = { ...oldSettings, weatherEnabled: true, weatherAutoLocation: true,
      weatherLocateMe: true, weatherLocation: location, weatherLocationUpdatedAt: Date.now() };
    const backdrop = new WeatherBackdrop();
    await backdrop.refreshLocation();
    assert.deepEqual(calls, [true]);
    await backdrop.refreshLocation();
    assert.deepEqual(calls, [true]);
  } finally {
    Bridge.weatherAutoLocation = oldAuto;
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
    getCurrentPosition(success) { success({ coords: { latitude: 27.7, longitude: 85.3 } }); },
  } });
  Bridge.weatherSetDeviceLocation = async (latitude, longitude) => {
    deviceCalls++;
    assert.deepEqual([latitude, longitude], [27.7, 85.3]);
    return { name: "Current location", latitude, longitude };
  };
  Bridge.weatherAutoLocation = async () => { ipCalls++; return null; };
  try {
    assert.equal((await locateMe(true))?.name, "Current location");
    assert.equal(deviceCalls, 1);
    assert.equal(ipCalls, 0);
  } finally {
    if (oldGeo) Object.defineProperty(navigator, "geolocation", oldGeo);
    else delete navigator.geolocation;
    Bridge.weatherSetDeviceLocation = oldDevice;
    Bridge.weatherAutoLocation = oldAuto;
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
