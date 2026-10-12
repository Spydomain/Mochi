//! Local power status for the charging animation. Reading sysfs does not wake a
//! device or require a network service; the page asks every few seconds.

use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    pub plugged_in: bool,
    pub level: u8,
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub fn power_status() -> Option<PowerStatus> {
    let entries = std::fs::read_dir("/sys/class/power_supply").ok()?;
    let mut battery = None;
    let mut plugged_in = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let kind = std::fs::read_to_string(path.join("type")).unwrap_or_default();
        match kind.trim() {
            "Battery" => {
                let level = std::fs::read_to_string(path.join("capacity"))
                    .ok().and_then(|s| s.trim().parse::<u8>().ok());
                if let Some(level) = level {
                    battery = Some(level.min(100));
                }
            }
            "Mains" | "USB" | "USB_C" | "USB_PD" => {
                plugged_in |= std::fs::read_to_string(path.join("online"))
                    .map(|s| s.trim() == "1").unwrap_or(false);
            }
            _ => {}
        }
    }
    battery.map(|level| PowerStatus { plugged_in, level })
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn power_status() -> Option<PowerStatus> {
    None
}
