# Mochi on Windows

Mochi is a Dynamic Island-style desktop companion for coding-agent activity, chat, media, shortcuts, and system status. This directory contains its shared TypeScript interface and Tauri/Rust desktop application. The [main guide](../README.md) covers the automated Linux installation; Windows is built from source here.

![Mochi's shared interface running on Linux](../docs/media/mochi-overview.png)

*The screenshot shows the shared interface on Linux. Window behavior and available integrations can differ on Windows.*

## Screenshots and video

| Overview | Compact island | Settings |
| --- | --- | --- |
| ![Windows overview reference](screenshots/overview.png) | ![Windows compact island reference](screenshots/compact.png) | ![Windows settings reference](screenshots/settings.png) |

These Windows captures are interface references, not screenshots of the latest Linux AirDrop implementation. For current Linux UI captures see the [overview](../docs/media/mochi-overview.png), [wardrobe](../docs/media/mochi-wardrobe.png), [animated demo](../docs/media/mochi-demo.gif), and [short MP4 video](../docs/media/mochi-demo.mp4).

## Requirements

- Windows 10 or 11 with Microsoft Edge WebView2 Runtime.
- Node.js 20 or newer and npm.
- Rust and Cargo installed through [rustup](https://rustup.rs/).
- Visual Studio Build Tools with the **Desktop development with C++** workload and a compatible Windows SDK.

Install Git if it is not already available. Run the commands below in PowerShell as your normal user. A source build downloads npm and Cargo dependencies and needs Internet access on its first run.

## Get started

```powershell
git clone https://github.com/Spydomain/Mochi.git
cd Mochi\windows
npm ci
npm run tauri dev
```

`npm run tauri dev` builds the hook and launches the development app. If the Rust toolchain or C++ workload is missing, resolve that prerequisite before retrying.

## Test and package

From the `windows` directory:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run pack
```

`npm run pack` builds release bundles and copies the Windows installers to `windows\release\`. Tauri's raw release artifacts remain under `windows\target\release\`. Packaging availability depends on the Windows build environment; inspect the command's output for the actual installer paths.

## Configuration and local data

| Item | Path |
| --- | --- |
| Preferences and custom sounds | `%APPDATA%\Mochi` |
| Logs, inbox, and helper binaries | `%LOCALAPPDATA%\Mochi` |
| App log | `%LOCALAPPDATA%\Mochi\mochi.log` |

OpenCode and other coding-agent integrations use their own installed binaries and credentials. Mochi does not bundle a model or replace their permission controls. Feature availability varies by operating system: Linux MPRIS, Niri autostart, the experimental Linux AirDrop control, and Linux location-service notes in the [main guide](../README.md) are not Windows setup instructions.

For the optional Apple Live Activity integration, see the separate [relay guide](../relay/README.md); it is not needed to build or use this Windows app.

Found a bug? Open a [GitHub Issue](https://github.com/Spydomain/Mochi/issues) or email [contactme@bikashkumarsarraf.com.np](mailto:contactme@bikashkumarsarraf.com.np). Include the Windows version, app commit, reproduction steps, and a redacted screenshot or video when useful. The Linux AirDrop receiver is not a Windows feature.

**Mochi is a modified version of [Coucou](https://github.com/Louis-CFM/coucou). Special thanks to [Louis-CFM](https://github.com/Louis-CFM) and the Coucou project for the original foundation.**
