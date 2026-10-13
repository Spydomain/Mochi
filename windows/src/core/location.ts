// Device positioning is requested only after the user explicitly picks
// "Locate me". GeoClue may return an IP-derived fix tens of kilometres away;
// do not reverse-geocode such a fix into a falsely precise city name.
import { Bridge } from "./bridge";
import type { WeatherLocation } from "./weather";

export const MAX_DEVICE_ACCURACY_METERS = 5_000;

interface DeviceFix extends WeatherLocation {
  accuracyMeters: number;
}

function accurateFix(position: GeolocationPosition): DeviceFix | null {
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180
    || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_DEVICE_ACCURACY_METERS) return null;
  return { name: "Device location", latitude, longitude, accuracyMeters: accuracy };
}

export function deviceWeatherLocation(): Promise<DeviceFix | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  const geolocation = navigator.geolocation;
  const options = { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 };
  if (typeof geolocation.watchPosition === "function" && typeof geolocation.clearWatch === "function") {
    return new Promise((resolve) => {
      let settled = false;
      let watchId: number | undefined;
      let clearWhenReady = false;
      const timer = window.setTimeout(() => finish(null), 15_000);
      function finish(fix: DeviceFix | null) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (watchId !== undefined) geolocation.clearWatch(watchId);
        else clearWhenReady = true; // A test/browser may call back synchronously.
        resolve(fix);
      }
      try {
        watchId = geolocation.watchPosition(
          (position) => {
            const fix = accurateFix(position);
            if (fix) finish(fix); // Keep watching if the first fix is coarse.
          },
          () => finish(null),
          options,
        );
        if (clearWhenReady) geolocation.clearWatch(watchId);
      } catch {
        finish(null);
      }
    });
  }
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) => resolve(accurateFix(position)),
      () => resolve(null),
      options,
    );
  });
}

export async function locateMe(): Promise<WeatherLocation | null> {
  const device = await deviceWeatherLocation();
  if (!device) return null;
  return Bridge.weatherSetDeviceLocation(device.latitude, device.longitude, device.accuracyMeters);
}
