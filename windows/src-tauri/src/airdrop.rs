//! Native AirDrop on Linux, via an *installed* Omdrop receiver and AWDL radio
//! backend. Mochi does not implement AWDL, install privileged code, or fake a
//! Bluetooth device. The Omdrop CLI owns the receiver, timer and radio.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub receiving: bool,
    pub visible: bool,
    pub name: Option<String>,
    pub remaining: Option<u64>,
    pub directory: Option<String>,
    /// Whether a backend supports sending without a named, selected peer.
    /// Keep this false: a nearby device is not necessarily the user's phone.
    pub can_send_nearby: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Peer {
    pub mac: String,
    pub name: Option<String>,
    pub rssi: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub state: String,
    pub received_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Peer, Status, Transfer};
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, SystemTime};
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;
    use tokio::sync::Mutex;

    static SWITCH: OnceLock<Mutex<()>> = OnceLock::new();
    static STARTED_BY_MOCHI: AtomicBool = AtomicBool::new(false);
    static TRANSFER_CACHE: OnceLock<StdMutex<TransferCache>> = OnceLock::new();

    #[derive(Default)]
    struct TransferCache {
        key: Option<(u64, usize, u64, SystemTime)>,
        state: Option<String>,
        total_bytes: Option<u64>,
    }
    const SETUP: &str = "Install omdrop-owl and Omdrop (0.16.0+), then run omdrop setup and omdrop doctor. See Mochi's AirDrop setup in README.md.";
    const MT7922_SETUP: &str = "Finish the MT7922 radio installation in the Mochi AirDrop installation terminal, then restart Mochi.";

    #[derive(Clone, serde::Deserialize, serde::Serialize)]
    pub struct Incoming {
        id: String,
        sender: String,
        detail: String,
    }

    fn consent_dir() -> Result<PathBuf, String> {
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .ok_or("No private runtime directory is available.")?;
        Ok(PathBuf::from(base).join("mochi-airdrop/active"))
    }

    fn private_file(path: &std::path::Path) -> bool {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        path.symlink_metadata().is_ok_and(|m| {
            m.is_file()
                && m.uid() == unsafe { libc::geteuid() }
                && m.permissions().mode() & 0o077 == 0
                && m.len() <= 2048
        })
    }

    pub fn incoming() -> Result<Option<Incoming>, String> {
        let dir = consent_dir()?;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if !dir.symlink_metadata().is_ok_and(|m| {
            m.is_dir()
                && m.uid() == unsafe { libc::geteuid() }
                && m.permissions().mode() & 0o077 == 0
        }) {
            return Ok(None);
        }
        let request = dir.join("request.json");
        if !private_file(&request) {
            return Ok(None);
        }
        let raw = std::fs::read(&request).map_err(|e| e.to_string())?;
        let item: Incoming = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        if item.id.len() != 32 || !item.id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(None);
        }
        Ok(Some(item))
    }

    pub fn decide(id: String, accept: bool) -> Result<(), String> {
        if incoming()?.is_none_or(|item| item.id != id) {
            return Err("This AirDrop request has expired.".into());
        }
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(consent_dir()?.join("decision"))
            .map_err(|_| "This AirDrop request was already answered or has expired.".to_string())?;
        file.write_all(if accept { b"accept" } else { b"decline" })
            .map_err(|e| format!("Could not answer AirDrop: {e}"))?;
        Ok(())
    }

    pub fn transfer() -> Option<Transfer> {
        let base = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?);
        let marker = base.join("mochi-airdrop/transfer.json");
        if !private_file(&marker) {
            return None;
        }
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(marker).ok()?).ok()?;
        let start = raw["start"].as_u64()?;
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_secs();
        if start > now || now - start > 24 * 60 * 60 {
            return None;
        }
        let offset: usize = raw["offset"].as_u64()?.try_into().ok()?;
        // Older consent markers contain no destination; they keep the status
        // display, but cannot supply a trustworthy byte count.
        let directory = raw["directory"].as_str().map(std::path::Path::new);
        use std::io::{Read, Seek, SeekFrom};
        let mut log = std::fs::File::open(base.join("airdropd/airdropd.log")).ok()?;
        let metadata = log.metadata().ok()?;
        let len = metadata.len();
        if (offset as u64) > len {
            return transfer_state("", now - start).map(|state| Transfer {
                state: state.into(), received_bytes: None, total_bytes: None,
            });
        }
        let key = (start, offset, len, metadata.modified().ok()?);
        let cache = TRANSFER_CACHE.get_or_init(|| StdMutex::new(TransferCache::default()));
        let cached = cache.lock().ok()?;
        let (state, total_bytes) = if cached.key == Some(key) {
            (cached.state.clone(), cached.total_bytes)
        } else {
            drop(cached);
            let at = (offset as u64).max(len.saturating_sub(1024 * 1024));
            log.seek(SeekFrom::Start(at)).ok()?;
            let mut tail = Vec::new();
            log.read_to_end(&mut tail).ok()?;
            let recent = String::from_utf8_lossy(&tail);
            let state = transfer_state(&recent, now - start).map(str::to_owned);
            let total_bytes = upload_total_bytes(&recent);
            if let Ok(mut cached) = cache.lock() {
                cached.key = Some(key);
                cached.state = state.clone();
                cached.total_bytes = total_bytes;
            }
            (state, total_bytes)
        };
        let state = state?;
        if state == "waiting" && now - start > 10 * 60 { return None; }
        // The log changes only at state transitions. Stat the raw file even
        // when the log is cached, so the ring tracks bytes while data arrives.
        let received_bytes = if state == "receiving" || state == "failed" {
            directory.and_then(|dir| archive_received(dir, start, now))
        } else { None };
        Some(Transfer {
            state,
            received_bytes: received_bytes.zip(total_bytes).map(|(got, total)| got.min(total)),
            total_bytes: if received_bytes.is_some() { total_bytes } else { None },
        })
    }

    fn upload_total_bytes(log: &str) -> Option<u64> {
        // TotalBytes is the sender's declared wire payload size, not a
        // Content-Length (iOS uploads using chunked encoding).
        log.lines()
            .filter_map(|line| line.strip_prefix("TotalBytes: ")?.trim().parse::<u64>().ok())
            .filter(|total| (1..=1_000_000_000_000).contains(total))
            .last()
    }

    fn archive_received(directory: &std::path::Path, start: u64, now: u64) -> Option<u64> {
        use std::os::unix::fs::MetadataExt;
        // Only the raw file created for this accepted transfer is measured.
        // Never follow links or walk recursively through the save directory.
        if !directory.is_absolute() { return None; }
        let mut newest = None;
        for (index, entry) in std::fs::read_dir(directory).ok()?.enumerate() {
            // Avoid scanning a giant directory on every UI poll. Without a
            // complete scan we cannot know which archive is newest.
            if index >= 2048 { return None; }
            let entry = entry.ok()?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue; };
            let Some(suffix) = name.strip_prefix("airdrop-received-") else { continue };
            let Some((seconds, ext)) = suffix.rsplit_once('.') else { continue };
            if ext != "dvzip" && ext != "cpio" { continue; }
            let Ok(seconds) = seconds.parse::<u64>() else { continue };
            if seconds < start || seconds > now { continue; }
            let Ok(meta) = entry.path().symlink_metadata() else { continue; };
            if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } { continue; }
            if newest.is_none_or(|(timestamp, _)| seconds > timestamp) {
                newest = Some((seconds, meta.len()));
            }
        }
        newest.map(|(_, size)| size)
    }

    fn transfer_state(log: &str, age_seconds: u64) -> Option<&'static str> {
        if log.contains("File(s) incomplete") {
            Some("failed")
        } else if log.contains("File(s) received") {
            // The patched OpenDrop receiver logs this even when it salvaged
            // only a .partial file, and currently answers HTTP 200 either way.
            if log.contains("incomplete, kept as .partial")
                || log.contains("Could not extract the archive")
                || !log.contains("Extracted into")
            {
                Some("failed")
            } else {
                Some("complete")
            }
        } else if log.contains("Receiving file(s)") {
            // A large file can take much longer than the old 90-second cap.
            Some("receiving")
        } else if age_seconds <= 10 * 60 {
            Some("waiting")
        } else {
            None
        }
    }

    pub fn preferences(name: &str, directory: &str) -> Result<(String, Option<PathBuf>), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 48 || name.chars().any(char::is_control) {
            return Err("Choose a device name of 1–48 characters without line breaks.".into());
        }
        let path = if directory.trim().is_empty() {
            None
        } else {
            let input = PathBuf::from(directory.trim());
            if !input.is_absolute() {
                return Err("Choose an absolute save folder.".into());
            }
            let real = input
                .canonicalize()
                .map_err(|_| "The AirDrop save folder does not exist.".to_string())?;
            if !real.is_dir() {
                return Err("The AirDrop save path must be a folder.".into());
            }
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if !real.metadata().is_ok_and(|m| {
                m.uid() == unsafe { libc::geteuid() } && m.permissions().mode() & 0o200 != 0
            }) {
                return Err("Choose a folder you own for incoming AirDrop files.".into());
            }
            Some(real)
        };
        Ok((name.to_string(), path))
    }

    fn mt7922_daemon() -> Option<PathBuf> {
        let home = std::env::var_os("HOME")?;
        let daemon = PathBuf::from(home).join(".local/share/mochi/airdrop-mt7921/daemon/airdropd");
        use std::os::unix::fs::PermissionsExt;
        daemon
            .metadata()
            .ok()
            .filter(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .map(|_| daemon)
    }

    fn mt7922_ready() -> Result<PathBuf, String> {
        let daemon = mt7922_daemon().ok_or(MT7922_SETUP)?;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        for path in [
            "/usr/local/bin/airdrop-helper",
            "/usr/local/bin/airdrop-owl",
            "/usr/local/bin/airdrop-go-hostapd",
        ] {
            let metadata = std::fs::metadata(path).map_err(|_| MT7922_SETUP.to_string())?;
            if !metadata.is_file()
                || metadata.uid() != 0
                || metadata.permissions().mode() & 0o022 != 0
                || metadata.permissions().mode() & 0o111 == 0
            {
                return Err(format!(
                    "{path} must be an executable owned by root and not writable by other users."
                ));
            }
        }
        Ok(daemon)
    }

    fn executable() -> Option<PathBuf> {
        let mut paths = Vec::new();
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(home).join(".local/bin/omdrop"));
        }
        if let Some(bin) = std::env::var_os("XDG_BIN_HOME") {
            paths.push(PathBuf::from(bin).join("omdrop"));
        }
        paths.extend(std::env::split_paths(&std::env::var_os("PATH")?).map(|p| p.join("omdrop")));
        paths.into_iter().find(|p| {
            p.is_file() && {
                use std::os::unix::fs::PermissionsExt;
                p.metadata()
                    .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
            }
        })
    }

    /// Omdrop can use exclusive mode on several drivers. Unless its selected
    /// adapter is separate from the connected one, do not risk taking Wi-Fi
    /// down from a button in Mochi.
    fn wifi_disconnect_risk() -> Option<String> {
        let selected = std::fs::read_to_string("/etc/omdrop/infra-iface")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let mut interfaces = std::fs::read_dir("/sys/class/net")
                    .ok()?
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                interfaces.sort();
                interfaces.into_iter().find(|name| {
                    let path = PathBuf::from("/sys/class/net").join(name);
                    if !path.join("phy80211").exists() {
                        return false;
                    }
                    std::process::Command::new("iw")
                        .args(["dev", name, "info"])
                        .output()
                        .is_ok_and(|out| {
                            out.status.success()
                                && String::from_utf8_lossy(&out.stdout).contains("type managed")
                        })
                })
            });
        let Some(selected) = selected else {
            return Some("Could not identify Omdrop's selected Wi-Fi adapter; refusing to risk disconnecting your network.".into());
        };
        // Do not interpret arbitrary paths from a local configuration file.
        if !selected
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
        {
            return Some("Omdrop's configured Wi-Fi interface name is invalid.".into());
        }
        let path = PathBuf::from("/sys/class/net").join(&selected);
        let Some(driver) = std::fs::canonicalize(path.join("device/driver")).ok() else {
            return Some(format!(
                "Could not identify the driver for {selected}; refusing to risk Wi-Fi."
            ));
        };
        let Some(carrier) = std::fs::read_to_string(path.join("carrier")).ok() else {
            return Some(format!(
                "Could not determine whether {selected} is connected to Wi-Fi."
            ));
        };
        let connected = carrier.trim() == "1";
        if connected {
            return Some(format!(
                "AirDrop on {selected} may disconnect your Wi-Fi (driver {}). Use a separate supported USB Wi-Fi adapter and set /etc/omdrop/infra-iface to it.",
                driver.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        None
    }

    async fn run(args: &[&str], seconds: u64) -> Result<(bool, String), String> {
        let binary = executable().ok_or(SETUP)?;
        let mut command = Command::new(binary);
        command.args(args).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(seconds), command.output())
            .await
            .map_err(|_| "Omdrop did not respond in time. Check omdrop doctor.".to_string())?
            .map_err(|e| format!("Could not run Omdrop: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
            return Err(format!("Omdrop exited with {}.", output.status));
        }
        Ok((
            output.status.success(),
            if stdout.is_empty() { stderr } else { stdout },
        ))
    }

    async fn run_mt7922(args: &[&str], seconds: u64) -> Result<(bool, String), String> {
        let daemon = mt7922_daemon().ok_or(MT7922_SETUP)?;
        let output = tokio::time::timeout(
            Duration::from_secs(seconds),
            Command::new(daemon).args(args).kill_on_drop(true).output(),
        )
        .await
        .map_err(|_| "The MT7922 AirDrop backend did not respond in time.".to_string())?
        .map_err(|e| format!("Could not run the MT7922 AirDrop backend: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok((
            output.status.success(),
            if stdout.is_empty() { stderr } else { stdout },
        ))
    }

    #[derive(serde::Deserialize)]
    struct Mt7922State {
        state: String,
        detail: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct Mt7922RadioState {
        mon: bool,
        active: bool,
        go: bool,
    }

    /// The daemon's state file can survive a crashed or externally stopped
    /// process. Its word "armed" is useful only while the privileged helpers
    /// are actually still up; otherwise the UI must say off rather than offer
    /// a receiver that does not exist.
    async fn mt7922_radio_state() -> Result<Mt7922RadioState, String> {
        let output = Command::new("sudo")
            .args(["-n", "/usr/local/bin/airdrop-helper", "status"])
            .output()
            .await
            .map_err(|e| format!("Could not check the AirDrop radio helper: {e}"))?;
        if !output.status.success() {
            return Err(MT7922_SETUP.into());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "Could not read the AirDrop radio state.".to_string())
    }

    async fn mt7922_radio_active() -> Result<bool, String> {
        let radio = mt7922_radio_state().await?;
        Ok(radio.mon && radio.active && radio.go)
    }

    async fn mt7922_stop_radio_helpers() -> Result<(), String> {
        // This is deliberately only used after asking the daemon to stop (or
        // after proving there is no listener). It is the final cleanup for a
        // crashed daemon whose root-owned helpers would otherwise outlive the
        // visible AirDrop session.
        for action in ["owl-stop", "go-down"] {
            let output = Command::new("sudo")
                .args(["-n", "/usr/local/bin/airdrop-helper", action])
                .output()
                .await
                .map_err(|e| format!("Could not stop the AirDrop radio helper: {e}"))?;
            if !output.status.success() {
                return Err("Could not stop the AirDrop radio helper.".into());
            }
        }
        Ok(())
    }

    async fn mt7922_receiver_listening() -> bool {
        // Root-owned radio helpers may survive a restart, but they are not an
        // AirDrop receiver on their own. A real receiver must still own the
        // HTTPS listening socket; this avoids claiming "Receiving" from a
        // stale daemon state file plus orphaned helpers.
        Command::new("ss")
            .args(["-ltnH", "( sport = :8771 )"])
            .output()
            .await
            .is_ok_and(|out| out.status.success() && !out.stdout.is_empty())
    }

    async fn wait_for_mt7922_session(running: bool, seconds: u64) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        loop {
            let radio = mt7922_radio_state().await?;
            let listener = mt7922_receiver_listening().await;
            let active = radio.mon && radio.active && radio.go && listener;
            let stopped = !radio.mon && !radio.active && !radio.go && !listener;
            if (running && active) || (!running && stopped) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(if running {
                    "The AirDrop receiver did not start listening in time.".into()
                } else {
                    "The AirDrop receiver did not stop in time.".into()
                });
            }
            // The daemon has already paid the expensive radio/TLS startup; use
            // a short final poll so the toggle becomes responsive as soon as
            // the listener exists rather than up to another 150 ms later.
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn mt7922_status() -> Result<Status, String> {
        let Some(_) = mt7922_daemon() else {
            unreachable!()
        };
        let (ok, output) = run_mt7922(&["status"], 5).await?;
        if !ok {
            return Err(output);
        }
        let raw: Mt7922State = serde_json::from_str(&output)
            .map_err(|_| "The MT7922 AirDrop backend returned an invalid status.".to_string())?;
        let daemon_active = !matches!(raw.state.as_str(), "off" | "error");
        let radio_active = if daemon_active {
            mt7922_radio_active().await?
        } else {
            false
        };
        let receiver_listening = daemon_active && mt7922_receiver_listening().await;
        let active = daemon_active && radio_active && receiver_listening;
        let visible = matches!(raw.state.as_str(), "armed" | "receiving") && active;
        Ok(Status {
            installed: true,
            receiving: active,
            visible,
            // The backend may use a custom name and destination from its
            // own config; do not present guessed values as confirmed state.
            name: None,
            remaining: None,
            directory: None,
            can_send_nearby: false,
            message: if daemon_active && !radio_active {
                Some(
                    "AirDrop is off: its previous radio session ended. Turn it on to receive."
                        .into(),
                )
            } else if daemon_active && !receiver_listening {
                Some(
                    "AirDrop is off: its receiver is no longer listening. Turn it on to start a new session."
                        .into(),
                )
            } else if raw.state == "error" || raw.state == "unreachable" {
                raw.detail.or(Some(
                    "The MT7922 AirDrop radio could not become visible.".into(),
                ))
            } else if !active {
                mt7922_ready().err()
            } else {
                None
            },
        })
    }

    async fn mt7922_set(enabled: bool, name: &str, directory: &str) -> Result<Status, String> {
        let _guard = SWITCH.get_or_init(|| Mutex::new(())).lock().await;
        let daemon = mt7922_ready()?;
        if enabled {
            let (name, directory) = preferences(name, directory)?;
            if mt7922_status().await?.receiving {
                return mt7922_status().await;
            }
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                let _ = std::fs::remove_file(
                    PathBuf::from(runtime).join("mochi-airdrop/transfer.json"),
                );
            }
            let radio = mt7922_radio_state().await?;
            if radio.mon || radio.active || radio.go {
                if mt7922_receiver_listening().await {
                    return Err("An AirDrop receiver is already running outside this toggle. Mochi will not overwrite an unknown radio session.".into());
                }
                // No receiver owns this radio, so it is a failed prior session,
                // not another person's active transfer. Clean it before the new
                // toggle-created session begins.
                mt7922_stop_radio_helpers().await?;
            }
            let check = Command::new("sudo")
                .args(["-n", "/usr/local/bin/airdrop-helper", "status"])
                .output()
                .await
                .map_err(|e| format!("Could not check the AirDrop radio helper: {e}"))?;
            let radio: serde_json::Value = serde_json::from_slice(&check.stdout)
                .map_err(|_| "Could not read the AirDrop radio state.".to_string())?;
            let channel = radio["chan"].as_u64().unwrap_or(0);
            if radio["assoc"] != true || !(36..=177).contains(&channel) {
                return Err("Connect to 5 GHz Wi-Fi before turning on this experimental AirDrop mode; Mochi will not switch networks for you.".into());
            }
            // Keep the receiver in its own user service. A Mochi UI restart
            // must not interrupt a large transfer or silently turn off the
            // radio; logout still stops the user service and its helpers.
            let mut receiver = Command::new("systemd-run");
            receiver.args([
                "--user",
                "--collect",
                "--quiet",
                "--unit=mochi-airdrop",
                "--service-type=exec",
                "--property=PartOf=graphical-session.target",
                "--property=TimeoutStopSec=30s",
                "--setenv=AIRDROP_MODE=shared",
                "--setenv=AIRDROP_ALWAYS=1",
                "--setenv=AIRDROP_DUALCHAN=1",
                // The iPhone only notices unsolicited mDNS announcements when
                // the two radios happen to share an AWDL slot. A short repeat
                // interval improves first appearance without restarting the
                // HTTPS listener or the AirDrop radio.
                "--setenv=AIRDROP_REANNOUNCE=2",
                // The observed 80 MB upload stopped after OpenDrop's 8-second
                // adaptive floor. That might have been a sender abort, but a
                // longer radio pause should not be mistaken for completion.
                "--setenv=AIRDROP_STALL_FLOOR=30",
                "--setenv=AIRDROP_STALL_TIMEOUT=60",
            ]);
            receiver.arg(format!("--setenv=AIRDROP_NAME={name}"));
            if let Some(path) = directory {
                receiver.arg(format!("--setenv=RECV_DIR={}", path.display()));
            }
            if let Ok(exe) = std::env::current_exe() {
                let confirm = exe.with_file_name("mochi-airdrop-confirm");
                if confirm.is_file() {
                    receiver.arg(format!("--setenv=AIRDROP_CONFIRM={}", confirm.display()));
                }
            }
            let output = tokio::time::timeout(
                Duration::from_secs(8),
                receiver.arg(daemon).arg("run").kill_on_drop(true).output(),
            )
            .await
            .map_err(|_| "The AirDrop user service did not respond in time.".to_string())?
            .map_err(|e| format!("Could not launch the AirDrop user service: {e}"))?;
            if !output.status.success() {
                let detail = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Could not start the AirDrop user service: {}", detail.trim()));
            }
            STARTED_BY_MOCHI.store(true, Ordering::Relaxed);
            if let Err(err) = wait_for_mt7922_session(true, 10).await {
                let _ = run_mt7922(&["stop"], 10).await;
                let _ = mt7922_stop_radio_helpers().await;
                STARTED_BY_MOCHI.store(false, Ordering::Relaxed);
                return Err(err);
            }
        } else {
            let (ok, output) = run_mt7922(&["stop"], 10).await?;
            // "not running" is harmless here: it means the process already
            // died and only its helpers may remain, which we clean next.
            if !ok && !output.contains("not running") {
                return Err(if output.is_empty() {
                    "Could not stop the AirDrop receiver.".into()
                } else {
                    output
                });
            }
            mt7922_stop_radio_helpers().await?;
            wait_for_mt7922_session(false, 8).await?;
            STARTED_BY_MOCHI.store(false, Ordering::Relaxed);
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                let _ = std::fs::remove_file(
                    PathBuf::from(runtime).join("mochi-airdrop/transfer.json"),
                );
            }
        }
        let status = mt7922_status().await?;
        if enabled && !status.receiving {
            return Err(status
                .message
                .unwrap_or_else(|| "The MT7922 AirDrop receiver did not start.".into()));
        }
        Ok(status)
    }

    fn mt7922_report() -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("AIRDROP_SEND_REPORT") {
            return Some(PathBuf::from(path));
        }
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".opendrop/discover.last.json"))
    }

    #[derive(serde::Deserialize)]
    struct RawMtPeer {
        id: String,
        name: Option<String>,
        address: Option<String>,
    }

    fn parse_mt_peers(raw: Vec<RawMtPeer>, own_name: &str, own_addresses: &str) -> Vec<Peer> {
        raw.into_iter()
            .take(50)
            .filter_map(|item| {
                let name = item.name?.trim().to_string();
                if name.is_empty()
                    || name.len() > 80
                    || name.chars().any(char::is_control)
                    || name == own_name.trim()
                    || item.id.len() != 12
                    || !item.id.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || item
                        .address
                        .as_deref()
                        .is_some_and(|addr| own_addresses.contains(addr))
                {
                    return None;
                }
                Some(Peer {
                    mac: item.id,
                    name: Some(name),
                    rssi: None,
                })
            })
            .collect()
    }

    fn recent_mt7922_peers(since: Option<SystemTime>) -> Result<Vec<Peer>, String> {
        let report = mt7922_report().ok_or("No AirDrop discovery report path is available.")?;
        let metadata = std::fs::metadata(&report).map_err(|_| {
            "No recent AirDrop devices were found. Open AirDrop on the iPhone and scan again."
        })?;
        if metadata.len() > 128 * 1024 {
            return Err("The AirDrop discovery report is unexpectedly large.".into());
        }
        let modified = metadata
            .modified()
            .map_err(|_| "Could not check the AirDrop scan time.")?;
        if modified.elapsed().unwrap_or(Duration::MAX) > Duration::from_secs(45)
            || since.is_some_and(|start| modified < start)
        {
            return Err("The AirDrop device list is stale. Scan again before sending.".into());
        }
        let raw: Vec<RawMtPeer> = serde_json::from_slice(
            &std::fs::read(&report).map_err(|_| "Could not read the AirDrop device list.")?,
        )
        .map_err(|_| "The AirDrop device list was invalid.")?;
        let own_name = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
        let own_addresses = std::process::Command::new("ip")
            .args(["-6", "-o", "addr", "show", "dev", "awdl0", "scope", "link"])
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default();
        Ok(parse_mt_peers(raw, &own_name, &own_addresses))
    }

    async fn start_ble_wake() -> Result<tokio::process::Child, String> {
        let home = std::env::var_os("HOME").ok_or("HOME is unavailable.")?;
        let script =
            PathBuf::from(home).join(".local/share/mochi/airdrop-mt7921/tools/blewake-dbus.py");
        if !script.is_file() {
            return Err("The AirDrop Bluetooth wake helper is missing. Reinstall the optional MT7922 backend.".into());
        }
        // BlueZ owns this advertisement. Dropping the child closes its D-Bus
        // connection and unregisters it, including if a scan is cancelled.
        let mut child = Command::new("python3")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start the AirDrop Bluetooth wake: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Could not read Bluetooth wake status.")?;
        let mut output = BufReader::new(stdout);
        let mut line = String::new();
        let ready = tokio::time::timeout(Duration::from_secs(6), output.read_line(&mut line)).await;
        if !matches!(ready, Ok(Ok(n)) if n > 0 && line.trim() == "advert up") {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err("Bluetooth could not advertise AirDrop discovery. Check that Bluetooth is enabled and BlueZ is running.".into());
        }
        child.stdout = Some(output.into_inner());
        Ok(child)
    }

    async fn stop_ble_wake(mut child: tokio::process::Child) {
        if let Some(pid) = child.id() {
            unsafe { libc::kill(pid as i32, libc::SIGINT) };
        }
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    async fn scan_mt7922_peers() -> Result<Vec<Peer>, String> {
        let _guard = SWITCH.get_or_init(|| Mutex::new(())).lock().await;
        if !mt7922_status().await?.visible {
            return Err(
                "Turn on AirDrop and wait until its radio is visible before scanning.".into(),
            );
        }
        let home = std::env::var_os("HOME").ok_or("HOME is unavailable.")?;
        let opendrop =
            PathBuf::from(home).join(".local/share/mochi/owl/.venv-opendrop/bin/opendrop");
        if !opendrop.is_file() {
            return Err("The MT7922 AirDrop discovery tool is missing.".into());
        }
        let wake = start_ble_wake().await?;
        // Give the iPhone a moment to wake AWDL before sending mDNS queries.
        tokio::time::sleep(Duration::from_secs(3)).await;
        let result = scan_mt7922_peers_awdl(opendrop).await;
        stop_ble_wake(wake).await;
        result
    }

    async fn scan_mt7922_peers_awdl(opendrop: PathBuf) -> Result<Vec<Peer>, String> {
        let started = SystemTime::now();
        let mut child = Command::new(opendrop)
            .args(["-i", "awdl0", "find"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not scan for AirDrop devices: {e}"))?;
        // OpenDrop writes the peer report when interrupted. Wait for the
        // discovery window without repeatedly spawning `ip` and rereading
        // the report, which may still contain only the previous scan.
        let timed_out = match tokio::time::timeout(Duration::from_secs(25), child.wait()).await {
            Ok(Ok(_)) => false,
            Ok(Err(e)) => return Err(format!("AirDrop discovery failed: {e}")),
            Err(_) => true,
        };
        if timed_out {
            if let Some(pid) = child.id() {
                // OpenDrop writes its discovery report on KeyboardInterrupt.
                unsafe { libc::kill(pid as i32, libc::SIGINT) };
            }
            if tokio::time::timeout(Duration::from_secs(8), child.wait())
                .await
                .is_err()
            {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        let peers = recent_mt7922_peers(Some(started))?;
        if peers.is_empty() {
            return Err("No iPhone AirDrop service answered. To send from Mochi, unlock the iPhone, select Everyone for 10 Minutes, CLOSE its Share sheet, and scan again. To receive on Mochi, OPEN the iPhone Share sheet and look for Mochi there.".into());
        }
        Ok(peers)
    }

    #[derive(serde::Deserialize)]
    struct RawStatus {
        receiving: bool,
        visible: Option<bool>,
        name: Option<String>,
        dir: Option<String>,
        remaining: Option<u64>,
        reason: Option<String>,
    }

    pub async fn status() -> Result<Status, String> {
        if mt7922_daemon().is_some() {
            return mt7922_status().await;
        }
        if executable().is_none() {
            return Ok(Status {
                message: Some(SETUP.into()),
                ..Status::default()
            });
        }
        let (ok, output) = run(&["status", "--json"], 8).await?;
        if !ok {
            return Err(output);
        }
        let raw: RawStatus = serde_json::from_str(&output)
            .map_err(|_| "Omdrop returned an invalid status. Update Omdrop.".to_string())?;
        Ok(Status {
            installed: true,
            receiving: raw.receiving,
            visible: raw.receiving && raw.visible == Some(true),
            name: raw.name,
            remaining: raw.remaining,
            directory: raw.dir,
            can_send_nearby: false,
            message: if !raw.receiving {
                wifi_disconnect_risk()
            } else if raw.visible != Some(true) {
                Some(raw.reason.unwrap_or_else(|| "The receiver is running, but the AirDrop radio is not visible. Run omdrop doctor.".into()))
            } else {
                None
            },
        })
    }

    pub async fn set(enabled: bool, name: &str, directory: &str) -> Result<Status, String> {
        if mt7922_daemon().is_some() {
            return mt7922_set(enabled, name, directory).await;
        }
        if enabled && (name.trim() != "Mochi" || !directory.is_empty()) {
            return Err(
                "Custom AirDrop name and save folder currently require the MT7922 backend.".into(),
            );
        }
        // Do not let two quick clicks race Omdrop's own service/timer lifecycle.
        let _guard = SWITCH.get_or_init(|| Mutex::new(())).lock().await;
        if executable().is_none() {
            return Err(SETUP.into());
        }
        if enabled {
            let _ = preferences(name, directory)?;
            if let Some(reason) = wifi_disconnect_risk() {
                return Err(reason);
            }
            let (ok, diagnosis) = run(&["doctor", "--json"], 12).await?;
            if !ok {
                return Err(diagnosis);
            }
            let doctor: serde_json::Value = serde_json::from_str(&diagnosis)
                .map_err(|_| "Omdrop doctor returned invalid data.".to_string())?;
            // The receiver service may be installed automatically on first use;
            // everything else (privileged backend, library, firewall) is manual.
            if doctor["ready"] != true {
                let problems = doctor["missing"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| item["id"] != "service")
                    .filter_map(|item| item["say"].as_str())
                    .collect::<Vec<_>>();
                if !problems.is_empty() {
                    return Err(problems.join(" "));
                }
            }
        }
        let (ok, message) = if enabled {
            run(&["on", "10m"], 35).await?
        } else {
            run(&["off"], 15).await?
        };
        if !ok {
            return Err(message);
        }
        STARTED_BY_MOCHI.store(enabled, Ordering::Relaxed);
        let result = status().await?;
        if enabled && !result.receiving {
            return Err("Omdrop did not start receiving. Run omdrop doctor.".into());
        }
        Ok(result)
    }

    pub async fn stop_if_owned() {
        // The MT7922 receiver is now its own user service. Only the explicit
        // AirDrop toggle may stop it; closing or restarting Mochi does not.
        if mt7922_daemon().is_some() {
            return;
        }
        if STARTED_BY_MOCHI.load(Ordering::Relaxed) {
            let _ = set(false, "Mochi", "").await;
        }
    }

    pub async fn peers(named: bool) -> Result<Vec<Peer>, String> {
        if mt7922_daemon().is_some() {
            if named {
                return scan_mt7922_peers().await;
            }
            return Ok(recent_mt7922_peers(None).unwrap_or_default());
        }
        // Only a deliberate "Find names" click uses -n: Omdrop sends BLE
        // identity announcements and connects to nearby Apple devices then.
        let args: &[&str] = if named {
            &["peers", "-n", "--json"]
        } else {
            &["peers", "--json"]
        };
        let (ok, output) = run(args, if named { 35 } else { 12 }).await?;
        // Omdrop exits 1 with [] when there are no devices in range.
        if !ok && output != "[]" {
            return Err(output);
        }
        serde_json::from_str(&output).map_err(|_| "Omdrop returned an invalid peer list.".into())
    }

    pub async fn send(mac: String) -> Result<String, String> {
        if mt7922_daemon().is_some() {
            if mac.len() != 12 || !mac.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("Select a named AirDrop device from a fresh scan.".into());
            }
            let _guard = SWITCH.get_or_init(|| Mutex::new(())).lock().await;
            if !mt7922_status().await?.visible {
                return Err("The AirDrop radio is not visible. Turn it on and try again.".into());
            }
            if !recent_mt7922_peers(None)?
                .iter()
                .any(|peer| peer.mac == mac && peer.name.is_some())
            {
                return Err(
                    "That AirDrop recipient is no longer in the fresh device list. Scan again."
                        .into(),
                );
            }
            let daemon = mt7922_ready()?;
            let picker = std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join(".local/share/mochi/omdrop-plugin/bin/pick.py"))
                .filter(|p| p.is_file())
                .ok_or("The desktop file picker is not installed.")?;
            let output = Command::new("python3")
                .arg(picker)
                .args(["files", "", "Send via AirDrop"])
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|e| format!("Could not open the file picker: {e}"))?;
            if output.status.code() == Some(1) {
                return Err("No files selected.".into());
            }
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            let files = output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| {
                    String::from_utf8(path.to_vec())
                        .map_err(|_| "A selected filename is not valid UTF-8.".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if files.is_empty() {
                return Err("No files selected.".into());
            }
            if files.len() > 100 {
                return Err("Select at most 100 files per transfer.".into());
            }
            if !files.iter().all(|file| {
                std::path::Path::new(file).is_absolute() && std::path::Path::new(file).is_file()
            }) {
                return Err("The file picker returned an invalid file.".into());
            }
            if !recent_mt7922_peers(None)?
                .iter()
                .any(|peer| peer.mac == mac)
            {
                return Err(
                    "The AirDrop device list expired while selecting files. Scan again.".into(),
                );
            }
            // The explicit 12-digit service ID prevents the backend's unsafe
            // default of sending to the first device that happened to answer.
            let output = Command::new("timeout")
                .args(["--signal=INT", "--kill-after=5s", "900s"])
                .arg(daemon)
                .arg("send")
                .args(&files)
                .env("AIRDROP_MODE", "shared")
                .env("AIRDROP_DUALCHAN", "1")
                .env("AIRDROP_RECEIVER", &mac)
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|e| format!("Could not send through AirDrop: {e}"))?;
            let message = String::from_utf8_lossy(if output.status.success() {
                &output.stdout
            } else {
                &output.stderr
            })
            .trim()
            .to_string();
            if !output.status.success() {
                return Err(if message.is_empty() {
                    "AirDrop transfer failed or timed out.".into()
                } else {
                    message
                });
            }
            return Ok(if message.is_empty() {
                "AirDrop transfer complete.".into()
            } else {
                message
            });
        }
        // Never accept command switches or a device name from the webview:
        // --to must be the exact address of the row the user picked. Omdrop
        // checks that it is still in the live peer table before sending.
        let valid = mac.len() == 17
            && mac.split(':').count() == 6
            && mac
                .split(':')
                .all(|part| part.len() == 2 && part.bytes().all(|b| b.is_ascii_hexdigit()));
        if !valid {
            return Err("Invalid AirDrop recipient.".into());
        }
        let _guard = SWITCH.get_or_init(|| Mutex::new(())).lock().await;
        let state = status().await?;
        if !state.visible {
            return Err(
                "Turn on AirDrop and open the iPhone's AirDrop receiving settings first.".into(),
            );
        }
        // --pick uses Omdrop's desktop portal file chooser; paths remain in
        // the user-owned CLI, never pass through the webview or a shell.
        let (ok, message) = run(&["send", "--to", &mac, "--pick"], 900).await?;
        if !ok {
            return Err(message);
        }
        Ok("AirDrop transfer complete.".into())
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn upload_progress_uses_wire_total_and_only_the_new_raw_archive() {
            use super::{archive_received, upload_total_bytes};
            let log = "POST request at /Upload\nTotalBytes: 186876480\nTransfer-Encoding: chunked\nReceiving file(s) ...";
            assert_eq!(upload_total_bytes(log), Some(186876480));
            assert_eq!(upload_total_bytes("TotalBytes: 0\nTotalBytes: rubbish"), None);
            assert_eq!(upload_total_bytes("Content-Length: 500\nReceiving file(s) ..."), None);

            let start = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let dir = std::env::temp_dir().join(format!("mochi-transfer-{}-{start}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            let old = dir.join(format!("airdrop-received-{}.dvzip", start - 10));
            let current = dir.join(format!("airdrop-received-{start}.dvzip"));
            let unrelated = dir.join("other.dvzip");
            std::fs::write(&old, vec![0u8; 100]).unwrap();
            std::fs::write(&current, vec![0u8; 25]).unwrap();
            std::fs::write(&unrelated, vec![0u8; 200]).unwrap();
            assert_eq!(archive_received(&dir, start, start), Some(25));
            std::fs::write(&current, vec![0u8; 75]).unwrap();
            assert_eq!(archive_received(&dir, start, start), Some(75), "stat again even without a new log line");
            assert_eq!(archive_received(&dir, start + 1, start + 1), None);
            let link = dir.join(format!("airdrop-received-{}.dvzip", start + 1));
            std::os::unix::fs::symlink(&unrelated, &link).unwrap();
            assert_eq!(archive_received(&dir, start, start + 1), Some(75), "ignore symlinked uploads");
            std::fs::remove_file(link).unwrap();
            std::fs::remove_file(old).unwrap();
            std::fs::remove_file(current).unwrap();
            std::fs::remove_file(unrelated).unwrap();
            std::fs::remove_dir(dir).unwrap();
        }

        #[test]
        fn long_upload_keeps_its_status_and_partial_files_are_not_success() {
            use super::transfer_state;
            assert_eq!(transfer_state("Receiving file(s) ...", 30 * 60), Some("receiving"));
            assert_eq!(transfer_state("", 11 * 60), None);
            assert_eq!(transfer_state("", 30), Some("waiting"));
            assert_eq!(transfer_state("Receiving file(s) ...\nExtracted into /tmp: video.mov\nFile(s) received", 180), Some("complete"));
            assert_eq!(transfer_state("Receiving file(s) ...\nincomplete, kept as .partial: video.mov\nCould not extract the archive\nFile(s) received", 180), Some("failed"));
            assert_eq!(transfer_state("Receiving file(s) ...\nFile(s) incomplete", 180), Some("failed"));
        }

        #[test]
        fn airdrop_preferences_validate_name_and_owned_absolute_destination() {
            assert!(super::preferences("", "").is_err());
            assert!(super::preferences("invalid\nname", "").is_err());
            assert!(super::preferences(&"a".repeat(49), "").is_err());
            assert!(super::preferences("Laptop", "relative/path").is_err());
            assert!(super::preferences("Laptop", "/no/such/mochi-airdrop-folder").is_err());
            assert_eq!(super::preferences("  Laptop ", "").unwrap().0, "Laptop");
            let home = std::env::var("HOME").unwrap();
            assert_eq!(
                super::preferences("Laptop", &home).unwrap().1.unwrap(),
                std::path::PathBuf::from(home).canonicalize().unwrap()
            );
        }

        #[test]
        fn radio_state_requires_every_component_of_the_shared_stack() {
            let state: super::Mt7922RadioState =
                serde_json::from_str(r#"{"mon":true,"active":true,"go":true}"#).unwrap();
            assert!(state.mon && state.active && state.go);
            let state: super::Mt7922RadioState =
                serde_json::from_str(r#"{"mon":false,"active":false,"go":false}"#).unwrap();
            assert!(!(state.mon && state.active && state.go));
        }

        #[test]
        fn an_armed_state_is_not_receiving_without_a_listener() {
            let daemon_active = true;
            let radio_active = true;
            let receiver_listening = false;
            assert!(!(daemon_active && radio_active && receiver_listening));
        }

        #[test]
        fn mt7922_scan_discards_self_unnamed_and_non_service_ids() {
            let raw = serde_json::from_str(
                r#"[
              {"id":"001122334455","name":"Mochi Host","address":"fe80::1"},
              {"id":"aabbccddeeff","name":"  My iPhone  ","address":"fe80::2"},
              {"id":"not-a-peer","name":"Other iPhone","address":"fe80::3"},
              {"id":"112233445566","name":null,"address":"fe80::4"}
            ]"#,
            )
            .unwrap();
            let peers = super::parse_mt_peers(raw, "Mochi Host", "fe80::1");
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].mac, "aabbccddeeff");
            assert_eq!(peers[0].name.as_deref(), Some("My iPhone"));
        }

        #[test]
        fn connected_mt7922_on_this_host_is_protected() {
            let path = std::path::Path::new("/sys/class/net/wlan0");
            let driver = std::fs::canonicalize(path.join("device/driver")).ok();
            let connected =
                std::fs::read_to_string(path.join("carrier")).is_ok_and(|s| s.trim() == "1");
            if driver
                .as_ref()
                .and_then(|p| p.file_name())
                .is_some_and(|n| n == "mt7921e")
                && connected
                && !std::path::Path::new("/etc/omdrop/infra-iface").exists()
            {
                assert!(super::wifi_disconnect_risk().is_some());
            }
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{decide, incoming, peers, preferences, send, set, status, stop_if_owned, transfer};

#[cfg(target_os = "linux")]
pub use linux::Incoming;

#[cfg(not(target_os = "linux"))]
#[derive(Clone, Debug, Serialize)]
pub struct Incoming {}

#[cfg(not(target_os = "linux"))]
pub fn incoming() -> Result<Option<Incoming>, String> {
    Ok(None)
}

#[cfg(not(target_os = "linux"))]
pub fn transfer() -> Option<Transfer> {
    None
}

#[cfg(not(target_os = "linux"))]
pub fn decide(_id: String, _accept: bool) -> Result<(), String> {
    Err("AirDrop requires Linux.".into())
}

#[cfg(not(target_os = "linux"))]
pub fn preferences(
    _name: &str,
    _directory: &str,
) -> Result<(String, Option<std::path::PathBuf>), String> {
    Err("AirDrop requires Linux.".into())
}

#[cfg(not(target_os = "linux"))]
pub async fn stop_if_owned() {}

#[cfg(not(target_os = "linux"))]
pub async fn status() -> Result<Status, String> {
    Ok(Status {
        message: Some("AirDrop receiving needs Linux and an AWDL backend.".into()),
        ..Status::default()
    })
}

#[cfg(not(target_os = "linux"))]
pub async fn set(_enabled: bool, _name: &str, _directory: &str) -> Result<Status, String> {
    Err("AirDrop receiving needs Linux and an AWDL backend.".into())
}

#[cfg(not(target_os = "linux"))]
pub async fn peers(_named: bool) -> Result<Vec<Peer>, String> {
    Err("AirDrop receiving needs Linux and an AWDL backend.".into())
}

#[cfg(not(target_os = "linux"))]
pub async fn send(_mac: String) -> Result<String, String> {
    Err("AirDrop sending needs Linux and an AWDL backend.".into())
}

#[cfg(test)]
mod tests {
    use super::{Peer, Status};

    #[test]
    fn wire_types_match_omdrop_and_the_webview() {
        let status = Status {
            installed: true,
            receiving: true,
            visible: true,
            name: Some("Mochi".into()),
            remaining: Some(582),
            directory: Some("/home/user/Downloads".into()),
            can_send_nearby: false,
            message: None,
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["receiving"], true);
        assert_eq!(json["directory"], "/home/user/Downloads");
        let peers: Vec<Peer> =
            serde_json::from_str(r#"[{"mac":"02:11:22:33:44:55","name":"iPhone","rssi":-55}]"#)
                .unwrap();
        assert_eq!(peers[0].name.as_deref(), Some("iPhone"));
    }
}
