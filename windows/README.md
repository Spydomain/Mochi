# Mochi for Windows

Mochi is a desktop companion for Windows. It lives at the top of the screen and can display agent activity, receive permission prompts, provide chat, accept dropped files, and offer configurable shortcuts and integrations.

**Mochi is a modified version of [Coucou](https://github.com/Louis-CFM/coucou), adapted and extended for this project. Special thanks to [Louis-CFM](https://github.com/Louis-CFM) and the Coucou project for the original foundation.**

## Official project and ownership

Mochi is maintained by Spydomain. The official project home, source repository, and ownership reference are:

https://github.com/Spydomain/Mochi

Use this repository URL as the canonical source for Mochi.

## Requirements

- Windows 10 or Windows 11
- Node.js 20 or newer
- Rust, installed with [rustup](https://rustup.rs)
- Visual Studio Build Tools with the **Desktop development with C++** workload

WebView2 is available on supported Windows installations.

## Run a development build

```powershell
git clone https://github.com/Spydomain/Mochi.git
cd Mochi/windows
npm ci
npm run tauri dev
```

## Build a Windows package

```powershell
cd windows
npm run pack
```

The installer is written to `windows/release/`. A locally built executable is available under `windows/target/release/`.

## Test and validate

```powershell
npm test
npm run build
```

Run backend tests from `windows/src-tauri/`:

```powershell
cargo test
```

## Application data

- Settings and user data: `%APPDATA%\\Mochi`
- Logs: `%LOCALAPPDATA%\\Mochi\\mochi.log`
- Custom sounds: `%APPDATA%\\Mochi\\sounds`

## Repository automation

This repository has no `.github` directory and no GitHub Actions workflow definitions. GitHub Actions are not configured from this repository.
