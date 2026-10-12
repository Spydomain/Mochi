// Reuse the same inexpensive particles in the island shell and the Clock card.
// Only the foreground location poller chooses a scene; this draws no data and
// performs no network requests of its own.
import { h } from "./dom";

export function createWeatherLayer(extraClass = ""): HTMLElement {
  const stars = h("div", { class: "weather-stars" });
  for (let i = 0; i < 15; i++) {
    stars.append(h("i", { style: `--x:${(i * 43 + 9) % 97}%;--y:${(i * 29 + 13) % 78}%;--delay:${-(i % 5) * 0.7}s` }));
  }
  const rain = h("div", { class: "weather-rain" });
  for (let i = 0; i < 15; i++) {
    rain.append(h("i", { style: `--x:${(i * 37 + 7) % 98}%;--delay:${-(i % 7) * 0.17}s` }));
  }
  const snow = h("div", { class: "weather-snow" });
  for (let i = 0; i < 12; i++) {
    snow.append(h("i", { style: `--x:${(i * 41 + 11) % 97}%;--delay:${-(i % 6) * 0.53}s` }));
  }
  const clouds = h("div", { class: "weather-clouds" }, h("i"), h("i"));
  return h("div", { class: `weather-backdrop ${extraClass}`.trim(), "aria-hidden": "true" },
    h("div", { class: "weather-sun" }), clouds,
    h("div", { class: "weather-moon" }), stars, rain, snow);
}
