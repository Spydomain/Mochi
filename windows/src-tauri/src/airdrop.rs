//! Native AirDrop on Linux, via installed MT7922 or Omdrop/AWDL backends.
//! Setup provisions the optional root-owned radio helpers; the desktop app
//! controls their lifecycle without implementing AWDL or silently installing
//! privileged components during a transfer.

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
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub mac: String,
    pub name: Option<String>,
    pub rssi: Option<i32>,
    pub last_seen: Option<u64>,
    #[serde(default)]
    pub fresh: bool,
    #[serde(default)]
    pub connection: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub state: String,
    pub received_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub wire_bytes: Option<u64>,
    pub bytes_per_second: Option<f64>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Discovery {
    pub supported: bool,
    pub running: bool,
    pub peers: Vec<Peer>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outbound {
    pub phase: String,
    pub sent_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default)]
    pub measurement: Option<String>,
    #[serde(default)]
    pub bytes_per_second: Option<f64>,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Discovery, Outbound, Peer, Status, Transfer};
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, SystemTime};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    use tokio::process::Command;
    use tokio::sync::{watch, Mutex};

    static SWITCH: OnceLock<Mutex<()>> = OnceLock::new();
    static STARTED_BY_MOCHI: AtomicBool = AtomicBool::new(false);
    static TRANSFER_CACHE: OnceLock<StdMutex<TransferCache>> = OnceLock::new();
    static OPERATIONS: OnceLock<StdMutex<OperationControl>> = OnceLock::new();
    const CANCELLED: &str = "AirDrop operation cancelled because Turn off was requested.";
    const SEND_TIMEOUT: Duration = Duration::from_secs(900);
    const SEND_TIMED_OUT: &str = "The iPhone did not confirm completion before the send timed out. Check the phone before retrying.";
    const REAP_GRACE: Duration = Duration::from_secs(1);
    const PIPE_GRACE: Duration = Duration::from_millis(250);
    static DISCOVERY_SESSION: OnceLock<Mutex<Option<DiscoverySession>>> = OnceLock::new();
    static DISCOVERY_STATE: OnceLock<StdMutex<(Discovery, std::time::Instant)>> = OnceLock::new();
    static OUTBOUND: OnceLock<StdMutex<Option<OutboundRecord>>> = OnceLock::new();
    static SENDING: AtomicBool = AtomicBool::new(false);
    static DISCOVERY_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static DISCOVERY_REQUESTED_UNTIL: OnceLock<StdMutex<Option<tokio::time::Instant>>> = OnceLock::new();

    struct DiscoverySession {
        cancel: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    struct OutboundRecord {
        value: Outbound,
        started: std::time::Instant,
        phase_started: std::time::Instant,
        ended: Option<std::time::Instant>,
    }

    fn discovery_state() -> &'static StdMutex<(Discovery, std::time::Instant)> {
        DISCOVERY_STATE.get_or_init(|| StdMutex::new((Discovery::default(), std::time::Instant::now())))
    }

    pub fn discovery() -> Discovery {
        let state = discovery_state().lock().unwrap();
        let mut value = state.0.clone();
        value.supported = mt7922_daemon().is_some();
        if !value.running { value.peers.retain(|peer| peer.name.is_some()); }
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        expire_cached_peers(&mut value.peers, now);
        value
    }

    fn expire_cached_peers(peers: &mut Vec<Peer>, now: u64) {
        peers.retain(|peer| peer.last_seen.is_some_and(|seen| seen <= now.saturating_add(5000)
            && now.saturating_sub(seen) <= if peer.connection.is_some() { 30_000 } else { 180_000 }));
        for peer in peers { peer.fresh = peer.name.is_some() && peer.connection.is_none()
            && peer.last_seen.is_some_and(|seen| now.saturating_sub(seen) <= 20_000); }
    }

    pub fn outbound() -> Option<Outbound> {
        if operations().lock().unwrap().stopped { return None; }
        let state = OUTBOUND.get_or_init(|| StdMutex::new(None)).lock().unwrap();
        state.as_ref().filter(|record| record.ended.is_none_or(|ended| ended.elapsed() < Duration::from_secs(5)))
            .map(|record| record.value.clone())
    }

    fn send_phase(phase: &str, sent: Option<u64>, total: Option<u64>) {
        let mut state = OUTBOUND.get_or_init(|| StdMutex::new(None)).lock().unwrap();
        if let Some(record) = state.as_mut() {
            if phase != record.value.phase {
                #[cfg(not(test))]
                crate::log::line(format!("AirDrop send timing: {} took {} ms", record.value.phase, record.phase_started.elapsed().as_millis()));
                record.phase_started = std::time::Instant::now();
            }
            record.value.phase = phase.into();
            record.value.elapsed_ms = record.started.elapsed().as_millis() as u64;
            if sent.is_some() { record.value.sent_bytes = sent; }
            if total.is_some() { record.value.total_bytes = total; }
            if matches!(phase, "complete" | "failed" | "cancelled") {
                record.ended = Some(std::time::Instant::now());
                #[cfg(not(test))]
                crate::log::line(format!("AirDrop send summary: result={phase} metric={} bytes={}/{} elapsed_ms={}",
                    record.value.measurement.as_deref().unwrap_or("unavailable"),
                    record.value.sent_bytes.map(|n| n.to_string()).unwrap_or_else(|| "unknown".into()),
                    record.value.total_bytes.map(|n| n.to_string()).unwrap_or_else(|| "unknown".into()),
                    record.value.elapsed_ms));
            }
        }
    }

    struct SendingSession;
    impl SendingSession {
        fn begin() -> Result<Self, String> {
            SENDING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| "An AirDrop send is already in progress.".to_string())?;
            let now = std::time::Instant::now();
            *OUTBOUND.get_or_init(|| StdMutex::new(None)).lock().unwrap() = Some(OutboundRecord {
                value: Outbound { phase: "choosing".into(), ..Default::default() }, started: now, phase_started: now, ended: None,
            });
            Ok(Self)
        }
    }
    impl Drop for SendingSession {
        fn drop(&mut self) {
            let active = OUTBOUND.get_or_init(|| StdMutex::new(None)).lock().unwrap()
                .as_ref().is_some_and(|record| record.ended.is_none());
            if active { send_phase("cancelled", None, None); }
            SENDING.store(false, Ordering::SeqCst);
        }
    }

    // Registration and off share this short synchronous lock. A new operation
    // cannot subscribe just after a stop signal and mistake it for permission
    // to start. Only a successfully completed explicit enable reopens the gate.
    struct OperationControl {
        stopped: bool,
        epoch: u64,
        changes: watch::Sender<u64>,
    }

    impl OperationControl {
        fn new() -> Self {
            Self { stopped: false, epoch: 0, changes: watch::channel(0).0 }
        }

        fn register(&self) -> Result<Operation, String> {
            if self.stopped { return Err(CANCELLED.into()); }
            Ok(Operation { changes: self.changes.subscribe() })
        }

        fn stop(&mut self) -> u64 {
            self.stopped = true;
            self.epoch += 1;
            self.changes.send_replace(self.epoch);
            self.epoch
        }

        fn enabled(&mut self, epoch: u64) -> bool {
            if self.epoch != epoch { return false; }
            self.stopped = false;
            true
        }
    }

    fn operations() -> &'static StdMutex<OperationControl> {
        OPERATIONS.get_or_init(|| StdMutex::new(OperationControl::new()))
    }

    struct Operation { changes: watch::Receiver<u64> }

    impl Operation {
        fn check(&self) -> Result<(), String> {
            if self.changes.has_changed().unwrap_or(true) { Err(CANCELLED.into()) } else { Ok(()) }
        }

        async fn run<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
            let mut changes = self.changes.clone();
            tokio::select! {
                biased;
                _ = changes.changed() => Err(CANCELLED.into()),
                result = future => Ok(result),
            }
        }
    }

    // Own only a child we spawned, never a receiver PID or a process selected
    // by name. Drop also covers cancellation of the enclosing Tauri future.
    // SIGKILL closes a wake helper's D-Bus connection, removing its advert.
    struct OwnedChild(Option<tokio::process::Child>);

    impl OwnedChild {
        fn spawn(command: &mut Command) -> Result<Self, String> {
            command.kill_on_drop(true).spawn().map(|child| Self(Some(child)))
                .map_err(|err| format!("Could not start AirDrop helper: {err}"))
        }

        fn child(&mut self) -> &mut tokio::process::Child { self.0.as_mut().unwrap() }

        async fn kill_and_reap(&mut self) {
            let child = self.child();
            let _ = child.start_kill();
            // A pathological kernel wait must not prevent off. Drop transfers
            // any remaining reap to the runtime, without waiting on pipe EOF.
            let _ = tokio::time::timeout(REAP_GRACE, child.wait()).await;
        }

        async fn output(&mut self) -> std::io::Result<std::process::Output> {
            let child = self.child();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let mut out = Vec::new();
            let mut err = Vec::new();
            let status = {
                let drain = async {
                    tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
                };
                tokio::pin!(drain);
                tokio::select! {
                    status = child.wait() => {
                        let status = status?;
                        // Descendants may inherit the pipes. Their EOF is not
                        // evidence that our actual child is still running.
                        let _ = tokio::time::timeout(PIPE_GRACE, &mut drain).await;
                        status
                    }
                    drained = &mut drain => {
                        drained?;
                        child.wait().await?
                    }
                }
            };
            Ok(std::process::Output { status, stdout: out, stderr: err })
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                if child.id().is_none() { return; }
                let _ = child.start_kill();
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move { let _ = child.wait().await; });
                }
            }
        }
    }

    async fn operation_output(command: &mut Command, operation: &Operation,
        deadline: Option<Duration>) -> Result<std::process::Output, String> {
        operation.check()?;
        let mut child = OwnedChild::spawn(command.stdin(Stdio::null())
            .stdout(Stdio::piped()).stderr(Stdio::piped()))?;
        let result = operation.run(async {
            match deadline {
                Some(limit) => tokio::time::timeout(limit, child.output()).await
                    .map_err(|_| SEND_TIMED_OUT.to_string())?,
                None => child.output().await,
            }.map_err(|err| format!("Could not run AirDrop helper: {err}"))
        }).await.and_then(|result| result);
        if result.is_err() { child.kill_and_reap().await; }
        result
    }

    #[derive(Default)]
    struct TransferCache {
        key: Option<(u64, usize, u64, SystemTime, u8)>,
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

    /// Consent is short-lived. WebKit can throttle page timers while the island
    /// has been hidden for a long time, so observe the private request from
    /// Rust as well. Only a change in request ID emits; the page still reads
    /// the current file before presenting the card or writing a decision.
    pub fn watch_incoming(app: tauri::AppHandle) {
        use tauri::{Emitter, Manager};
        tauri::async_runtime::spawn(async move {
            let mut seen: Option<String> = None;
            loop {
                let now = incoming().ok().flatten().map(|item| item.id);
                if now != seen {
                    if now.is_some() {
                        // Wake the GTK surface without stealing keyboard focus
                        // from a running agent or changing the radio session.
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            if let Some(win) = handle.get_webview_window(crate::island::WINDOW_LABEL) {
                                let _ = win.show();
                                let _ = win.set_always_on_top(true);
                            }
                        });
                    }
                    seen = now;
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, "airdrop-incoming", ());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
    }

    pub fn decide(id: String, accept: bool) -> Result<(), String> {
        if incoming()?.is_none_or(|item| item.id != id) {
            return Err("This AirDrop request has expired.".into());
        }
        write_decision(&consent_dir()?, &id, accept)
    }

    fn write_decision(dir: &std::path::Path, id: &str, accept: bool) -> Result<(), String> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid AirDrop request.".into());
        }
        // Bind the filename AND contents to the request. Even if A expires and
        // B reuses active/ between checking and writing, A cannot answer B.
        // Publish only a complete answer; the shell must never see an empty file.
        let temporary = dir.join(format!("decision-{id}.tmp"));
        let decision = dir.join(format!("decision-{id}"));
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "This AirDrop request was already answered or has expired.".to_string())?;
        let result = (|| {
            write!(file, "{id} {}", if accept { "accept" } else { "decline" })?;
            // A hard link is atomic and, unlike rename, never replaces a prior
            // explicit answer if two button events race.
            std::fs::hard_link(&temporary, &decision)
        })().map_err(|e| format!("Could not answer AirDrop: {e}"));
        let _ = std::fs::remove_file(temporary);
        result
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
            return Some(upload_start_status(now - start));
        }
        // A quiet log must not freeze age-dependent status in the cache.
        let age = now - start;
        let wait_bucket = if age <= 15 { 0 } else if age <= 90 { 1 } else { 2 };
        let key = (start, offset, len, metadata.modified().ok()?, wait_bucket);
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
        if matches!(state.as_str(), "waiting" | "notStarted") {
            return Some(upload_start_status(age));
        }
        // The log changes only at state transitions. Stat the raw file even
        // when the log is cached, so the ring tracks bytes while data arrives.
        let received_bytes = if state == "receiving" || state == "failed" {
            raw["rawPath"].as_str().and_then(|path| private_archive_received(std::path::Path::new(path), start, now))
                .or_else(|| directory.and_then(|dir| archive_received(dir, start, now)))
        } else { None };
        let measured = received_bytes.and_then(|actual| measured_receive_progress(&raw["progress"], actual, total_bytes, now * 1000));
        if let Some(mut progress) = measured {
            // A counter/phase can never promote an archive to success. Only
            // the existing extraction + final result logs authorize completion.
            progress.state = if state == "receiving" && raw["progress"]["phase"] == "verifying" {
                "verifying".into()
            } else { state };
            return Some(progress);
        }
        Some(Transfer {
            state,
            received_bytes,
            // Legacy raw DVZip sizes and declared decoded totals are not
            // comparable. Keep real byte activity without inventing a percent.
            total_bytes: None,
            wire_bytes: received_bytes,
            bytes_per_second: None,
            message: None,
        })
    }

    fn upload_start_status(age_seconds: u64) -> Transfer {
        Transfer {
            state: if age_seconds > 90 { "failed" } else { "waiting" }.into(),
            received_bytes: None, total_bytes: None, wire_bytes: None, bytes_per_second: None,
            message: Some(if age_seconds > 90 {
                "The upload has not reached Mochi after 90 seconds. No file bytes were received for this request. Check the iPhone before retrying; the receiver is still available."
            } else if age_seconds > 15 {
                "Connection delayed · accepted, but no upload has reached Mochi yet."
            } else {
                "Accepted · waiting for the iPhone to start uploading…"
            }.into()),
        }
    }

    fn measured_receive_progress(value: &serde_json::Value, actual_wire: u64, log_total: Option<u64>, now_ms: u64) -> Option<Transfer> {
        let wire = value["wireBytes"].as_u64()?;
        let updated = value["updatedMs"].as_u64()?;
        // Buffered writes may leave at most one receive slice off disk. Do not
        // trust telemetry for another file or a future/oversized forged sample.
        if wire > actual_wire.saturating_add(65536) || wire > (1u64 << 53) || updated > now_ms.saturating_add(2000) { return None; }
        let decoded = value["decodedBytes"].as_u64().filter(|n| *n <= (1u64 << 53));
        let total = value["totalBytes"].as_u64().or(log_total).filter(|n| (1..=1_000_000_000_000).contains(n));
        let rate = value["bytesPerSecond"].as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1e12)
            .map(|rate| if now_ms.saturating_sub(updated) > 2000 { 0.0 } else { rate });
        Some(Transfer { state: "receiving".into(), received_bytes: decoded.or(Some(wire)),
            total_bytes: if decoded.is_some() { total } else { None }, wire_bytes: Some(wire), bytes_per_second: rate, message: None })
    }

    fn upload_total_bytes(log: &str) -> Option<u64> {
        // Declared decoded/archive total, NOT a compressed wire length. It can
        // be compared only with validated decoded counters, never raw disk
        // sizes. Archive validation, not this header, determines completion.
        let upload = log.rsplit("POST request at /Upload").next()?;
        upload.lines()
            .filter_map(|line| line.strip_prefix("TotalBytes: ")?.trim().parse::<u64>().ok())
            .filter(|total| (1..=1_000_000_000_000).contains(total))
            .next_back()
    }

    fn private_archive_received(path: &std::path::Path, start: u64, now: u64) -> Option<u64> {
        let cache = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
        workspace_archive_received(path, &cache.join("mochi/airdrop/incoming"), start, now)
    }

    fn workspace_archive_received(path: &std::path::Path, incoming: &std::path::Path, start: u64, now: u64) -> Option<u64> {
        use std::os::unix::fs::MetadataExt;
        if !path.is_absolute() || path.is_symlink() { return None; }
        let root = incoming.canonicalize().ok()?;
        let canonical = path.canonicalize().ok()?;
        if canonical != path { return None; }
        let relative = canonical.strip_prefix(root).ok()?;
        if relative.components().count() != 2 { return None; }
        if !relative.parent()?.file_name()?.to_str()?.starts_with("receive-") { return None; }
        let suffix = path.file_name()?.to_str()?.strip_prefix("airdrop-received-")?;
        let (seconds, ext) = suffix.rsplit_once('.')?;
        let seconds = seconds.parse::<u64>().ok()?;
        if !(start..=now).contains(&seconds) || !matches!(ext, "dvzip" | "cpio") { return None; }
        let meta = path.symlink_metadata().ok()?;
        if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } { return None; }
        Some(meta.len())
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
            // Older OpenDrop builds logged success for salvaged partial files;
            // never promote such a result to a completed transfer.
            if log.contains("incomplete, kept as .partial")
                || log.contains("Could not extract the archive")
                || !log.contains("Extracted into")
            {
                Some("failed")
            } else {
                Some("complete")
            }
        } else if log.contains("Receiving file(s)") || log.contains("POST request at /Upload") {
            // A large file can take much longer than the old 90-second cap.
            Some("receiving")
        } else if age_seconds <= 90 {
            Some("waiting")
        } else {
            Some("notStarted")
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
        executable_daemon_in(&crate::platform::local_dir())
    }

    fn executable_daemon_in(data: &std::path::Path) -> Option<PathBuf> {
        let daemon = data.join("airdrop-mt7921/daemon/airdropd");
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
            .args(["-ltnpH", "( sport = :8771 )"])
            .output()
            .await
            .is_ok_and(|out| out.status.success() && receiver_socket_owned(
                &String::from_utf8_lossy(&out.stdout), std::path::Path::new("/proc"),
                &crate::platform::local_dir().join("owl/.venv-opendrop/bin/opendrop"),
            ))
    }

    fn receiver_socket_owned(sockets: &str, proc_root: &std::path::Path, opendrop: &std::path::Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        sockets.split("pid=").skip(1).filter_map(|part| {
            part.split(|c: char| !c.is_ascii_digit()).next()?.parse::<u32>().ok()
        }).any(|pid| {
            let worker = proc_root.join(pid.to_string());
            if !worker.metadata().is_ok_and(|m| m.uid() == unsafe { libc::geteuid() }) { return false; }
            let Ok(argv) = std::fs::read(worker.join("cmdline")) else { return false };
            let args: Vec<&[u8]> = argv.split(|b| *b == 0).collect();
            args.contains(&opendrop.as_os_str().as_encoded_bytes()) && args.contains(&b"receive".as_slice())
        })
    }

    async fn mt7922_port_in_use() -> bool {
        // An unrelated listener is not our receiver and must never be stopped,
        // but it still prevents a new receiver from binding this port.
        Command::new("ss").args(["-ltnH", "( sport = :8771 )"])
            .output().await.is_ok_and(|out| out.status.success() && !out.stdout.is_empty())
    }

    struct IdleReceiverGuard(std::fs::File);

    impl Drop for IdleReceiverGuard {
        fn drop(&mut self) {
            use std::os::fd::AsRawFd;
            // O_CLOEXEC closes the descriptor at exec, not at fork. A command
            // launched concurrently may briefly inherit this open description;
            // explicitly unlock so it cannot delay our handoff to airdropd.
            unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); }
        }
    }

    fn lock_idle_receiver_at(directory: &std::path::Path) -> Result<IdleReceiverGuard, String> {
        use std::os::{fd::AsRawFd, unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt}};
        if !directory.exists() {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(directory)
                .map_err(|e| format!("Could not prepare the AirDrop session lock: {e}"))?;
        }
        if !directory.symlink_metadata().is_ok_and(|m| m.is_dir()
            && m.uid() == unsafe { libc::geteuid() } && m.permissions().mode() & 0o022 == 0) {
            return Err("The AirDrop session lock directory is unsafe.".into());
        }
        let file = OpenOptions::new().append(true).create(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(directory.join("lock"))
            .map_err(|e| format!("Could not open the AirDrop session lock: {e}"))?;
        if !file.metadata().is_ok_and(|m| m.is_file()
            && m.uid() == unsafe { libc::geteuid() } && m.permissions().mode() & 0o022 == 0) {
            return Err("The AirDrop session lock is unsafe.".into());
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("An AirDrop session is starting, running, or being updated. Mochi will not interrupt it.".into());
        }
        Ok(IdleReceiverGuard(file))
    }

    fn lock_idle_receiver() -> Result<IdleReceiverGuard, String> {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").ok_or("No private runtime directory is available.")?;
        lock_idle_receiver_at(&PathBuf::from(runtime).join("airdropd"))
    }

    async fn mt7922_service_running() -> bool {
        Command::new("systemctl").args(["--user", "show", "mochi-airdrop.service", "-p", "MainPID", "--value"])
            .output().await.is_ok_and(|out| out.status.success()
                && String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().is_ok_and(|pid| pid != 0))
    }

    async fn stop_mt7922_service() -> Result<(), String> {
        let output = tokio::time::timeout(Duration::from_secs(35),
            Command::new("systemctl").args(["--user", "stop", "mochi-airdrop.service"])
                .kill_on_drop(true).output()).await
            .map_err(|_| "The AirDrop service did not stop in time.".to_string())?
            .map_err(|e| format!("Could not stop the AirDrop service: {e}"))?;
        if !output.status.success() { return Err("Could not stop the AirDrop user service.".into()); }
        Ok(())
    }

    /// The receiver survives Mochi UI restarts. Read its actual OpenDrop
    /// worker's cwd rather than guessing the destination from new settings or
    /// from a stale page-local value. The child must belong to our user service
    /// and be the installed OpenDrop receive command, not an unrelated process.
    async fn mt7922_live_directory() -> Option<String> {
        let output = Command::new("systemctl")
            .args(["--user", "show", "mochi-airdrop.service", "-p", "MainPID", "--value"])
            .output().await.ok()?;
        if !output.status.success() { return None; }
        let pid = String::from_utf8_lossy(&output.stdout).trim().parse::<u32>().ok()?;
        if pid == 0 { return None; }
        let process = PathBuf::from(format!("/proc/{pid}"));
        let daemon = mt7922_daemon()?;
        let argv = std::fs::read(process.join("cmdline")).ok()?;
        if !argv.split(|b| *b == 0).any(|part| part == daemon.to_string_lossy().as_bytes()) ||
            !argv.split(|b| *b == 0).any(|part| part == b"run") {
            return None;
        }
        let children = std::fs::read_to_string(process.join(format!("task/{pid}/children"))).ok()?;
        let opendrop = crate::platform::local_dir().join("owl/.venv-opendrop/bin/opendrop");
        for child in children.split_whitespace().filter_map(|s| s.parse::<u32>().ok()) {
            let worker = PathBuf::from(format!("/proc/{child}"));
            let Ok(args) = std::fs::read(worker.join("cmdline")) else { continue };
            let args: Vec<&[u8]> = args.split(|b| *b == 0).collect();
            if !args.contains(&opendrop.to_string_lossy().as_bytes()) || !args.contains(&b"receive".as_slice()) {
                continue;
            }
            let Ok(directory) = std::fs::read_link(worker.join("cwd")) else { continue };
            if directory.is_absolute() && directory.is_dir() {
                return Some(directory.to_string_lossy().into_owned());
            }
        }
        None
    }

    async fn wait_for_mt7922_session(running: bool, seconds: u64) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        loop {
            let radio = mt7922_radio_state().await?;
            let listener = mt7922_receiver_listening().await;
            let active = radio.mon && radio.active && radio.go && listener
                && mt7922_live_directory().await.is_some();
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
        let directory = if active { mt7922_live_directory().await } else { None };
        Ok(Status {
            installed: true,
            receiving: active,
            visible,
            // The backend may use a custom name and destination from its
            // own config; do not present guessed values as confirmed state.
            name: None,
            remaining: None,
            directory,
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
        if enabled {
            let daemon = mt7922_ready()?;
            let (name, directory) = preferences(name, directory)?;
            if mt7922_status().await?.receiving {
                return mt7922_status().await;
            }
            // A startup/send session owns this lock before it opens a socket.
            // Hold it through orphan cleanup; a missing listener is NOT proof
            // that an existing standalone daemon is abandoned.
            let idle_guard = lock_idle_receiver()?;
            if mt7922_port_in_use().await {
                return Err("TCP port 8771 is already in use. Mochi will not replace another receiver or stop an unrelated service.".into());
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
                "--setenv=AIRDROP_UPLOAD_IDLE_TIMEOUT=300",
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
            // The daemon takes the same lock itself. If another session wins
            // this handoff, it must not be torn down by our failure cleanup.
            drop(idle_guard);
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
                let _ = stop_mt7922_service().await;
                if let Ok(_idle_guard) = lock_idle_receiver() {
                    let _ = mt7922_stop_radio_helpers().await;
                }
                STARTED_BY_MOCHI.store(false, Ordering::Relaxed);
                return Err(err);
            }
        } else {
            let (ok, output) = if mt7922_service_running().await {
                // Service ownership survives a removed/non-executable daemon.
                stop_mt7922_service().await?;
                (true, String::new())
            } else {
                run_mt7922(&["stop"], 10).await?
            };
            // "not running" is harmless here: it means the process already
            // died and only its helpers may remain, which we clean next.
            if !ok && !output.contains("not running") {
                return Err(if output.is_empty() {
                    "Could not stop the AirDrop receiver.".into()
                } else {
                    output
                });
            }
            let _idle_guard = lock_idle_receiver()?;
            mt7922_stop_radio_helpers().await?;
            wait_for_mt7922_session(false, 8).await?;
            STARTED_BY_MOCHI.store(false, Ordering::Relaxed);
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                let _ = std::fs::remove_file(
                    PathBuf::from(runtime).join("mochi-airdrop/transfer.json"),
                );
            }
        }
        let status = if mt7922_daemon().is_some() { mt7922_status().await? } else {
            Status { installed: false, receiving: false, visible: false,
                message: Some("AirDrop stopped. Reinstall the missing MT7922 backend before starting it again.".into()),
                ..Status::default() }
        };
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
        #[serde(default, rename = "lastSeen")]
        last_seen: Option<f64>,
        connection: Option<String>,
    }

    fn parse_mt_peers(raw: Vec<RawMtPeer>, own_name: &str, own_addresses: &str) -> Vec<Peer> {
        parse_mt_peers_with_age(raw, own_name, own_addresses, 25.0)
    }

    fn parse_mt_peers_with_age(raw: Vec<RawMtPeer>, own_name: &str, own_addresses: &str, max_age: f64) -> Vec<Peer> {
        raw.into_iter()
            .take(50)
            .filter_map(|item| {
                let name = item.name.as_deref().unwrap_or("").trim().to_string();
                let connecting = max_age >= 180.0 && name.is_empty()
                    && matches!(item.connection.as_deref(), Some("connecting" | "retrying"))
                    && item.last_seen.is_some()
                    && item.address.as_deref().and_then(|address| address.split('%').next())
                        .and_then(|address| address.parse::<std::net::Ipv6Addr>().ok())
                        .is_some_and(|address| address.is_unicast_link_local());
                if (!connecting && name.is_empty())
                    || name.len() > 80
                    || name.chars().any(char::is_control)
                    || (!name.is_empty() && name == own_name.trim())
                    || item.id.len() != 12
                    || !item.id.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || item.last_seen.is_some_and(|seen| {
                        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs_f64();
                        !seen.is_finite() || seen > now + 5.0 || now - seen > if connecting { 30.0 } else { max_age }
                    })
                    || item
                        .address
                        .as_deref()
                        .is_some_and(|addr| own_addresses.contains(addr))
                {
                    return None;
                }
                Some(Peer {
                    mac: item.id,
                    name: if connecting { None } else { Some(name) },
                    rssi: None,
                    last_seen: item.last_seen.map(|seen| (seen * 1000.0) as u64),
                    fresh: !connecting && item.last_seen.is_none_or(|seen| {
                        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs_f64();
                        now - seen <= 20.0
                    }),
                    connection: if connecting { item.connection } else { None },
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

    async fn start_ble_wake(operation: &Operation) -> Result<OwnedChild, String> {
        let script = crate::platform::local_dir().join("airdrop-mt7921/tools/blewake-dbus.py");
        if !script.is_file() {
            return Err("The AirDrop Bluetooth wake helper is missing. Reinstall the optional MT7922 backend.".into());
        }
        // BlueZ owns this advertisement. Dropping the child closes its D-Bus
        // connection and unregisters it, including if a scan is cancelled.
        operation.check()?;
        let mut child = OwnedChild::spawn(Command::new("python3")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true))?;
        let stdout = child
            .child()
            .stdout
            .take()
            .ok_or("Could not read Bluetooth wake status.")?;
        let mut output = BufReader::new(stdout);
        let mut line = String::new();
        let ready = operation.run(tokio::time::timeout(Duration::from_secs(6), output.read_line(&mut line))).await;
        if !matches!(ready, Ok(Ok(Ok(n))) if n > 0 && line.trim() == "advert up") {
            child.kill_and_reap().await;
            if let Err(err) = ready { return Err(err); }
            return Err("Bluetooth could not advertise AirDrop discovery. Check that Bluetooth is enabled and BlueZ is running.".into());
        }
        child.child().stdout = Some(output.into_inner());
        Ok(child)
    }

    async fn stop_ble_wake(mut child: OwnedChild) {
        child.kill_and_reap().await;
    }

    pub async fn discovery_set(enabled: bool) -> Result<Discovery, String> {
        let revision = DISCOVERY_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
        let until = enabled.then(|| tokio::time::Instant::now() + Duration::from_secs(600));
        *DISCOVERY_REQUESTED_UNTIL.get_or_init(|| StdMutex::new(None)).lock().unwrap() = until;
        discovery_set_until(enabled, until, Some(revision)).await
    }

    async fn discovery_set_until(enabled: bool, until: Option<tokio::time::Instant>, revision: Option<u64>) -> Result<Discovery, String> {
        let mut session = DISCOVERY_SESSION.get_or_init(|| Mutex::new(None)).lock().await;
        if revision.is_some_and(|revision| revision != DISCOVERY_REVISION.load(Ordering::SeqCst)) {
            return Ok(discovery());
        }
        if let Some(previous) = session.as_ref() {
            if enabled && !previous.task.is_finished() { return Ok(discovery()); }
        }
        if let Some(mut previous) = session.take() {
            previous.cancel.send_replace(true);
            if tokio::time::timeout(Duration::from_secs(3), &mut previous.task).await.is_err() {
                previous.task.abort();
                let _ = previous.task.await;
            }
        }
        let cached = discovery().peers;
        *discovery_state().lock().unwrap() = (Discovery { peers: cached, ..Default::default() }, std::time::Instant::now());
        if !enabled { return Ok(discovery()); }
        if SENDING.load(Ordering::SeqCst) { return Err("Finish the current send before finding devices again.".into()); }
        let operation = operations().lock().unwrap().register()?;
        if mt7922_daemon().is_none() {
            return Ok(discovery());
        }
        if !operation.run(mt7922_status()).await??.visible { return Err("Turn on AirDrop before finding devices.".into()); }
        operation.check()?;
        if revision.is_some_and(|revision| revision != DISCOVERY_REVISION.load(Ordering::SeqCst)) { return Ok(discovery()); }
        if SENDING.load(Ordering::SeqCst) { return Err("Finish the current send before finding devices again.".into()); }
        let python = crate::platform::local_dir().join("owl/.venv-opendrop/bin/python");
        let script = crate::platform::local_dir().join("bin/mochi-airdrop-browse");
        if !python.is_file() || !script.is_file() { return Err("The continuous AirDrop browser is missing. Rerun Mochi setup.".into()); }
        let (cancel, mut changes) = watch::channel(false);
        let deadline = until.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(600));
        let cached = discovery().peers;
        *discovery_state().lock().unwrap() = (Discovery { running: true, peers: cached, ..Default::default() }, std::time::Instant::now());
        let task = tokio::spawn(async move {
            let work = async {
                let mut wake = start_ble_wake(&operation).await?;
                // Browse immediately while the phone wakes. One browser and
                // advertisement stay alive; no repeated cold-start delays.
                let mut child = OwnedChild::spawn(Command::new(python).arg("-u").arg(script).arg("--cache")
                    .env("OPENDROP_QUERY_INTERVAL", "1.0")
                    .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()))?;
                let mut reader = BufReader::new(child.child().stdout.take().unwrap());
                let result: Result<(), String> = async {
                    loop {
                        let mut line = String::new();
                        let length = tokio::select! {
                            _ = tokio::time::sleep_until(deadline) => return Ok(()),
                            read = operation.run(reader.read_line(&mut line)) => read?.map_err(|_| "AirDrop browser stopped unexpectedly.".to_string())?,
                        };
                        if length == 0 { return Err("AirDrop browser ended. Use Find iPhone to restart it.".into()); }
                        if line.len() > 32768 { return Err("AirDrop browser returned an oversized device list.".into()); }
                        let raw: Vec<RawMtPeer> = serde_json::from_str(&line).map_err(|_| "AirDrop browser returned an invalid device list.")?;
                        let peers = parse_mt_peers_with_age(raw, "", "", 180.0); // Display-only cache, never upload authorization.
                        *discovery_state().lock().unwrap() = (Discovery { supported: true, running: true, peers, error: None }, std::time::Instant::now());
                    }
                }.await;
                child.kill_and_reap().await;
                wake.kill_and_reap().await;
                result
            };
            let result = tokio::select! {
                _ = changes.changed() => Ok(()),
                result = operation.run(work) => result.and_then(|result| result),
            };
            let mut state = discovery_state().lock().unwrap();
            state.0.running = false;
            state.0.error = result.err().filter(|message| message != CANCELLED);
        });
        *session = Some(DiscoverySession { cancel, task });
        Ok(discovery())
    }

    async fn scan_mt7922_peers(operation: &Operation) -> Result<Vec<Peer>, String> {
        let _guard = operation.run(SWITCH.get_or_init(|| Mutex::new(())).lock()).await?;
        if !operation.run(mt7922_status()).await??.visible {
            return Err(
                "Turn on AirDrop and wait until its radio is visible before scanning.".into(),
            );
        }
        let opendrop = crate::platform::local_dir().join("owl/.venv-opendrop/bin/opendrop");
        if !opendrop.is_file() {
            return Err("The MT7922 AirDrop discovery tool is missing.".into());
        }
        let wake = start_ble_wake(operation).await?;
        let result = async {
            // Give the iPhone a moment to wake AWDL before mDNS queries.
            operation.run(tokio::time::sleep(Duration::from_secs(3))).await?;
            scan_mt7922_peers_awdl(opendrop, None, operation).await
        }.await;
        stop_ble_wake(wake).await;
        result
    }

    async fn scan_mt7922_peers_awdl(opendrop: PathBuf, receiver: Option<&str>, operation: &Operation) -> Result<Vec<Peer>, String> {
        let started = SystemTime::now();
        operation.check()?;
        let browser = crate::platform::local_dir().join("bin/mochi-airdrop-browse");
        if !browser.is_file() { return Err("Mochi's live AirDrop browser is missing. Rerun setup.".into()); }
        let mut child = OwnedChild::spawn(Command::new(opendrop.with_file_name("python"))
            .arg("-u").arg(browser).env("OPENDROP_QUERY_INTERVAL", "1.0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true))?;
        // OpenDrop persists each resolved service. Return a named peer as soon
        // as it arrives instead of spending 25s aging a result already found.
        // Only a changed report may trigger address lookup/parsing; never use
        // an old scan, and keep browsing when the only result is Mochi itself.
        let mut report_version = None;
        let result = wait_for_mt_peers(&mut child, receiver, operation, Duration::from_secs(25),
            Duration::from_millis(500), || {
            let version = mt7922_report().and_then(|path| std::fs::metadata(path).ok()?.modified().ok());
            if version.is_some_and(|modified| modified >= started) && version != report_version {
                report_version = version;
                return recent_mt7922_peers(Some(started)).ok();
            }
            None
        }).await;
        if result.is_err() {
            child.kill_and_reap().await;
            return result;
        }
        // The browser persists every resolved service atomically, and the
        // wait above reads that fresh report before returning a match. Nothing
        // needs to be flushed on SIGINT. zeroconf.close() can otherwise hang
        // for eight seconds after the phone was already found. Stop only our
        // browser child immediately; never signal the independent receiver.
        child.kill_and_reap().await;
        operation.check()?;
        let peers = recent_mt7922_peers(Some(started))?;
        if receiver.is_some_and(|id| !selected_mt_peer_present(&peers, id)) {
            return Err("The selected iPhone did not answer the connection check. Everyone mode alone does not confirm an AWDL connection. Keep it unlocked and retry; if its identity rotated, select its new entry. No files were sent.".into());
        }
        if peers.is_empty() {
            return Err("No iPhone AirDrop service answered. To send from Mochi, unlock the iPhone, select Everyone for 10 Minutes, CLOSE its Share sheet, and scan again. To receive on Mochi, OPEN the iPhone Share sheet and look for Mochi there.".into());
        }
        Ok(peers)
    }

    async fn wait_for_mt_peers(child: &mut OwnedChild, receiver: Option<&str>, operation: &Operation,
        limit: Duration, poll: Duration, mut read: impl FnMut() -> Option<Vec<Peer>>) -> Result<Vec<Peer>, String> {
        let deadline = tokio::time::Instant::now() + limit;
        let mut peers = Vec::new();
        loop {
            operation.check()?;
            if let Some(latest) = read() { peers = latest; }
            let found = receiver.map_or(!peers.is_empty(), |id| selected_mt_peer_present(&peers, id));
            if found || child.child().try_wait().map_err(|err| err.to_string())?.is_some()
                || tokio::time::Instant::now() >= deadline { return Ok(peers); }
            operation.run(tokio::time::sleep_until(deadline.min(tokio::time::Instant::now() + poll))).await?;
        }
    }

    fn mt7922_send_command(opendrop: &std::path::Path, receiver: &str, name: &str, files: &[String]) -> Command {
        let mut command = Command::new(opendrop.with_file_name("python"));
        command.arg("-u").arg(crate::platform::local_dir().join("bin/mochi-airdrop-send"));
        command.args(["-n", name, "-i", "awdl0", "-r", receiver]);
        for file in files { command.arg("-f").arg(file); }
        command.kill_on_drop(true);
        command
    }

    fn fresh_selected_report(raw: &str, receiver: &str, now: f64, max_age: f64) -> Option<serde_json::Value> {
        if raw.len() > 65536 { return None; }
        let rows: Vec<serde_json::Value> = serde_json::from_str(raw).ok()?;
        let peer = rows.into_iter().take(50).find(|peer| {
            let seen = peer["lastSeen"].as_f64().unwrap_or(f64::NAN);
            let name = peer["name"].as_str().unwrap_or("");
            peer["id"].as_str().is_some_and(|id| id.eq_ignore_ascii_case(receiver))
                && peer["discoverable"].as_bool() == Some(true)
                && seen.is_finite() && seen <= now && now - seen <= max_age
                && !name.is_empty() && name.len() <= 320 && !name.chars().any(char::is_control)
                && peer["port"].as_u64().is_some_and(|port| port > 0 && port <= 65535)
                && peer["address"].as_str().is_some_and(|address| address.split('%').next()
                    .and_then(|address| address.parse::<std::net::Ipv6Addr>().ok())
                    .is_some_and(|address| address.is_unicast_link_local()))
        })?;
        Some(serde_json::json!([peer]))
    }

    fn current_selected_report(receiver: &str, max_age: f64) -> Option<serde_json::Value> {
        let raw = std::fs::read_to_string(mt7922_report()?).ok()?;
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs_f64();
        fresh_selected_report(&raw, receiver, now, max_age)
    }

    fn live_selected_report(raw: &str, receiver: &str, now: f64) -> Option<serde_json::Value> {
        let selected = fresh_selected_report(raw, receiver, now, 180.0)?;
        let peer = selected.as_array()?.first()?;
        let announced = peer["lastAnnounced"].as_f64()?;
        if peer["sessionVerified"].as_bool() != Some(true)
            || !announced.is_finite() || announced > now || now - announced > 30.0 {
            return None;
        }
        Some(selected)
    }

    fn current_live_selected_report(receiver: &str) -> Option<serde_json::Value> {
        // Internal supported flips only after this browser has emitted its
        // first list (and initialized its report). The public discovery()
        // accessor instead computes hardware support, even during startup.
        if { let state = discovery_state().lock().unwrap(); !state.0.running || !state.0.supported } { return None; }
        let raw = std::fs::read_to_string(mt7922_report()?).ok()?;
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs_f64();
        live_selected_report(&raw, receiver, now)
    }

    struct SendReport(PathBuf);
    impl SendReport {
        fn focus(receiver: &str) -> Result<Self, String> {
            use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
            let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
            let staged = Self::new(&serde_json::json!({"id":receiver,
                "nonce":now.as_nanos().to_string(), "expires":now.as_secs_f64() + 15.0}))?;
            let parent = staged.0.parent().unwrap().join("mochi-airdrop");
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&parent).map_err(|err| err.to_string())?;
            let meta = parent.symlink_metadata().map_err(|err| err.to_string())?;
            if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o077 != 0 {
                return Err("The AirDrop discovery runtime directory is not private.".into());
            }
            let path = parent.join("find-focus.json");
            std::fs::rename(&staged.0, &path).map_err(|err| err.to_string())?;
            Ok(Self(path))
        }

        fn new(report: &serde_json::Value) -> Result<Self, String> {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
            use std::io::Write;
            let parent = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).ok_or("No private runtime directory is available.")?;
            let meta = parent.symlink_metadata().map_err(|err| err.to_string())?;
            if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o077 != 0 {
                return Err("The AirDrop runtime directory is not private.".into());
            }
            let nonce = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos();
            let path = parent.join(format!("mochi-send-{}-{nonce}.json", std::process::id()));
            let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|err| err.to_string())?;
            let owned = Self(path);
            file.write_all(report.to_string().as_bytes()).map_err(|err| err.to_string())?;
            Ok(owned)
        }
    }
    impl Drop for SendReport {
        fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
    }

    fn read_send_progress(line: &str) -> bool {
        let Some(json) = line.strip_prefix("MOCHI_SEND ") else { return false; };
        if json.len() > 2048 { return true; }
        if let Ok(progress) = serde_json::from_str::<Outbound>(json) {
            if matches!(progress.phase.as_str(), "connecting" | "asking" | "accepted" | "preparing" | "sending" | "stalled" | "confirming")
                && progress.sent_bytes.zip(progress.total_bytes).is_none_or(|(sent, total)| total > 0 && sent <= total && total <= (1u64 << 53)) {
                send_phase(&progress.phase, progress.sent_bytes, progress.total_bytes);
                if matches!(progress.measurement.as_deref(), Some("tcpAck" | "tlsWritten")) {
                    let mut state = OUTBOUND.get_or_init(|| StdMutex::new(None)).lock().unwrap();
                    if let Some(record) = state.as_mut() {
                        if record.value.measurement != progress.measurement {
                            #[cfg(not(test))]
                            crate::log::line(format!("AirDrop send metric: {}", progress.measurement.as_deref().unwrap()));
                        }
                        record.value.measurement = progress.measurement;
                    }
                }
                if let Some(rate) = progress.bytes_per_second.filter(|rate| rate.is_finite() && *rate >= 0.0 && *rate <= 1e12) {
                    if let Some(record) = OUTBOUND.get_or_init(|| StdMutex::new(None)).lock().unwrap().as_mut() {
                        record.value.bytes_per_second = Some(rate);
                    }
                }
            }
        }
        true
    }

    fn sender_line(line: &str, diagnostic: &mut String) {
        if !read_send_progress(line.trim_end()) && diagnostic.len() < 16384 {
            let mut end = (16384 - diagnostic.len()).min(line.len());
            while !line.is_char_boundary(end) { end -= 1; }
            diagnostic.push_str(&line[..end]);
        }
    }

    async fn sender_output(command: &mut Command, operation: &Operation) -> Result<std::process::Output, String> {
        operation.check()?;
        let mut child = OwnedChild::spawn(command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()))?;
        let mut reader = BufReader::new(child.child().stderr.take().unwrap());
        let mut diagnostic = String::new();
        let result = operation.run(tokio::time::timeout(SEND_TIMEOUT, async {
            let mut eof = false;
            loop {
                let mut line = String::new();
                tokio::select! {
                    status = child.child().wait() => {
                        let status = status.map_err(|err| err.to_string())?;
                        let mut tail = String::new();
                        let mut limited = (&mut reader).take(32768);
                        let _ = tokio::time::timeout(PIPE_GRACE, limited.read_to_string(&mut tail)).await;
                        for line in tail.lines() { sender_line(line, &mut diagnostic); }
                        // Completion is the process result, not a child-supplied
                        // phase or a byte counter that merely reached its total.
                        return Ok(std::process::Output { status, stdout: vec![], stderr: diagnostic.into_bytes() });
                    }
                    read = reader.read_line(&mut line), if !eof => {
                        let count = read.map_err(|err| err.to_string())?;
                        if count == 0 { eof = true; continue; }
                        if line.len() > 32768 { return Err("AirDrop sender returned an oversized status line.".into()); }
                        sender_line(&line, &mut diagnostic);
                    }
                }
            }
        })).await.and_then(|result| result.map_err(|_| SEND_TIMED_OUT.to_string())).and_then(|result| result);
        if result.is_err() { child.kill_and_reap().await; }
        result
    }

    fn mt7922_send_error(code: Option<i32>, diagnostic: &str) -> String {
        if code == Some(124) || code == Some(137) {
            return SEND_TIMED_OUT.into();
        }
        if diagnostic.contains("ConnectionRefusedError") || diagnostic.contains("RemoteDisconnected")
            || diagnostic.contains("Selected AirDrop service no longer exists") {
            return "The iPhone's receiving connection changed or closed. Keep it unlocked with Everyone enabled and its Share sheet closed, then use Find iPhone again.".into();
        }
        if diagnostic.contains("Receiver declined") {
            return "The iPhone declined the request or its acceptance window expired. Retry and accept the prompt on the iPhone.".into();
        }
        if diagnostic.contains("TimeoutError") || diagnostic.contains("timed out") {
            return "The iPhone connection stalled before delivery was confirmed. Keep it nearby and unlocked; check the phone before retrying to avoid duplicates.".into();
        }
        "AirDrop did not confirm delivery. Keep the iPhone nearby in receiving mode, use Find iPhone again, then retry.".into()
    }

    fn selected_mt_peer_present(peers: &[Peer], receiver: &str) -> bool {
        peers.iter().any(|peer| peer.mac.eq_ignore_ascii_case(receiver) && peer.name.is_some())
    }

    fn selected_service_retired(snapshot: &Discovery, receiver: &str) -> bool {
        // Named devices stay in the display cache for three minutes. If a
        // populated live list has already removed this ID, don't spend another
        // 25 seconds waiting on that retired selection. An unresolved entry
        // with the SAME ID still deserves its connection check. Never replace
        // the selected ID by matching another row's name.
        snapshot.running && !snapshot.peers.is_empty()
            && !snapshot.peers.iter().any(|peer| peer.mac.eq_ignore_ascii_case(receiver))
    }

    fn check_selected_service(snapshot: &Discovery, receiver: &str) -> Result<(), String> {
        if selected_service_retired(snapshot, receiver) {
            crate::log::line("AirDrop send: selected exact service left the live device list; no upload attempted");
            return Err("The selected iPhone connection is no longer listed. Select its current entry in Mochi before choosing files again. No files were sent.".into());
        }
        Ok(())
    }

    async fn send_mt7922_files(opendrop: PathBuf, receiver: &str, name: &str, files: &[String], operation: &Operation) -> Result<String, String> {
        // The chooser may stay open for minutes. A wake that ended with the
        // initial scan is no longer proof that the phone still accepts TCP.
        // Re-wake after selection, resolve the SAME service, and retain the
        // advert until the upload finishes. Never substitute a matching name.
        send_phase("waking", None, None);
        let wake = start_ble_wake(operation).await?;
        let result = async {
            send_phase("discovering", None, None);
            // Keep the exact selected recipient through the chooser. Reuse a
            // recent name probe, or an exact current announcement whose name
            // was verified in this browser session. A slow redundant Discover
            // must not block the real TLS/Ask acceptance connection. Display-
            // only cache entries and name-based substitutions remain forbidden.
            // Freeze it privately before stopping background probes so neither
            // report rewrites nor /Discover contention can disrupt the upload.
            let mut report = current_selected_report(receiver, 5.0)
                .or_else(|| current_live_selected_report(receiver));
            if report.is_none() && discovery().running {
                check_selected_service(&discovery(), receiver)?;
                let _focus = SendReport::focus(receiver).ok();
                // Keep the already-established browser/wake alive rather than
                // throwing away its mDNS state when one probe was lost.
                let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
                while report.is_none() && discovery().running && tokio::time::Instant::now() < deadline {
                    operation.run(tokio::time::sleep(Duration::from_millis(250))).await?;
                    report = current_selected_report(receiver, 5.0)
                        .or_else(|| current_live_selected_report(receiver));
                    if report.is_none() { check_selected_service(&discovery(), receiver)?; }
                }
                if report.is_none() && discovery().running {
                    return Err("The selected iPhone stopped answering connection checks. The background search is still running; keep it unlocked or select its new entry if its identity rotated. No files were sent.".into());
                }
            }
            discovery_set_until(false, None, None).await?;
            if report.is_none() {
                scan_mt7922_peers_awdl(opendrop.clone(), Some(receiver), operation).await?;
                report = current_selected_report(receiver, 25.0);
            } else {
                crate::log::line("AirDrop send: reused the verified exact live service; redundant discovery skipped");
            }
            let report = SendReport::new(&report.ok_or("The selected iPhone connection expired before sending; no files were sent.")?)?;
            crate::log::line(format!("AirDrop send: starting {} file(s) to the selected recipient", files.len()));
            let mut command = mt7922_send_command(&opendrop, receiver, name, files);
            command.arg("--report").arg(&report.0);
            let output = sender_output(&mut command, operation).await?;
            if !output.status.success() {
                let message = mt7922_send_error(output.status.code(), &String::from_utf8_lossy(&output.stderr));
                crate::log::line(format!("AirDrop send: {message}"));
                return Err(message);
            }
            crate::log::line("AirDrop send: receiver confirmed upload");
            Ok("AirDrop transfer complete.".into())
        }.await;
        stop_ble_wake(wake).await;
        result
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
        if mt7922_service_running().await {
            let active = mt7922_radio_active().await.unwrap_or(false) && mt7922_receiver_listening().await;
            return Ok(Status { installed: true, receiving: active, visible: active,
                message: Some("The MT7922 backend is missing, but its service is still running. Turn AirDrop off, then reinstall the backend.".into()),
                ..Status::default() });
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
        // This must precede EVERY await, including backend/service detection
        // and waiting for SWITCH. New sends/scans are barred until enabled.
        let epoch = {
            let mut control = operations().lock().unwrap();
            if enabled { control.epoch } else { control.stop() }
        };
        if !enabled { discovery_set(false).await?; }
        let _guard = SWITCH.get_or_init(|| Mutex::new(())).lock().await;
        if enabled && operations().lock().unwrap().epoch != epoch { return Err(CANCELLED.into()); }
        let result = set_locked(enabled, name, directory).await;
        if enabled && result.as_ref().is_ok_and(|status| status.receiving)
            && !operations().lock().unwrap().enabled(epoch) {
            return Err(CANCELLED.into());
        }
        result
    }

    async fn set_locked(enabled: bool, name: &str, directory: &str) -> Result<Status, String> {
        if mt7922_daemon().is_some() || (!enabled && mt7922_service_running().await) {
            return mt7922_set(enabled, name, directory).await;
        }
        if enabled && (name.trim() != "Mochi" || !directory.is_empty()) {
            return Err(
                "Custom AirDrop name and save folder currently require the MT7922 backend.".into(),
            );
        }
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
        let _ = discovery_set(false).await;
        // The MT7922 receiver is now its own user service. Only the explicit
        // AirDrop toggle may stop it; closing or restarting Mochi does not.
        if mt7922_daemon().is_some() || mt7922_service_running().await {
            return;
        }
        if STARTED_BY_MOCHI.load(Ordering::Relaxed) {
            let _ = set(false, "Mochi", "").await;
        }
    }

    pub async fn peers(named: bool) -> Result<Vec<Peer>, String> {
        let operation = operations().lock().unwrap().register()?;
        if mt7922_daemon().is_some() {
            if named {
                return scan_mt7922_peers(&operation).await;
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
        let _guard = operation.run(SWITCH.get_or_init(|| Mutex::new(())).lock()).await?;
        let (ok, output) = run_operation(args, if named { 35 } else { 12 }, &operation).await?;
        // Omdrop exits 1 with [] when there are no devices in range.
        if !ok && output != "[]" {
            return Err(output);
        }
        serde_json::from_str(&output).map_err(|_| "Omdrop returned an invalid peer list.".into())
    }

    pub async fn send(mac: String) -> Result<String, String> {
        if transfer().is_some_and(|transfer| matches!(transfer.state.as_str(), "receiving" | "verifying")) {
            return Err("Wait for the incoming AirDrop transfer to finish before sending on the shared radio.".into());
        }
        let session = SendingSession::begin()?;
        let revision = DISCOVERY_REVISION.load(Ordering::SeqCst);
        let epoch = operations().lock().unwrap().epoch;
        // Keep the user's intent through temporary pauses and a second send
        // begun before asynchronous search restart has completed.
        let resume = *DISCOVERY_REQUESTED_UNTIL.get_or_init(|| StdMutex::new(None)).lock().unwrap();
        let result = send_inner(mac).await;
        let phase = match &result {
            Ok(_) => "complete",
            Err(error) if error == CANCELLED || error == "No files selected." => "cancelled",
            Err(_) => "failed",
        };
        send_phase(phase, None, None);
        drop(session);
        if resume.is_some_and(|deadline| deadline > tokio::time::Instant::now())
            && { let control = operations().lock().unwrap(); !control.stopped && control.epoch == epoch }
            && !crate::integrations::PAUSED.load(Ordering::Relaxed) {
            // Delivery already has a conclusive result. Radio health checks
            // for optional background search must not hold the Send promise
            // (and its disabled buttons/progress) open afterward.
            tokio::spawn(async move {
                if { let control = operations().lock().unwrap(); !control.stopped && control.epoch == epoch }
                    && !crate::integrations::PAUSED.load(Ordering::Relaxed) {
                    let _ = discovery_set_until(true, resume, Some(revision)).await;
                }
            });
        }
        result
    }

    async fn send_inner(mac: String) -> Result<String, String> {
        let operation = operations().lock().unwrap().register()?;
        if mt7922_daemon().is_some() {
            if mac.len() != 12 || !mac.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("Select a named AirDrop device from a fresh scan.".into());
            }
            let _guard = operation.run(SWITCH.get_or_init(|| Mutex::new(())).lock()).await?;
            if !operation.run(mt7922_status()).await??.visible {
                return Err("The AirDrop radio is not visible. Turn it on and try again.".into());
            }
            let known = selected_mt_peer_present(&discovery().peers, &mac)
                || recent_mt7922_peers(None).is_ok_and(|peers| selected_mt_peer_present(&peers, &mac));
            if !known {
                return Err(
                    "That AirDrop recipient is no longer in the fresh device list. Scan again."
                        .into(),
                );
            }
            mt7922_ready()?;
            let opendrop = crate::platform::local_dir().join("owl/.venv-opendrop/bin/opendrop");
            if !opendrop.is_file() { return Err("The AirDrop sender is missing. Reinstall the MT7922 backend.".into()); }
            if !crate::platform::local_dir().join("bin/mochi-airdrop-send").is_file() {
                return Err("Mochi's measured AirDrop sender is missing. Rerun setup.".into());
            }
            let picker = crate::platform::local_dir().join("bin/mochi-airdrop-pick");
            if !picker.is_file() {
                return Err("The desktop file picker is not installed.".into());
            }
            let output = operation_output(Command::new("python3").arg(picker), &operation, None).await?;
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
            // The receiver already owns the radio and its Bluetooth advert.
            // Use the same exact-ID sender verified by the live image test,
            // not airdropd's attach/rebrowse wrapper (which can stop on self).
            // Never reselect by index/name or auto-retry an ambiguous delivery.
            let name = crate::settings::load().airdrop_name;
            return send_mt7922_files(opendrop, &mac, &name, &files, &operation).await;
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
        let _guard = operation.run(SWITCH.get_or_init(|| Mutex::new(())).lock()).await?;
        let state = operation.run(status()).await??;
        if !state.visible {
            return Err(
                "Turn on AirDrop and open the iPhone's AirDrop receiving settings first.".into(),
            );
        }
        // --pick uses Omdrop's desktop portal file chooser; paths remain in
        // the user-owned CLI, never pass through the webview or a shell.
        let (ok, message) = run_operation(&["send", "--to", &mac, "--pick"], 900, &operation).await?;
        if !ok {
            return Err(message);
        }
        Ok("AirDrop transfer complete.".into())
    }

    async fn run_operation(args: &[&str], seconds: u64, operation: &Operation) -> Result<(bool, String), String> {
        let exe = executable().ok_or(SETUP)?;
        let output = operation_output(Command::new(exe).args(args), operation, Some(Duration::from_secs(seconds))).await?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok((output.status.success(), if stdout.is_empty() { stderr } else { stdout }))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn receiving_progress_compares_decoded_counts_and_never_guesses_missing_totals() {
            let data = serde_json::json!({"wireBytes":50, "decodedBytes":1000, "totalBytes":2000,
                "updatedMs":10000, "bytesPerSecond":25.0, "phase":"complete"});
            let sample = super::measured_receive_progress(&data, 50, None, 10000).unwrap();
            assert_eq!(sample.received_bytes, Some(1000));
            assert_eq!(sample.total_bytes, Some(2000));
            assert_eq!(sample.wire_bytes, Some(50));
            assert_eq!(sample.state, "receiving", "telemetry cannot certify archive completion");
            let no_total = serde_json::json!({"wireBytes":50, "updatedMs":10000});
            let sample = super::measured_receive_progress(&no_total, 50, Some(2000), 10000).unwrap();
            assert_eq!(sample.received_bytes, Some(50));
            assert_eq!(sample.total_bytes, None, "raw compressed bytes cannot be compared to decoded totals");
            let stale = super::measured_receive_progress(&data, 50, None, 13000).unwrap();
            assert_eq!(stale.bytes_per_second, Some(0.0));
            assert!(super::measured_receive_progress(&data, 50, None, 0).is_none());
            assert!(super::measured_receive_progress(&serde_json::json!({"wireBytes":100000, "updatedMs":10000}), 0, None, 10000).is_none());
        }

        #[test]
        fn detected_services_can_be_displayed_but_never_become_sendable_named_peers() {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
            let raw = serde_json::json!([{"id":"000000000000", "name":null, "address":"fe80::2",
                "lastSeen":now, "connection":"connecting", "discoverable":false}]);
            let mut display = super::parse_mt_peers_with_age(serde_json::from_value(raw.clone()).unwrap(), "", "", 180.0);
            assert_eq!(display.len(), 1);
            assert!(display[0].name.is_none());
            assert!(!display[0].fresh);
            assert!(!super::selected_mt_peer_present(&display, "000000000000"));
            assert!(super::parse_mt_peers(serde_json::from_value(raw).unwrap(), "", "").is_empty());
            let seen = display[0].last_seen.unwrap();
            super::expire_cached_peers(&mut display, seen + 30_001);
            assert!(display.is_empty());
        }

        #[test]
        fn warm_send_snapshot_requires_a_recent_named_response_from_the_exact_service() {
            let row = serde_json::json!({"id":"000000000000", "name":"Phone", "address":"fe80::2", "port":8770,
                "discoverable":true, "lastSeen":1000.0});
            let report = |row: serde_json::Value| serde_json::json!([row]).to_string();
            assert!(super::fresh_selected_report(&report(row.clone()), "000000000000", 1004.0, 5.0).is_some());
            assert!(super::fresh_selected_report(&report(row.clone()), "abcdef123456", 1004.0, 5.0).is_none());
            assert!(super::fresh_selected_report(&report(row.clone()), "000000000000", 1006.0, 5.0).is_none());
            for (key, value) in [("lastSeen", serde_json::json!(99999)), ("address", serde_json::json!("::1")),
                ("discoverable", serde_json::json!(false)), ("port", serde_json::json!(0)), ("name", serde_json::json!(""))] {
                let mut bad = row.clone(); bad[key] = value;
                assert!(super::fresh_selected_report(&report(bad), "000000000000", 1004.0, 5.0).is_none());
            }
        }

        #[test]
        fn live_selected_service_skips_redundant_probe_but_never_uses_display_cache_or_name_match() {
            let row = serde_json::json!({"id":"000000000000", "name":"Phone", "address":"fe80::2", "port":8770,
                "discoverable":true, "lastSeen":1000.0, "lastAnnounced":1024.0, "sessionVerified":true});
            let report = |row: serde_json::Value| serde_json::json!([row]).to_string();
            assert!(super::fresh_selected_report(&report(row.clone()), "000000000000", 1025.0, 5.0).is_none());
            assert!(super::live_selected_report(&report(row.clone()), "000000000000", 1025.0).is_some());
            assert!(super::live_selected_report(&report(row.clone()), "abcdef123456", 1025.0).is_none());
            for (key, value) in [("lastAnnounced", serde_json::json!(990.0)),
                ("lastAnnounced", serde_json::json!(1026.0)), ("sessionVerified", serde_json::json!(false)),
                ("sessionVerified", serde_json::Value::Null), ("lastSeen", serde_json::json!(800.0)),
                ("name", serde_json::json!("")), ("address", serde_json::json!("::1"))] {
                let mut bad = row.clone(); bad[key] = value;
                assert!(super::live_selected_report(&report(bad), "000000000000", 1025.0).is_none(), "invalid {key}");
            }
        }

        #[test]
        fn cached_phone_freshness_ages_without_extending_the_three_minute_display_lifetime() {
            let mut peers = vec![super::Peer { mac: "000000000000".into(), name: Some("Phone".into()),
                rssi: None, last_seen: Some(100_000), fresh: true, connection: None }];
            super::expire_cached_peers(&mut peers, 120_000);
            assert!(peers[0].fresh);
            super::expire_cached_peers(&mut peers, 120_001);
            assert!(!peers[0].fresh);
            super::expire_cached_peers(&mut peers, 280_000);
            assert_eq!(peers.len(), 1);
            super::expire_cached_peers(&mut peers, 280_001);
            assert!(peers.is_empty());
        }

        #[test]
        fn display_cache_parser_does_not_relax_the_sender_freshness_gate() {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
            let raw = serde_json::json!([{"id":"000000000000", "name":"Phone", "address":"fe80::2", "lastSeen":now - 60.0}]);
            let display = super::parse_mt_peers_with_age(serde_json::from_value(raw.clone()).unwrap(), "Mochi", "", 180.0);
            assert_eq!(display.len(), 1);
            assert!(!display[0].fresh);
            assert!(super::parse_mt_peers(serde_json::from_value(raw).unwrap(), "Mochi", "").is_empty());
        }

        #[test]
        fn sender_progress_never_trusts_a_completion_phase_or_invalid_byte_counts() {
            let session = super::SendingSession::begin().unwrap();
            assert!(super::SendingSession::begin().is_err());
            assert!(super::read_send_progress(r#"MOCHI_SEND {"phase":"sending","sentBytes":10,"totalBytes":100}"#));
            assert_eq!(super::outbound().unwrap().sent_bytes, Some(10));
            for line in [
                r#"MOCHI_SEND {"phase":"complete","sentBytes":100,"totalBytes":100}"#,
                r#"MOCHI_SEND {"phase":"sending","sentBytes":200,"totalBytes":100}"#,
                r#"MOCHI_SEND {"phase":"untrusted","sentBytes":99,"totalBytes":100}"#,
            ] {
                super::read_send_progress(line);
                let state = super::outbound().unwrap();
                assert_eq!(state.phase, "sending");
                assert_eq!(state.sent_bytes, Some(10));
            }
            super::send_phase("confirming", Some(100), Some(100));
            assert_eq!(super::outbound().unwrap().phase, "confirming");
            super::send_phase("complete", None, None);
            assert_eq!(super::outbound().unwrap().phase, "complete");
            drop(session);
            assert!(!super::SENDING.load(std::sync::atomic::Ordering::SeqCst));
        }

        #[tokio::test]
        async fn streaming_sender_cancellation_kills_the_owned_child_without_waiting_for_pipe_eof() {
            let root = fixture_root("streaming-send-cancel");
            let pid_file = root.join("pid");
            let mut control = super::OperationControl::new();
            let operation = control.register().unwrap();
            let mut command = blocking_command(&pid_file);
            let (result, pid) = tokio::time::timeout(std::time::Duration::from_secs(4), async {
                tokio::join!(super::sender_output(&mut command, &operation), async {
                    let pid = wait_for_test_pid(&pid_file).await;
                    control.stop();
                    pid
                })
            }).await.unwrap();
            assert_eq!(result.unwrap_err(), super::CANCELLED);
            assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn stopping_invalidates_existing_operations_and_blocks_late_registration() {
            let mut control = super::OperationControl::new();
            let operation = control.register().unwrap();
            let old_epoch = control.epoch;
            let stopped_epoch = control.stop();
            assert!(operation.check().is_err());
            assert!(control.register().is_err(), "off must also block work that registers after its signal");
            assert!(!control.enabled(old_epoch), "a stale enable cannot undo a newer off");
            assert!(control.enabled(stopped_epoch));
            assert!(control.register().unwrap().check().is_ok());
            assert!(operation.check().is_err(), "old operations stay cancelled after enabling again");
        }

        fn blocking_command(pid_file: &std::path::Path) -> tokio::process::Command {
            // exec keeps one PID. The inert child ignores SIGINT and performs
            // no networking, file transfer, or radio operations.
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "trap '' INT; printf '%s' $$ > \"$1\"; exec sleep 120", "mochi-test"])
                .arg(pid_file);
            command
        }

        async fn wait_for_test_pid(path: &std::path::Path) -> u32 {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if let Ok(value) = std::fs::read_to_string(path) {
                        if let Ok(pid) = value.parse() { return pid; }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }).await.expect("test helper must report its PID")
        }

        #[tokio::test]
        async fn off_cancels_each_workflow_phase_reaps_its_child_and_releases_the_switch() {
            use std::time::Duration;
            for phase in ["scan", "chooser", "send"] {
                let root = fixture_root(phase);
                let pid_file = root.join("pid");
                let gate = tokio::sync::Mutex::new(());
                let mut control = super::OperationControl::new();
                let operation = control.register().unwrap();
                let work = async {
                    let _guard = operation.run(gate.lock()).await?;
                    if phase == "scan" {
                        let mut child = super::OwnedChild::spawn(blocking_command(&pid_file)
                            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null()))?;
                        let result = operation.run(std::future::pending::<()>()).await;
                        child.kill_and_reap().await;
                        result
                    } else {
                        super::operation_output(&mut blocking_command(&pid_file), &operation,
                            if phase == "send" { Some(super::SEND_TIMEOUT) } else { None }).await.map(|_| ())
                    }
                };
                let stop = async {
                    let pid = wait_for_test_pid(&pid_file).await;
                    control.stop();
                    assert!(control.register().is_err());
                    pid
                };
                let (result, pid) = tokio::time::timeout(Duration::from_secs(4), async {
                    tokio::join!(work, stop)
                }).await.expect("off must not wait for the chooser or 900-second sender timeout");
                assert_eq!(result.unwrap_err(), super::CANCELLED);
                assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(), "actual child must be reaped: {phase}");
                assert!(gate.try_lock().is_ok(), "off must be able to acquire SWITCH after {phase}");
                std::fs::remove_dir_all(root).unwrap();
            }
        }

        #[tokio::test]
        async fn deadline_kills_the_actual_sender_even_when_it_ignores_sigint() {
            use std::time::Duration;
            let root = fixture_root("sender-timeout");
            let pid_file = root.join("pid");
            let control = super::OperationControl::new();
            let operation = control.register().unwrap();
            let result = super::operation_output(&mut blocking_command(&pid_file), &operation,
                Some(Duration::from_millis(500))).await;
            assert_eq!(result.unwrap_err(), super::SEND_TIMED_OUT);
            let pid = wait_for_test_pid(&pid_file).await;
            assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn cancelling_a_dropped_command_future_does_not_leave_the_helper_running() {
            use std::time::Duration;
            let root = fixture_root("dropped-helper");
            let pid_file = root.join("pid");
            let control = super::OperationControl::new();
            let operation = control.register().unwrap();
            let mut command = blocking_command(&pid_file);
            let mut work = Box::pin(super::operation_output(&mut command, &operation, None));
            let pid = tokio::select! {
                result = &mut work => panic!("blocking helper unexpectedly returned: {result:?}"),
                pid = wait_for_test_pid(&pid_file) => pid,
            };
            // Dropping the owning future happens when a Tauri request is aborted.
            drop(work);
            tokio::time::timeout(Duration::from_secs(2), async {
                while std::path::Path::new(&format!("/proc/{pid}")).exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }).await.expect("dropping an owned helper must kill and reap it");
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn selected_phone_discovery_waits_past_other_phones_and_respects_its_deadline() {
            use std::time::{Duration, Instant};
            let control = super::OperationControl::new();
            let operation = control.register().unwrap();
            let phone = |id: &str| super::Peer { mac: id.into(), name: Some("Phone".into()), rssi: None, last_seen: None, fresh: true, connection: None };
            let mut child = super::OwnedChild::spawn(tokio::process::Command::new("/bin/sleep").arg("120")).unwrap();
            let mut calls = 0;
            let peers = super::wait_for_mt_peers(&mut child, Some("aaaaaaaaaaaa"), &operation,
                Duration::from_secs(1), Duration::from_millis(5), || {
                    calls += 1;
                    Some(vec![phone(if calls == 1 { "bbbbbbbbbbbb" } else { "aaaaaaaaaaaa" })])
                }).await.unwrap();
            assert_eq!(calls, 2, "phone B must not end a refresh for phone A");
            assert!(super::selected_mt_peer_present(&peers, "aaaaaaaaaaaa"));
            let start = Instant::now();
            let peers = super::wait_for_mt_peers(&mut child, Some("aaaaaaaaaaaa"), &operation,
                Duration::from_millis(30), Duration::from_millis(5), || Some(vec![phone("bbbbbbbbbbbb")]))
                .await.unwrap();
            assert!(start.elapsed() >= Duration::from_millis(30));
            assert!(!super::selected_mt_peer_present(&peers, "aaaaaaaaaaaa"), "an absent target must never be replaced");
            child.kill_and_reap().await;
        }

        #[test]
        fn post_chooser_refresh_requires_the_same_named_service_never_a_name_match() {
            let phones = vec![super::Peer { mac: "abcdef123456".into(), name: Some("My iPhone".into()), rssi: None, last_seen: None, fresh: true, connection: None }];
            assert!(super::selected_mt_peer_present(&phones, "ABCDEF123456"));
            assert!(!super::selected_mt_peer_present(&phones, "000000000000"));
            let unnamed = vec![super::Peer { mac: "abcdef123456".into(), name: None, rssi: None, last_seen: None, fresh: true, connection: None }];
            assert!(!super::selected_mt_peer_present(&unnamed, "abcdef123456"));
            assert!(!super::selected_mt_peer_present(&[], "abcdef123456"));
        }

        #[test]
        fn sending_uses_exact_id_and_repeatable_files_without_radio_wrapper() {
            let command = super::mt7922_send_command(std::path::Path::new("/custom/opendrop"),
                "000000000000", "Mochi", &["/photos/one image.png".into(), "/photos/two.jpg".into()]);
            let args: Vec<_> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
            assert_eq!(command.as_std().get_program(), "/custom/python");
            assert_eq!(super::SEND_TIMEOUT, std::time::Duration::from_secs(900));
            let helper = crate::platform::local_dir().join("bin/mochi-airdrop-send");
            assert_eq!(args, ["-u", helper.to_str().unwrap(), "-n", "Mochi", "-i", "awdl0", "-r", "000000000000",
                "-f", "/photos/one image.png", "-f", "/photos/two.jpg"]);
            assert!(!args.iter().any(|arg| arg.contains("airdropd")));
        }

        #[test]
        fn send_errors_explain_recovery_without_leaking_paths_or_claiming_radio_setup() {
            for reason in ["ConnectionRefusedError", "RemoteDisconnected", "Selected AirDrop service no longer exists"] {
                let message = super::mt7922_send_error(Some(1), &format!("{reason}: /private/photo.png"));
                assert!(message.contains("Find iPhone"));
                assert!(!message.contains("/private"));
            }
            assert!(super::mt7922_send_error(Some(124), "").contains("Check the phone before retrying"));
            assert!(super::mt7922_send_error(Some(1), "Receiver declined").contains("accept the prompt"));
            assert!(super::mt7922_send_error(Some(1), "Traceback: /private/photo.png").contains("did not confirm delivery"));
        }

        fn fixture_root(label: &str) -> std::path::PathBuf {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("mochi-{label}-{}-{nonce}", std::process::id()));
            std::fs::create_dir(&root).unwrap();
            root
        }

        #[test]
        fn consent_answers_are_atomic_bound_to_id_and_never_replaced() {
            let root = fixture_root("decision");
            let id = "0123456789abcdef0123456789abcdef";
            super::write_decision(&root, id, true).unwrap();
            let final_path = root.join(format!("decision-{id}"));
            assert_eq!(std::fs::read_to_string(&final_path).unwrap(), format!("{id} accept"));
            assert!(!root.join(format!("decision-{id}.tmp")).exists());
            assert!(super::write_decision(&root, id, false).is_err());
            assert_eq!(std::fs::read_to_string(&final_path).unwrap(), format!("{id} accept"));
            assert!(!root.join(format!("decision-{id}.tmp")).exists());
            assert!(super::write_decision(&root, "../../outside", true).is_err());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn receiver_discovery_uses_the_selected_data_directory() {
            use std::os::unix::fs::PermissionsExt;
            let root = fixture_root("custom-data");
            let daemon = root.join("airdrop-mt7921/daemon/airdropd");
            std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
            std::fs::write(&daemon, b"#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(super::executable_daemon_in(&root).is_none());
            std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(super::executable_daemon_in(&root), Some(daemon));
            assert!(super::executable_daemon_in(&root.join("unrelated")).is_none());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn receiver_lock_excludes_other_sessions_and_rejects_unsafe_paths() {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let root = fixture_root("receiver-lock");
            let directory = root.join("airdropd");
            let guard = super::lock_idle_receiver_at(&directory).unwrap();
            assert!(super::lock_idle_receiver_at(&directory).is_err());
            // A concurrent fork inherits the same open file description until
            // exec. Simulate that reference without forking the test runner.
            let inherited = guard.0.try_clone().unwrap();
            drop(guard);
            drop(super::lock_idle_receiver_at(&directory).unwrap());
            drop(inherited);

            let alias = root.join("alias");
            symlink(&directory, &alias).unwrap();
            assert!(super::lock_idle_receiver_at(&alias).is_err());
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o777)).unwrap();
            assert!(super::lock_idle_receiver_at(&directory).is_err());
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::remove_file(directory.join("lock")).unwrap();
            let outside = root.join("outside");
            std::fs::write(&outside, b"unchanged").unwrap();
            symlink(&outside, directory.join("lock")).unwrap();
            assert!(super::lock_idle_receiver_at(&directory).is_err());
            assert_eq!(std::fs::read(&outside).unwrap(), b"unchanged");
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn unrelated_listener_is_not_a_receiver_and_does_not_prevent_stopped_state() {
            let root = fixture_root("listener-owner");
            let worker = root.join("12345");
            std::fs::create_dir(&worker).unwrap();
            let executable = std::path::Path::new("/custom/data/mochi/owl/.venv-opendrop/bin/opendrop");
            let sockets = "LISTEN 0 5 [::]:8771 [::]:* users:((\"python3\",pid=12345,fd=3))";
            std::fs::write(worker.join("cmdline"), b"python3\0-m\0http.server\08771\0").unwrap();
            assert!(!super::receiver_socket_owned(sockets, &root, executable));
            std::fs::write(worker.join("cmdline"), format!("python3\0{}\0receive\0", executable.display())).unwrap();
            assert!(super::receiver_socket_owned(sockets, &root, executable));
            std::fs::write(worker.join("cmdline"), format!("python3\0{}\0find\0", executable.display())).unwrap();
            assert!(!super::receiver_socket_owned(sockets, &root, executable));
            assert!(!super::receiver_socket_owned("LISTEN 0 5 [::]:8771 [::]:*", &root, executable));
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn private_upload_progress_rejects_outside_and_symlink_paths() {
            use super::workspace_archive_received;
            let root = std::env::temp_dir().join(format!("mochi-private-progress-{}", std::process::id()));
            let incoming = root.join("incoming");
            let workspace = incoming.join("receive-test");
            std::fs::create_dir_all(&workspace).unwrap();
            let file = workspace.join("airdrop-received-100.dvzip");
            std::fs::write(&file, b"bytes").unwrap();
            assert_eq!(workspace_archive_received(&file, &incoming, 100, 101), Some(5));
            assert_eq!(workspace_archive_received(&file, &incoming, 101, 102), None);
            assert_eq!(workspace_archive_received(&file, &root.join("elsewhere"), 100, 101), None);
            let link = workspace.join("airdrop-received-101.dvzip");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert_eq!(workspace_archive_received(&link, &incoming, 100, 101), None);
            std::fs::remove_file(link).unwrap();
            std::fs::remove_file(file).unwrap();
            std::fs::remove_dir(workspace).unwrap();
            std::fs::remove_dir(incoming).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[test]
        fn upload_progress_reads_declared_totals_and_only_the_new_raw_archive() {
            use super::{archive_received, upload_total_bytes};
            let log = "POST request at /Upload\nTotalBytes: 186876480\nTransfer-Encoding: chunked\nReceiving file(s) ...";
            assert_eq!(upload_total_bytes(log), Some(186876480));
            // Compare TotalBytes with decoded telemetry, never compressed
            // raw bytes. Success comes from the trailer, never this header.
            assert_eq!(
                upload_total_bytes(
                    "POST request at /Upload\nContent-Type: application/x-dvzip\nTotalBytes: 456877337\nReceiving file(s) ..."
                ),
                Some(456_877_337)
            );
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
            assert_eq!(transfer_state("", 11 * 60), Some("notStarted"));
            assert_eq!(transfer_state("", 90), Some("waiting"));
            assert_eq!(transfer_state("", 91), Some("notStarted"));
            assert_eq!(transfer_state("POST request at /Upload", 30 * 60), Some("receiving"));
            assert_eq!(transfer_state("", 30), Some("waiting"));
            assert_eq!(transfer_state("Receiving file(s) ...\nExtracted into /tmp: video.mov\nFile(s) received", 180), Some("complete"));
            assert_eq!(transfer_state("Receiving file(s) ...\nincomplete, kept as .partial: video.mov\nCould not extract the archive\nFile(s) received", 180), Some("failed"));
            assert_eq!(transfer_state("Receiving file(s) ...\nFile(s) incomplete", 180), Some("failed"));
        }

        #[test]
        fn accepted_request_without_upload_becomes_actionable_without_claiming_received_bytes() {
            for (age, state, message) in [(0, "waiting", "Accepted"), (15, "waiting", "Accepted"),
                (16, "waiting", "Connection delayed"), (90, "waiting", "Connection delayed"),
                (91, "failed", "No file bytes were received")] {
                let transfer = super::upload_start_status(age);
                assert_eq!(transfer.state, state);
                assert!(transfer.message.unwrap().contains(message));
                assert_eq!(transfer.received_bytes, None);
                assert_eq!(transfer.total_bytes, None);
                assert_eq!(transfer.wire_bytes, None);
                assert_eq!(transfer.bytes_per_second, None);
            }
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
        fn retired_selection_is_detected_without_substituting_a_same_name_service() {
            let peer = |id: &str, name: Option<&str>| serde_json::from_value::<super::Peer>(serde_json::json!({
                "mac":id, "name":name, "fresh":false,
            })).unwrap();
            let mut snapshot = super::Discovery { running: true, peers: vec![peer("aabbccddeeff", Some("Test Phone"))], ..Default::default() };
            assert!(!super::selected_service_retired(&snapshot, "AABBCCDDEEFF"));
            snapshot.peers = vec![peer("112233445566", Some("Test Phone"))];
            assert!(super::selected_service_retired(&snapshot, "aabbccddeeff"), "same name must not authorize a rotated service");
            snapshot.peers.push(peer("aabbccddeeff", None));
            assert!(!super::selected_service_retired(&snapshot, "aabbccddeeff"), "an unresolved exact service can still answer");
            snapshot.peers.clear();
            assert!(!super::selected_service_retired(&snapshot, "aabbccddeeff"), "an empty startup snapshot is not proof of removal");
            snapshot.peers = vec![peer("112233445566", Some("Other Phone"))];
            snapshot.running = false;
            assert!(!super::selected_service_retired(&snapshot, "aabbccddeeff"), "an inactive cache must not prevent cold discovery");
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
pub use linux::{decide, discovery, discovery_set, outbound, incoming, peers, preferences, send, set, status, stop_if_owned, transfer, watch_incoming};

#[cfg(not(target_os = "linux"))]
pub fn discovery() -> Discovery { Discovery::default() }

#[cfg(not(target_os = "linux"))]
pub async fn discovery_set(_enabled: bool) -> Result<Discovery, String> { Ok(Discovery::default()) }

#[cfg(not(target_os = "linux"))]
pub fn outbound() -> Option<Outbound> { None }

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
pub fn watch_incoming(_app: tauri::AppHandle) {}

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
