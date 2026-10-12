# Mochi desktop companion

This repository contains a personal Linux setup of Mochi, with a top-edge capsule, Mochi animations, media controls, and OpenCode chat. The code also contains macOS, iOS and Windows projects; this guide covers the Linux setup script and does not claim to publish installers for those platforms.

**Mochi is a modified version of [Coucou](https://github.com/Louis-CFM/coucou), adapted and extended for this project.**

**Special thanks to [Louis-CFM](https://github.com/Louis-CFM) and the Coucou project for the original foundation.**

The capsule opens on hover. It shows media and agent activity, plays charging/unplugging and low-battery reactions, and gives occasional time-of-day and long-use reminders. Reminders stay inside the expanded capsule. OpenCode is the configured chat provider; no Llama installation is needed.

The Clock card shows a subtle moon and stars at night without a network request. For live rain, snow, and today's forecast, open **Settings → Weather background** and choose **Locate me** or **Find city**. **Locate me** saves an opt-in mode: Mochi tries device positioning when it starts after login and once daily while running. If the OS cannot provide a position, it checks an approximate public-IP location through [ipwho.is](https://ipwhois.io/documentation) over HTTPS (which sees your public IP). IP location can be wrong with a VPN. Existing IP-only preferences remain IP-only until you explicitly choose **Locate me**. **Find city** saves a fixed custom location without a device or IP lookup. On Linux the setup script installs GeoClue for device positioning, but the desktop must also allow location access. Mochi uses [Open-Meteo](https://open-meteo.com/en/docs) for current conditions and today's high/low; the selected coordinates are stored in your private settings file and sent to Open-Meteo at most every 15 minutes while weather is enabled. Automatic checks pause when Mochi is paused. If a check fails, Mochi keeps the last known location and retries later.

To show the local clock, enable **Clock** under Settings → Active pills. Clock uses one of the four companion slots, so turn off an existing pill first if all four are occupied. Its small pill and compact 2×2 slot show a Mochi like the others; selecting it shows 12-hour AM/PM time in the large card. The compact capsule retracts shortly after you leave it; the browser tabs beneath it remain clickable.

## Linux setup

Supported package managers: `pacman` (Arch-based) or `apt-get` (Debian/Ubuntu-based), on x86_64 or aarch64 Linux with a systemd user session. Run setup as your desktop user; it requests `sudo` only to install missing system packages. The script installs build dependencies, Rust, OpenCode v2 if needed, the Tauri app, its OpenCode hook, a 30-day **Mochi chat session** cleanup timer, and autostart. If the distro's Node.js is too old, it downloads a checksum-verified Node.js 24 LTS into `~/.local/share/mochi/toolchain/` for the build. It preserves an existing checkout and existing valid settings rather than resetting Git history.

```bash
git clone https://github.com/Spydomain/Mochi.git mochi
cd mochi
./mochi-full-setup.sh --check      # inspect missing system packages; no changes
./mochi-full-setup.sh              # install, build, configure, and launch
```

The first build can take a while and downloads dependencies from the distribution package manager, npm, Rust, and (if missing) OpenCode's official installer. Review this repository and those sources before running a setup script. Running the script again rebuilds and restarts the app without a `git reset` or pull. `--no-launch` installs everything without starting Mochi immediately.

On Niri, the installer enables `mochi-app.service` for the graphical session. On other Linux desktops it writes an XDG autostart entry. It moves duplicate autostart entries to `~/.config/mochi/autostart-backups/` to prevent extra launches after a reboot. When upgrading from the previous local name, it copies existing settings, retires the previous generated OpenCode plugin, and disables the previous service. Settings are stored at `~/.config/mochi/settings.json` (mode `0600`); the app and hook are built in `windows/target/release/` and installed to stable paths under `~/.local/share/mochi/bin/`. OpenCode must be installed and available for chat; the installer checks that its v2 service starts. Reinstall any other agent hooks from Mochi's settings after upgrading, because their old relay paths are not rewritten automatically.

To inspect the running app on Niri:

```bash
systemctl --user status mochi-app.service
journalctl --user -u mochi-app.service -n 100 --no-pager
systemctl --user status mochi-opencode-cleanup.timer
```

For other desktops, check the autostart entry in `~/.config/autostart/mochi.desktop` and Mochi's log in `~/.local/share/mochi/mochi.log`. Move the pointer to the top-center edge of the screen to open the capsule; select a media player for play/pause, previous and next. If a player does not support a command, its own media service may not expose it.

On Linux, Media works with any browser or app that publishes an MPRIS player on the session bus, including Brave and Firefox when they have eligible audio/video playing. Mochi follows the playing player automatically, or keeps the one you choose in the Media card selected. Next/previous are always sent to the player, even if it reports stale capability flags; a player that does not support a command may ignore it. A browser or page that does not expose media through MPRIS cannot be controlled through this integration; for example, Firefox does not expose Web Audio or notification sounds as controllable media. Check what the desktop can see with `playerctl -l` and `playerctl metadata`.

## Privacy and security

Mochi's local agent hook uses a private same-user Unix socket on Linux, rather than an Internet listener. Mochi chat automatically starts the installed OpenCode service and uses your existing OpenCode agent and permissions. OpenCode may use tools, read files, or contact configured model providers and plugins under those permissions; a prompt asking it not to use tools is not an enforcement boundary. Review your OpenCode configuration before chatting about sensitive data. Enabling an optional service integration sends its requests to that service. Leave integrations disabled when they are not needed, and use HTTPS for remote n8n endpoints. Logs and settings are local; do not share them if they include project names, session text, or tokens. The app cannot guarantee privacy of an external OpenCode provider or third-party integration.

## Other platforms and development

The Windows/Linux Tauri source is in [`windows/`](windows/README.md). From `windows/`, use `npm ci`, `npm test`, and `npm run build` for frontend development; Rust tests run with `cargo test` in `windows/src-tauri/`. macOS and iOS source is under `NotchBuddy/`.
