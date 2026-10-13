// A session-only screen-idle inhibitor. The private D-Bus connection owns the
// request, so even an unexpected Mochi exit returns control to the desktop.

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    use dbus::arg::{RefArg, Variant};
    use dbus::blocking::SyncConnection;

    const SCREENSAVER: &str = "org.freedesktop.ScreenSaver";
    const SCREENSAVER_PATH: &str = "/org/freedesktop/ScreenSaver";
    const PORTAL: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const TIMEOUT: Duration = Duration::from_secs(3);

    struct Inhibitor {
        connection: SyncConnection,
        kind: Inhibition,
    }

    enum Inhibition {
        ScreenSaver(u32),
        Portal(dbus::Path<'static>),
    }

    static INHIBITOR: Mutex<Option<Inhibitor>> = Mutex::new(None);

    pub fn active() -> bool {
        INHIBITOR.lock().is_ok_and(|guard| guard.is_some())
    }

    pub fn set(enabled: bool) -> Result<bool, String> {
        let mut guard = INHIBITOR
            .lock()
            .map_err(|_| "Keep-awake state is unavailable.".to_string())?;
        if enabled && guard.is_none() {
            let connection = SyncConnection::new_session()
                .map_err(|err| format!("Cannot reach the desktop session bus: {err}"))?;
            let proxy = connection.with_proxy(SCREENSAVER, SCREENSAVER_PATH, TIMEOUT);
            let kind = match proxy.method_call::<(u32,), _, _, _>(
                SCREENSAVER,
                "Inhibit",
                ("Mochi", "Keep screen awake"),
            ) {
                Ok((cookie,)) => Inhibition::ScreenSaver(cookie),
                Err(screen_error) => {
                    // GNOME and some other desktops expose idle inhibition via
                    // the desktop portal instead of ScreenSaver. An empty window
                    // identifier is allowed by the portal specification.
                    let mut options: HashMap<String, Variant<Box<dyn RefArg>>> = HashMap::new();
                    options.insert(
                        "reason".into(),
                        Variant(Box::new(String::from("Keep screen awake"))),
                    );
                    let proxy = connection.with_proxy(PORTAL, PORTAL_PATH, TIMEOUT);
                    let (handle,): (dbus::Path<'static>,) = proxy
                        .method_call("org.freedesktop.portal.Inhibit", "Inhibit", ("", 8u32, options))
                        .map_err(|portal_error| format!(
                            "This desktop cannot inhibit screen idle (ScreenSaver: {screen_error}; portal: {portal_error})."
                        ))?;
                    Inhibition::Portal(handle)
                }
            };
            *guard = Some(Inhibitor { connection, kind });
        } else if !enabled {
            if let Some(inhibitor) = guard.take() {
                // Dropping the private connection also releases its request if
                // the desktop has restarted and no longer knows this cookie.
                match inhibitor.kind {
                    Inhibition::ScreenSaver(cookie) => {
                        let proxy = inhibitor.connection.with_proxy(SCREENSAVER, SCREENSAVER_PATH, TIMEOUT);
                        let _: Result<(), _> = proxy.method_call(SCREENSAVER, "UnInhibit", (cookie,));
                    }
                    Inhibition::Portal(handle) => {
                        let proxy = inhibitor.connection.with_proxy(PORTAL, handle, TIMEOUT);
                        let _: Result<(), _> = proxy.method_call("org.freedesktop.portal.Request", "Close", ());
                    }
                }
            }
        }
        Ok(guard.is_some())
    }
}

#[cfg(target_os = "linux")]
pub use linux::{active, set};

#[cfg(not(target_os = "linux"))]
pub fn active() -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
pub fn set(_enabled: bool) -> Result<bool, String> {
    Err("Keep awake is not available on this platform.".into())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{active, set};

    #[test]
    #[ignore = "requires a desktop session with org.freedesktop.ScreenSaver"]
    fn session_inhibition_round_trip() {
        assert!(!active());
        assert!(set(true).expect("desktop should accept Inhibit"));
        assert!(active());
        assert!(!set(false).expect("UnInhibit should restore idle policy"));
        assert!(!active());
    }
}
