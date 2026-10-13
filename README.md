# Mochi

A small desktop companion that lives at the top edge of your screen. Mochi brings agent activity, media controls, system status, time and weather into one capsule that opens when you need it and stays out of the way when you do not.

![Mochi opening from its compact capsule on Linux](docs/media/mochi-demo.gif)

*Live capture from the Linux app. [Watch the short MP4 demo](docs/media/mochi-demo.mp4). The main setup path below builds Mochi locally; this repository also contains Windows and Apple-platform source.*

## What Mochi does

- **Agent activity and chat:** follow supported coding-agent sessions, respond to prompts, and chat through your existing OpenCode installation. Setup installs the OpenCode hook and starts its local service; it does not install Llama.
- **Media:** play, pause, skip, and select players exposed through Linux MPRIS. A browser or page must publish a controllable media session for these buttons to work.
- **System and power:** view process and network snapshots, see battery charge and charging state, and use the optional Awake control to inhibit screen-idle blanking on supported Linux desktops.
- **Clock and weather:** show local 12-hour time and, if you opt in, live conditions and subtle weather animation behind the Clock card.
- **A little personality:** Mochi reacts to music, charging changes, low battery, and the time of day. Reminders and animations stay inside the expanded capsule.

The four small companion pills are configurable in Settings. The capsule retracts after inactivity and reopens from the top-edge hover area.

### From the desktop

| Overview | Wardrobe |
| --- | --- |
| ![Mochi overview with companion pills](docs/media/mochi-overview.png) | ![Mochi wardrobe with optional outfits](docs/media/mochi-wardrobe.png) |

*These are captures from a running Linux session. Other platforms and desktop themes may look different.*

## Install on Linux

The setup script supports Arch-family, Debian/Ubuntu-family, Fedora-family, and openSUSE-family desktops with the required WebKitGTK 4.1 packages. It targets x86_64 and aarch64; immutable/OSTree hosts and distributions without the required packages need a manual setup. Run it as your desktop user, not with `sudo`. It asks for `sudo` only when system packages are missing.

```bash
git clone https://github.com/Spydomain/Mochi.git
cd Mochi
./mochi-full-setup.sh --check   # inspect dependencies without changing anything
./mochi-full-setup.sh           # install, build, configure, and launch
```

Setup installs the required distro packages, Node.js 24 LTS locally if the existing Node is unsuitable, Rust, OpenCode v2 if needed, the app, and its hook. It runs the frontend tests before installing the release build. The first run downloads dependencies and can take several minutes. Review the script and its upstream installers before running it.

On Niri, setup enables a user `systemd` service for graphical login. On other desktops it writes an XDG autostart entry. It also configures a daily timer—or a login-time fallback without user `systemd`—to remove **Mochi chat sessions** older than 30 days without deleting other OpenCode work. Setup keeps your local Git checkout and existing preferences, while setting autostart, hover opening, English, and OpenCode as its defaults. It does not reset or pull the repository. Use `./mochi-full-setup.sh --no-launch` if you want to install without starting the app immediately.

### Update

```bash
./update-mochi.sh
```

The updater checks this repository's default branch. It leaves an up-to-date installation unchanged, fast-forwards a clean checkout when a new commit exists, and rebuilds through the same setup script. If a previous installation stopped partway through, it retries setup. It refuses to overwrite local edits or merge divergent histories; commit or stash your changes first.

### Check the running app

```bash
systemctl --user status mochi-app.service
journalctl --user -u mochi-app.service -n 100 --no-pager
opencode service status
```

On non-Niri desktops, check `~/.config/autostart/mochi.desktop` instead of the Mochi service. Settings live at `~/.config/mochi/settings.json`, local logs at `~/.local/share/mochi/mochi.log`, and installed binaries under `~/.local/share/mochi/bin/`.

## Weather and location

Weather is optional. **Find city** saves the city you choose. **Locate me** requests a fresh device fix on every app start and daily while Mochi runs; if location services are late after login, it retries after 2 minutes and then 10 minutes later. Mochi accepts only fixes reported within 5 km. A coarse GeoClue/IP-level result is not presented as your exact city: your last saved city remains in use until a better fix arrives. If your device cannot provide one, use Find city.

With live weather enabled, Mochi sends the selected coordinates to Open-Meteo for a forecast at most every 15 minutes. An accepted device fix is sent to OpenStreetMap Nominatim to obtain a city name; if naming fails, its coordinates can still provide weather. Older IP-only preferences remain separate and use ipwho.is. Offline night-sky animation uses local time without a weather request.

## Media and troubleshooting

Linux media controls use the player's MPRIS interface. Mochi sends previous/next commands even when a player reports stale capability flags, but the player or page may still ignore them. To see what your desktop exposes:

```bash
playerctl -l
playerctl metadata
```

| Symptom | First check |
| --- | --- |
| The capsule does not reopen | Move the pointer to the top-center edge; then inspect the app service or local log. |
| Media controls do nothing | Start eligible media and confirm the browser or app appears in `playerctl -l`. |
| Locate me names no new city | Check desktop location permission and GeoClue accuracy; use Find city if the only fix is coarse. |
| Chat reports a local connection error | Check `opencode service status`, then try `opencode service start`. |

## Privacy and scope

Mochi's Linux agent hook uses a private same-user Unix socket, not a public Internet listener. Its settings and logs are local, but they may contain session names or other sensitive context. OpenCode uses your configured agent, model provider, plugins, and permissions; a prompt asking it not to use tools is not a security boundary. Optional integrations and live weather contact their respective services only when enabled. Review those services before using Mochi with sensitive work.

The Linux installer is the supported path documented here. The shared Tauri client has a separate [Windows/development guide](windows/README.md); the repository also contains macOS/iOS source and an [optional Apple Live Activity relay](relay/README.md). This README does not claim that prebuilt packages are published for every platform.

## Development

```bash
cd windows
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

**Mochi is a modified version of [Coucou](https://github.com/Louis-CFM/coucou). Special thanks to [Louis-CFM](https://github.com/Louis-CFM) and the Coucou project for the original foundation.**

Questions or project contact: [contactme@bikashkumarsarraf.com.np](mailto:contactme@bikashkumarsarraf.com.np).
