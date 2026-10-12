// Opt-in weather for the island backdrop. Only fixed HTTPS endpoints are
// contacted: Open-Meteo for forecasts/cities and ipwho.is for optional IP
// location. No API key or arbitrary URL input.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const REFRESH_AFTER: Duration = Duration::from_secs(15 * 60);

struct Cached {
    location: WeatherLocation,
    at: Instant,
    result: Result<WeatherReport, String>,
}

fn cache() -> &'static tokio::sync::Mutex<Option<Cached>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeatherLocation {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
}

impl WeatherLocation {
    pub fn valid(&self) -> bool {
        self.latitude.is_finite()
            && self.latitude.abs() <= 90.0
            && self.longitude.is_finite()
            && self.longitude.abs() <= 180.0
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeatherReport {
    pub weather_code: i64,
    pub is_day: bool,
    pub temperature_c: f64,
    pub precipitation_mm: f64,
    pub high_c: Option<f64>,
    pub low_c: Option<f64>,
    pub observed_at: String,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("valid weather HTTP client")
    })
}

fn parse_location(v: &Value) -> Option<WeatherLocation> {
    let entry = v.get("results")?.as_array()?.first()?;
    let city = entry.get("name")?.as_str()?.trim();
    let country = entry
        .get("country")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let location = WeatherLocation {
        name: if country.is_empty() {
            city.to_string()
        } else {
            format!("{city}, {country}")
        },
        latitude: entry.get("latitude")?.as_f64()?,
        longitude: entry.get("longitude")?.as_f64()?,
    };
    if city.is_empty() || !location.valid() {
        return None;
    }
    Some(location)
}

fn parse_ip_location(v: &Value) -> Option<WeatherLocation> {
    if v.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let city = v.get("city")?.as_str()?.trim();
    let country = v.get("country")?.as_str()?.trim();
    if city.is_empty() || country.is_empty() {
        return None;
    }
    let location = WeatherLocation {
        name: format!("{city}, {country} (approximate IP location)"),
        latitude: v.get("latitude")?.as_f64()?,
        longitude: v.get("longitude")?.as_f64()?,
    };
    location.valid().then_some(location)
}

/// Called only after the user opts into automatic location. The server sees
/// the public IP; only the city and coordinates are retained by Mochi.
pub async fn ip_location() -> Result<WeatherLocation, String> {
    let response = client()
        .get("https://ipwho.is/")
        .send()
        .await
        .map_err(|_| "Automatic location service unavailable.")?
        .error_for_status()
        .map_err(|_| "Automatic location service unavailable.")?;
    let body: Value = response.json().await.map_err(|_| "Invalid automatic location response.")?;
    parse_ip_location(&body).ok_or_else(|| "Automatic location unavailable for this connection.".into())
}

fn parse_report(v: &Value) -> Option<WeatherReport> {
    let current = v.get("current")?;
    let day = v.get("daily");
    let report = WeatherReport {
        weather_code: current.get("weather_code")?.as_i64()?,
        is_day: current.get("is_day")?.as_i64()? != 0,
        temperature_c: current.get("temperature_2m")?.as_f64()?,
        precipitation_mm: current.get("precipitation")?.as_f64()?,
        high_c: day
            .and_then(|d| d.get("temperature_2m_max"))
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_f64),
        low_c: day
            .and_then(|d| d.get("temperature_2m_min"))
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_f64),
        observed_at: current.get("time")?.as_str()?.to_string(),
    };
    if !report.temperature_c.is_finite() || !report.precipitation_mm.is_finite() {
        return None;
    }
    Some(report)
}

pub async fn find_city(query: String) -> Result<WeatherLocation, String> {
    let query = query.trim();
    if query.chars().count() < 2 || query.chars().count() > 80 {
        return Err("Enter a city name (2–80 characters).".into());
    }
    let response = client()
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", query), ("count", "1"), ("language", "en")])
        .send()
        .await
        .map_err(|_| "City search is unavailable.")?
        .error_for_status()
        .map_err(|_| "City search is unavailable.")?;
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Invalid city search response.")?;
    parse_location(&body).ok_or_else(|| "City not found. Try City, Country.".into())
}

pub async fn forecast(location: &WeatherLocation) -> Result<WeatherReport, String> {
    if !location.valid() {
        return Err("Invalid weather location.".into());
    }
    let mut cached = cache().lock().await;
    if let Some(entry) = cached.as_ref() {
        if entry.location.latitude == location.latitude
            && entry.location.longitude == location.longitude
            && entry.at.elapsed() < REFRESH_AFTER
        {
            return entry.result.clone();
        }
    }
    let result = fetch_forecast(location).await;
    *cached = Some(Cached {
        location: location.clone(),
        at: Instant::now(),
        result: result.clone(),
    });
    result
}

async fn fetch_forecast(location: &WeatherLocation) -> Result<WeatherReport, String> {
    let response = client()
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", location.latitude.to_string()),
            ("longitude", location.longitude.to_string()),
            (
                "current",
                "temperature_2m,precipitation,weather_code,is_day".into(),
            ),
            ("daily", "temperature_2m_max,temperature_2m_min".into()),
            ("forecast_days", "1".into()),
            ("timezone", "auto".into()),
        ])
        .send()
        .await
        .map_err(|_| "Weather service is unavailable.")?
        .error_for_status()
        .map_err(|_| "Weather service is unavailable.")?;
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Invalid weather response.")?;
    parse_report(&body).ok_or_else(|| "Invalid weather response.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_location_and_parses_city() {
        let city = parse_location(&json!({"results":[{"name":"Kathmandu","country":"Nepal","latitude":27.7,"longitude":85.3}]})).unwrap();
        assert_eq!(city.name, "Kathmandu, Nepal");
        assert!(city.valid());
        assert!(!WeatherLocation {
            name: "bad".into(),
            latitude: f64::NAN,
            longitude: 0.0
        }
        .valid());
        assert!(parse_location(&json!({"results":[]})).is_none());
    }

    #[test]
    fn ip_location_requires_a_real_city_and_valid_coordinates() {
        let value = json!({"success":true,"city":"Kathmandu","country":"Nepal","latitude":27.7,"longitude":85.3});
        let location = parse_ip_location(&value).unwrap();
        assert!(location.name.contains("approximate IP location"));
        assert!(parse_ip_location(&json!({"success":false,"city":"Kathmandu","country":"Nepal","latitude":27.7,"longitude":85.3})).is_none());
        assert!(parse_ip_location(&json!({"success":true,"city":"Kathmandu","country":"Nepal","latitude":900.0,"longitude":85.3})).is_none());
    }

    #[tokio::test]
    #[ignore = "requires a live ipwho.is connection; run explicitly when diagnosing automatic location"]
    async fn live_ip_location_probe() {
        let location = ip_location().await.expect("IP location service should answer");
        assert!(location.valid());
    }

    #[test]
    fn parses_current_and_daily_forecast() {
        let report = parse_report(&json!({
            "current":{"time":"2026-10-12T10:45","temperature_2m":17.3,"precipitation":0.5,"weather_code":61,"is_day":1},
            "daily":{"temperature_2m_max":[20.1],"temperature_2m_min":[12.2]}
        })).unwrap();
        assert_eq!(report.weather_code, 61);
        assert_eq!(report.high_c, Some(20.1));
        assert_eq!(report.low_c, Some(12.2));
        assert!(parse_report(&json!({"current":{"weather_code":61}})).is_none());
    }
}
