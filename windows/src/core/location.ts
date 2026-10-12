// Device positioning is requested only after the user explicitly picks
// "Locate me". If the OS cannot provide it, use the opt-in IP fallback.
import { Bridge } from "./bridge";
import type { WeatherLocation } from "./weather";

export function deviceWeatherLocation(): Promise<WeatherLocation | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        name: "Current location",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 0 },
    );
  });
}

export async function locateMe(forceIp = false): Promise<WeatherLocation | null> {
  const device = await deviceWeatherLocation();
  if (device) return Bridge.weatherSetDeviceLocation(device.latitude, device.longitude);
  return Bridge.weatherAutoLocation(forceIp);
}
