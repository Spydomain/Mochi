// Weather controller for the Clock card. Its CSS scene stops animating when the
// Clock is not focused, Mochi is paused, or reduced motion is requested. One
// forecast request per 15 minutes at most; night sky also works offline.

import { Bridge, emitToWindow } from "../core/bridge";
import { locateMe } from "../core/location";
import { State } from "../core/state";
import { weatherScene, type WeatherReport } from "../core/weather";

const WEATHER_INTERVAL = 15 * 60_000;
const STALE_AFTER = 45 * 60_000;
const LOCATION_INTERVAL = 24 * 60 * 60_000;
const LOCATION_RETRY = 60 * 60_000;
// GeoClue and the network can become ready after the graphical session starts.
// Keep these retries bounded so a machine with only a coarse fix stays quiet.
const STARTUP_RETRY_DELAYS = [2 * 60_000, 10 * 60_000];

// Shared with the Clock card; an attempt timestamp does not mean it has failed.
export const weatherForecastStatus = { loading: false };

export class WeatherBackdrop {
  private report: WeatherReport | null = null;
  private reportKey = "";
  private fetchedAt = 0;
  private attemptedAt = 0;
  private key = "";
  private pending = false;
  private generation = 0;
  private visualKey = "";
  private lastLocationAttempt = 0;
  private locationPending = false;
  private startupLocationCheck = true;
  private startupFailures = 0;
  private nextStartupAttemptAt = 0;
  private previousLocateMe = false;

  start() {
    this.previousLocateMe = State.settings.weatherLocateMe;
    this.sync();
    State.subscribe(() => this.sync());
    void this.refreshLocation();
    void this.refresh();
    // One inexpensive clock check also handles day/night and forecast expiry.
    window.setInterval(() => {
      this.sync();
      void this.refreshLocation();
      void this.refresh();
    }, 60_000);
  }

  settingsChanged() {
    if (State.settings.weatherLocateMe
      && (!this.previousLocateMe || State.settings.weatherLocationUpdatedAt === 0)) {
      this.lastLocationAttempt = 0;
      this.nextStartupAttemptAt = 0;
    }
    this.previousLocateMe = State.settings.weatherLocateMe;
    const location = State.settings.weatherLocation;
    const keepReport = State.settings.weatherEnabled && location
      && this.reportKey === `${location.latitude},${location.longitude}`;
    this.generation++;
    this.attemptedAt = 0;
    this.key = "";
    if (!keepReport) {
      this.fetchedAt = 0;
      this.report = null;
      this.reportKey = "";
      State.weatherReport = null;
      State.weatherFetchedAt = 0;
    }
    State.weatherAttemptedAt = 0;
    this.sync();
    State.notify();
    void this.refreshLocation();
    void this.refresh();
  }

  private async refreshLocation() {
    const settings = State.settings;
    if (!settings.weatherEnabled || !settings.weatherAutoLocation || State.paused || this.locationPending) return;
    const now = Date.now();
    const startup = this.startupLocationCheck && settings.weatherLocateMe;
    const retryInterval = settings.weatherLocateMe ? LOCATION_INTERVAL : LOCATION_RETRY;
    if (startup ? now < this.nextStartupAttemptAt
      : now - settings.weatherLocationUpdatedAt < LOCATION_INTERVAL
        || now - this.lastLocationAttempt < retryInterval) return;
    this.lastLocationAttempt = now;
    this.locationPending = true;
    const locateMode = settings.weatherLocateMe;
    let succeeded = false;
    try {
      // Existing IP-only users retain their original daily check. "Locate me"
      // never upgrades a coarse GeoClue/IP fix into a falsely precise city.
      const location = locateMode
        ? await locateMe()
        : await Bridge.weatherAutoLocation();
      if (!location || !State.settings.weatherEnabled || !State.settings.weatherAutoLocation
        || State.settings.weatherLocateMe !== locateMode) return;
      succeeded = true;
      // On startup the native settings-changed event can arrive before the
      // listener is registered. Apply the command result directly as well so
      // the first forecast never depends on that event's timing.
      const previous = State.settings.weatherLocation;
      State.settings.weatherLocation = location;
      State.settings.weatherLocationUpdatedAt = Date.now();
      if (JSON.stringify(previous) !== JSON.stringify(location)) this.settingsChanged();
    } catch (err) {
      console.warn("[mochi] Automatic weather location unavailable", err);
    } finally {
      this.locationPending = false;
      if (startup && State.settings.weatherLocateMe) {
        if (succeeded) this.startupLocationCheck = false;
        else {
          this.startupFailures++;
          if (this.startupFailures <= STARTUP_RETRY_DELAYS.length) {
            this.nextStartupAttemptAt = Date.now() + STARTUP_RETRY_DELAYS[this.startupFailures - 1];
          } else this.startupLocationCheck = false;
        }
      }
      void emitToWindow("settings", "weather-location-result", { ok: succeeded });
    }
  }

  sync() {
    const clockFocused = !State.paused && State.mode === "expanded" && State.view === "overview"
      && State.focusTask?.id === "integration_clock";
    const current = this.report && Date.now() - this.fetchedAt < STALE_AFTER ? this.report : null;
    const scene = weatherScene(current, new Date().getHours());
    const key = `${clockFocused}:${scene}:${!!current}`;
    if (key === this.visualKey) return;
    this.visualKey = key;
    document.body.dataset.weatherScene = clockFocused ? scene : "off";
    document.body.dataset.weatherLive = current ? "true" : "false";
  }

  private async refresh() {
    const location = State.settings.weatherLocation;
    if (!State.settings.weatherEnabled || !location || State.paused) return;
    const key = `${location.latitude},${location.longitude}`;
    if (this.pending || (this.key === key && Date.now() - this.attemptedAt < WEATHER_INTERVAL)) return;
    this.pending = true;
    this.key = key;
    this.attemptedAt = Date.now();
    State.weatherAttemptedAt = this.attemptedAt;
    const generation = this.generation;
    weatherForecastStatus.loading = true;
    State.notify();
    try {
      const report = await Bridge.weatherForecast();
      const currentLocation = State.settings.weatherLocation;
      if (generation !== this.generation || !State.settings.weatherEnabled
        || !currentLocation || key !== `${currentLocation.latitude},${currentLocation.longitude}`) return;
      if (report) {
        this.report = report;
        this.reportKey = key;
        this.fetchedAt = Date.now();
        State.weatherReport = report;
        State.weatherFetchedAt = this.fetchedAt;
        this.sync();
      }
    } catch (err) {
      if (generation === this.generation) console.warn("[mochi] Weather forecast unavailable", err);
    } finally {
      this.pending = false;
      weatherForecastStatus.loading = false;
      // settingsChanged invalidates this request, but its replacement could
      // not start while pending. Drain the latest settings without a timer tick.
      if (generation !== this.generation) void this.refresh();
      this.sync();
      State.notify();
    }
  }
}
