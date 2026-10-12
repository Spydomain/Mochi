fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") && tauri_build::is_dev() {
        panic!("Mochi release builds must use `tauri build --no-bundle` so the UI is embedded; plain `cargo build --release` points at the development localhost server");
    }
    // Tauri embeds the Vite output. Rebuild when only the frontend changes,
    // or a restarted service will show stale UI.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
