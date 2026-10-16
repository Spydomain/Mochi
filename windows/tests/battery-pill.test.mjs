import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";
import { State, DEFAULT_SETTINGS } from "../src/core/state.ts";
import { buildHeader } from "../src/views/views.ts";

installFakeDom();

test("battery badge follows the current reading and charging state", () => {
  const previous = { settings: State.settings, view: State.view, power: State.powerStatus };
  State.settings = { ...DEFAULT_SETTINGS, showCodexPlanInNotch: true, showBatteryInNotch: true };
  State.view = "overview";
  try {
    const header = buildHeader({});
    const battery = header.el.querySelector(".battery-status-pill");
    const bolt = header.el.querySelector(".battery-bolt");
    const plug = header.el.querySelector(".battery-plug");
    header.sync();
    assert.equal(battery.style.display, "none");

    State.powerStatus = { pluggedIn: true, charging: true, level: 80 };
    header.sync();
    assert.equal(battery.style.display, "");
    assert.equal(battery.textContent, "80%");
    assert.equal(battery.getAttribute("aria-label"), "Charging, 80%");
    assert.equal(bolt.style.display, "");
    assert.equal(plug.style.display, "none");
    assert.equal(battery.querySelector(".battery-fill").style.width, "80%");

    State.powerStatus = { pluggedIn: true, charging: false, level: 80 };
    header.sync();
    assert.equal(battery.getAttribute("aria-label"), "Plugged in, not charging, 80%");
    assert.equal(bolt.style.display, "none");
    assert.equal(plug.style.display, "");

    State.powerStatus = { pluggedIn: false, charging: false, level: 15 };
    header.sync();
    assert.equal(battery.getAttribute("aria-label"), "On battery, 15%");
    assert.equal(battery.classList.contains("low"), true);
    assert.equal(plug.style.display, "none");

    State.settings.showBatteryInNotch = false;
    header.sync();
    assert.equal(battery.style.display, "none");
    State.settings.showBatteryInNotch = true;

    State.view = "settings";
    header.sync();
    assert.equal(battery.style.display, "none");
    State.view = "overview";
    State.powerStatus = null;
    header.sync();
    assert.equal(battery.style.display, "none");
  } finally {
    State.settings = previous.settings;
    State.view = previous.view;
    State.powerStatus = previous.power;
  }
});
