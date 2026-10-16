// Local clock for the overview's focused card. It wakes only once a minute.
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { createWeatherLayer } from "./weather-layer";
import { State } from "../core/state";
import { weatherDescription, type WeatherLocation, type WeatherReport } from "../core/weather";
import { weatherForecastStatus } from "../island/weather";

export function clockText(now: Date): string {
  return `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")} ${now.getHours() < 12 ? "AM" : "PM"}`;
}

export function clockWeatherText(location: WeatherLocation, report: WeatherReport): string {
  const city = location.name === "Current location" ? "Finding city name…"
    : location.name.split(",")[0].replace(/ \(approximate.*\)$/, "");
  const prefix = location.name.includes("approximate IP location") ? "Approx. " : "";
  return `${prefix}${city} · ${Math.round(report.temperatureC)}°C · ${weatherDescription(report.weatherCode)}`;
}

export function buildClockCard() {
  const cardTime = h("div", { class: "clock-card-time" });
  const cardDate = h("div", { class: "clock-card-date" });
  const cardWeather = h("div", { class: "clock-card-weather", role: "status" });
  const el = h("div", { class: "clock-card" },
    createWeatherLayer("clock-weather"),
    h("div", { class: "who" }, svg(ICONS.clock, 14), h("span", { class: "name", text: "Clock" }), h("span", { class: "tool", text: "Local time" })),
    cardTime, cardDate, cardWeather,
  );
  let timer: number | null = null;

  function updateWeather() {
    const location = State.settings.weatherLocation;
    const report = State.weatherReport;
    if (!State.settings.weatherEnabled || !location) {
      cardWeather.textContent = "";
      cardWeather.title = "";
      return;
    }
    if (report) {
      const stale = Date.now() - State.weatherFetchedAt >= 45 * 60_000;
      cardWeather.textContent = `${clockWeatherText(location, report)}${stale ? " · Stale" : ""}`;
      const range = report.highC != null && report.lowC != null
        ? ` · High ${Math.round(report.highC)}°C · Low ${Math.round(report.lowC)}°C`
        : "";
      const updated = stale
        ? ` · Last updated ${new Date(State.weatherFetchedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
        : "";
      cardWeather.title = `${cardWeather.textContent}${range}${updated}`;
    } else {
      cardWeather.textContent = weatherForecastStatus.loading || !State.weatherAttemptedAt
        ? "Loading weather…" : "Weather unavailable";
      cardWeather.title = cardWeather.textContent;
    }
  }

  function update() {
    const now = new Date();
    cardTime.textContent = clockText(now);
    cardDate.textContent = new Intl.DateTimeFormat("en", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    }).format(now);
    updateWeather();
    // Align the next update with the minute boundary; no animation loop or
    // timer is kept while this card is not focused.
    timer = window.setTimeout(update, 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds());
  }

  return {
    el,
    sync(visible: boolean) {
      if (!visible) {
        if (timer != null) window.clearTimeout(timer);
        timer = null;
      } else if (timer == null) {
        update();
      } else {
        updateWeather();
      }
    },
  };
}
