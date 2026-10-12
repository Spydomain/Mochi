/** Open-Meteo's current forecast, fetched only for an opted-in location. */
export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
}

export interface WeatherReport {
  weatherCode: number;
  isDay: boolean;
  temperatureC: number;
  precipitationMm: number;
  highC: number | null;
  lowC: number | null;
  observedAt: string;
}

export type WeatherScene = "day" | "night" | "rain" | "snow" | "cloudy";

/** WMO precipitation codes; actual precipitation also catches a new shower
 * before the provider has changed its descriptive code. */
export function weatherScene(report: WeatherReport | null, localHour: number): WeatherScene {
  if (!report) return localHour >= 19 || localHour < 6 ? "night" : "day";
  const code = report.weatherCode;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)
    || report.precipitationMm > 0) return "rain";
  if (code === 3 || code === 45 || code === 48) return "cloudy";
  return report.isDay ? "day" : "night";
}

export function weatherDescription(code: number): string {
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Snow";
  if (code >= 95) return "Thunderstorm";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "Rain";
  if (code === 45 || code === 48) return "Fog";
  if (code === 3) return "Cloudy";
  if (code === 2) return "Partly cloudy";
  return "Clear";
}
