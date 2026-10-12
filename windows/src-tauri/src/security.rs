//! A local network snapshot for the System card. Collected only when clicked.

use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySnapshot {
    pub addresses: Vec<String>,
    pub listening: Vec<String>,
    pub established: usize,
}

#[tauri::command]
pub async fn security_snapshot() -> SecuritySnapshot {
    tauri::async_runtime::spawn_blocking(sample).await.unwrap_or_else(|_| SecuritySnapshot {
        addresses: Vec::new(), listening: Vec::new(), established: 0,
    })
}

#[cfg(target_os = "linux")]
fn sample() -> SecuritySnapshot {
    let output = |command: &str, args: &[&str]| -> String {
        Command::new(command).args(args).output().ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let addresses = output("ip", &["-o", "-4", "addr", "show", "scope", "global"])
        .lines().filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            (parts.len() > 3 && parts[2] == "inet")
                .then(|| format!("{} {}", parts[1], parts[3]))
        }).take(8).collect();
    let listening = output("ss", &["-H", "-l", "-t", "-u", "-n"])
        .lines().filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            (parts.len() > 4).then(|| format!("{} {}", parts[0], parts[4]))
        }).take(12).collect();
    let established = output("ss", &["-H", "-t", "-n", "state", "established"])
        .lines().count();
    SecuritySnapshot { addresses, listening, established }
}

#[cfg(not(target_os = "linux"))]
fn sample() -> SecuritySnapshot {
    SecuritySnapshot { addresses: Vec::new(), listening: Vec::new(), established: 0 }
}
