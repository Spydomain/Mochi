#!/usr/bin/env bash
# Install Mochi and its build/runtime dependencies on a Linux desktop.
# Run from a checkout, or pipe this file to bash to clone a fresh checkout.
set -euo pipefail

REPO_URL="https://github.com/Spydomain/Mochi.git"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/windows/package-lock.json" ]]; then
  MOCHI_DIR="$SCRIPT_DIR"
else
  MOCHI_DIR="${MOCHI_DIR:-$HOME/mochi}"
fi
WINDOWS_DIR="$MOCHI_DIR/windows"
BUILT_BINARY="$WINDOWS_DIR/target/release/mochi"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
BINARY="$DATA_HOME/mochi/bin/mochi"
DESKTOP_FILE="$DATA_HOME/applications/io.github.spydomain.mochi.desktop"
LEGACY_DESKTOP_FILE="$DATA_HOME/applications/mochi.desktop"
AUTOSTART_FILE="$CONFIG_HOME/autostart/mochi.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/128x128/apps/mochi.png"
SETTINGS_FILE="$CONFIG_HOME/mochi/settings.json"
PLUGIN_FILE="$CONFIG_HOME/opencode/plugins/mochi.js"
HOOK_FILE="$DATA_HOME/mochi/bin/mochi-hook"
CLEANUP_FILE="$DATA_HOME/mochi/bin/cleanup-opencode-sessions"
SYSTEMD_DIR="$CONFIG_HOME/systemd/user"
AUTOSTART_BACKUP_DIR="$CONFIG_HOME/mochi/autostart-backups"
# One-time upgrade from the earlier local install. These old paths are used
# only for migration; the new app and all newly written files use Mochi.
OLD_BINARY="$DATA_HOME/coucou/bin/coucou"
OLD_SETTINGS_FILE="$CONFIG_HOME/coucou/settings.json"
OLD_PLUGIN_FILE="$CONFIG_HOME/opencode/plugins/coucou.js"
OLD_AUTOSTART_FILE="$CONFIG_HOME/autostart/coucou.desktop"
OLD_APP_SERVICE="coucou-app.service"
OLD_CLEANUP_TIMER="coucou-opencode-cleanup.timer"
NO_LAUNCH=0
CHECK_ONLY=0
CHECK_MISSING=0
NODE_VERSION="v24.21.0"

for arg in "$@"; do
  case "$arg" in
    --no-launch) NO_LAUNCH=1 ;;
    --check) CHECK_ONLY=1 ;;
    --build) ;; # Older quickstart entry point accepted this; setup always builds.
    *) printf 'Unknown option: %s\nUsage: %s [--check] [--no-launch] [--build]\n' "$arg" "$0" >&2; exit 2 ;;
  esac
done

log() { printf '[mochi] %s\n' "$*"; }
die() { printf '[mochi] ERROR: %s\n' "$*" >&2; exit 1; }

run_as_root() {
  if ((EUID == 0)); then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die 'sudo is needed to install missing system packages.'
  fi
}

missing_packages() {
  local package
  for package in "$@"; do
    if command -v pacman >/dev/null 2>&1; then
      pacman -Qq "$package" >/dev/null 2>&1 || printf '%s\n' "$package"
    else
      dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$' || printf '%s\n' "$package"
    fi
  done
}

node_is_supported() {
  local version major minor
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  version="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\. ]] || return 1
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  ((major >= 25 || (major == 24 && minor >= 12) || (major == 22 && minor >= 20)))
}

ensure_node() {
  if node_is_supported; then
    log "Node.js $(node --version) and npm $(npm --version) are available."
    return
  fi

  local arch archive node_dir temp_dir sums
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die 'A supported Node.js version is required on this CPU (x86_64 or aarch64). Install Node.js 24 LTS and rerun setup.' ;;
  esac
  archive="node-$NODE_VERSION-linux-$arch.tar.xz"
  node_dir="$DATA_HOME/mochi/toolchain/${archive%.tar.xz}"
  if [[ ! -x "$node_dir/bin/node" ]]; then
    temp_dir="$(mktemp -d)"
    log "Downloading Node.js $NODE_VERSION from nodejs.org."
    curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$temp_dir/SHASUMS256.txt"
    curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "https://nodejs.org/dist/$NODE_VERSION/$archive" -o "$temp_dir/$archive"
    sums="$(awk -v name="$archive" '$2 == name { print }' "$temp_dir/SHASUMS256.txt")"
    [[ -n "$sums" ]] || die "Node.js checksum is missing for $archive."
    (cd "$temp_dir" && printf '%s\n' "$sums" | sha256sum --check --status) || die 'Node.js download failed checksum verification.'
    tar -xJf "$temp_dir/$archive" -C "$temp_dir"
    mkdir -p "$(dirname "$node_dir")"
    if [[ -e "$node_dir" ]]; then
      mv -- "$node_dir" "$node_dir.invalid.$(date +%s%N)"
    fi
    mv -- "$temp_dir/${archive%.tar.xz}" "$node_dir"
    rm -f -- "$temp_dir/$archive" "$temp_dir/SHASUMS256.txt"
    rmdir -- "$temp_dir"
  fi
  export PATH="$node_dir/bin:$PATH"
  node_is_supported || die 'Downloaded Node.js cannot run on this system; install Node.js 24 LTS for your distribution.'
  log "Using local Node.js $(node --version)."
}

install_system_dependencies() {
  local -a packages missing
  if command -v pacman >/dev/null 2>&1; then
    packages=(base-devel git curl file pkgconf gtk3 webkit2gtk-4.1 geoclue
      gtk-layer-shell libayatana-appindicator librsvg openssl dbus xdotool playerctl iproute2
      gst-plugins-base gst-plugins-good gst-plugins-bad)
  elif command -v apt-get >/dev/null 2>&1; then
    packages=(build-essential git curl file pkg-config libgtk-3-dev
      libwebkit2gtk-4.1-dev geoclue-2.0 libgtk-layer-shell-dev libayatana-appindicator3-dev
      librsvg2-dev libssl-dev libdbus-1-dev libxdo-dev patchelf playerctl iproute2
      gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad)
  else
    die 'Supported package managers: pacman or apt-get.'
  fi
  mapfile -t missing < <(missing_packages "${packages[@]}")
  if ((${#missing[@]} == 0)); then
    log 'System dependencies are installed.'
    return
  fi
  log "Missing system packages: ${missing[*]}"
  if ((CHECK_ONLY)); then
    CHECK_MISSING=1
    return
  fi
  if command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -S --needed --noconfirm "${missing[@]}"
  else
    run_as_root apt-get update
    run_as_root apt-get install -y "${missing[@]}"
  fi
}

ensure_checkout() {
  if [[ -f "$WINDOWS_DIR/package-lock.json" ]]; then
    log "Using existing checkout: $MOCHI_DIR (no git reset or pull)."
    return
  fi
  [[ ! -e "$MOCHI_DIR" ]] || die "Directory exists but is not a Mochi checkout: $MOCHI_DIR"
  git clone --recursive "$REPO_URL" "$MOCHI_DIR"
}

ensure_rust() {
  export PATH="$HOME/.cargo/bin:$PATH"
  if ! command -v rustup >/dev/null 2>&1; then
    log 'Installing Rust using rustup.'
    local installer_file
    installer_file="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$installer_file"
    sh "$installer_file" -y --profile minimal
    rm -f -- "$installer_file"
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  rustup toolchain install stable --profile minimal --no-self-update
  export RUSTUP_TOOLCHAIN=stable
  # Some distributions put an incompatible system rustc before rustup on PATH.
  local stable_rustc
  stable_rustc="$(rustup which rustc --toolchain stable)"
  export RUSTC="$stable_rustc"
  export PATH="$(dirname "$stable_rustc"):$HOME/.cargo/bin:$PATH"
  rustc --version
}

ensure_opencode() {
  export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
  if ! command -v opencode >/dev/null 2>&1 || [[ "$(opencode --version 2>/dev/null || true)" != *'v2.'* ]]; then
    log 'Installing OpenCode v2 from its official installer.'
    local installer_file
    installer_file="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL https://opencode.ai/v2/install -o "$installer_file"
    bash "$installer_file"
    rm -f -- "$installer_file"
    export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
  fi
  command -v opencode >/dev/null 2>&1 || die 'OpenCode installation did not provide an opencode command.'
  [[ "$(opencode --version)" == *'v2.'* ]] || die 'OpenCode v2 is required.'
  log "OpenCode: $(opencode --version)"
}

build_app() {
  log 'Installing JavaScript dependencies and building release app.'
  (cd "$WINDOWS_DIR" && npm ci && ./node_modules/.bin/tauri build --no-bundle)
  [[ -x "$BUILT_BINARY" && -x "$WINDOWS_DIR/target/release/mochi-hook" ]] || die 'Release app or relay is missing.'
}

migrate_previous_settings() {
  if [[ ! -e "$SETTINGS_FILE" && -f "$OLD_SETTINGS_FILE" ]]; then
    install -m 600 "$OLD_SETTINGS_FILE" "$SETTINGS_FILE"
    log 'Copied existing settings to the Mochi location.'
  fi
  if [[ -f "$OLD_PLUGIN_FILE" ]] && grep -Fq 'generated by Coucou' "$OLD_PLUGIN_FILE"; then
    install -d -m 700 "$AUTOSTART_BACKUP_DIR"
    mv -- "$OLD_PLUGIN_FILE" "$AUTOSTART_BACKUP_DIR/coucou-opencode.js.disabled.$(date +%s%N)"
    log 'Retired the previous generated OpenCode plugin.'
  fi
}

retire_previous_autostart() {
  if [[ -f "$OLD_AUTOSTART_FILE" ]] &&
      grep -Fq "Exec=\"$OLD_BINARY\"" "$OLD_AUTOSTART_FILE"; then
    install -d -m 700 "$AUTOSTART_BACKUP_DIR"
    mv -- "$OLD_AUTOSTART_FILE" "$AUTOSTART_BACKUP_DIR/coucou.desktop.disabled.$(date +%s%N)"
  fi
  if [[ -f "$SYSTEMD_DIR/$OLD_APP_SERVICE" ]] &&
      grep -Fq "ExecStart=$OLD_BINARY" "$SYSTEMD_DIR/$OLD_APP_SERVICE"; then
    systemctl --user disable --now "$OLD_APP_SERVICE" >/dev/null || die 'Could not stop the previous app service.'
  fi
  if [[ -f "$SYSTEMD_DIR/$OLD_CLEANUP_TIMER" ]]; then
    systemctl --user disable --now "$OLD_CLEANUP_TIMER" >/dev/null 2>&1 || true
  fi
}

install_files() {
  local desktop_session="${XDG_CURRENT_DESKTOP:-${XDG_SESSION_DESKTOP:-}}"
  [[ -z "${NIRI_SOCKET:-}" ]] || desktop_session="niri"
  mkdir -p "$(dirname "$DESKTOP_FILE")" "$(dirname "$AUTOSTART_FILE")" "$(dirname "$ICON_FILE")" "$(dirname "$SETTINGS_FILE")" "$(dirname "$PLUGIN_FILE")" "$(dirname "$HOOK_FILE")" "$SYSTEMD_DIR"
  migrate_previous_settings
  local staged_binary="$DATA_HOME/mochi/bin/.mochi-new.$$"
  install -m 755 "$BUILT_BINARY" "$staged_binary"
  mv -f -- "$staged_binary" "$BINARY"
  install -m 755 "$WINDOWS_DIR/target/release/mochi-hook" "$HOOK_FILE"
  install -m 755 "$WINDOWS_DIR/scripts/cleanup-opencode-sessions.sh" "$CLEANUP_FILE"
  install -m 644 "$WINDOWS_DIR/src-tauri/icons/128x128.png" "$ICON_FILE"
  if [[ ! -e "$SETTINGS_FILE" ]]; then
    printf '{"chatProvider":"opencode","chatModels":{"opencode":"opencode/nemotron-3-ultra-free"},"language":"en"}\n' > "$SETTINGS_FILE"
    log 'Created English/OpenCode defaults.'
  else
    log 'Preserved existing settings.'
  fi
  # Keep the user's settings intact while making the installed app persistent.
  node -e 'const fs=require("node:fs"); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p,"utf8")); v.autostart=true; v.openOnHover=true; v.language="en"; v.chatProvider="opencode"; v.chatModels={...(v.chatModels||{}), opencode:(v.chatModels?.opencode||"opencode/nemotron-3-ultra-free")}; fs.writeFileSync(p,JSON.stringify(v,null,2)+"\n",{mode:0o600});' "$SETTINGS_FILE" || die 'Settings JSON is invalid; kept it intact for repair.'
  chmod 600 "$SETTINGS_FILE"
  if [[ ! -e "$PLUGIN_FILE" ]] || grep -q 'generated by Mochi' "$PLUGIN_FILE"; then
    node -e 'const fs=require("node:fs"); const [src,dst,hook]=process.argv.slice(1); const js=fs.readFileSync(src,"utf8").replace("{HOOK}",JSON.stringify(hook)); fs.writeFileSync(dst,js,{mode:0o600});' \
      "$WINDOWS_DIR/scripts/mochi-opencode.js" "$PLUGIN_FILE" "$HOOK_FILE"
    chmod 600 "$PLUGIN_FILE"
    log 'Installed the OpenCode v2 plugin.'
  else
    log "Preserved custom OpenCode plugin: $PLUGIN_FILE"
  fi
  if [[ -f "$LEGACY_DESKTOP_FILE" && ! -e "$DESKTOP_FILE" ]] &&
      grep -Fqx "Exec=\"$BINARY\"" "$LEGACY_DESKTOP_FILE"; then
    mv -- "$LEGACY_DESKTOP_FILE" "$DESKTOP_FILE"
  fi
  if [[ -e "$DESKTOP_FILE" ]] && ! grep -Fqx 'X-Mochi-Managed=true' "$DESKTOP_FILE"; then
    log "Preserved existing desktop entry: $DESKTOP_FILE"
  else
    printf '[Desktop Entry]\nType=Application\nName=Mochi\nComment=Desktop companion and media controls\nExec="%s"\nIcon=mochi\nTerminal=false\nCategories=Utility;\nX-Mochi-Managed=true\n' "$BINARY" > "$DESKTOP_FILE"
    chmod 644 "$DESKTOP_FILE"
  fi
  printf '[Unit]\nDescription=Mochi OpenCode session cleanup\n\n[Service]\nType=oneshot\nWorkingDirectory=%%h\nExecStart=%s\n' "$CLEANUP_FILE" > "$SYSTEMD_DIR/mochi-opencode-cleanup.service"
  printf '[Unit]\nDescription=Remove Mochi chat sessions older than 30 days\n\n[Timer]\nOnBootSec=15min\nOnUnitActiveSec=1d\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' > "$SYSTEMD_DIR/mochi-opencode-cleanup.timer"
  if [[ "${desktop_session,,}" == *niri* ]]; then
    # Niri gets one graphical-session service. systemd's XDG generator treats
    # renamed files *inside* autostart/ as launchers too, so move old entries
    # completely outside that directory. Keep them as recoverable backups.
    local entry
    install -d -m 700 "$AUTOSTART_BACKUP_DIR"
    for entry in "$CONFIG_HOME"/autostart/*.desktop*; do
      [[ -f "$entry" ]] || continue
      if grep -Fxq "Exec=\"$BINARY\"" "$entry" ||
         grep -Fxq "Exec=$BINARY" "$entry" ||
         grep -Fxq "Exec=$BINARY " "$entry" ||
         grep -Fxq "Exec=\"$BUILT_BINARY\"" "$entry" ||
         grep -Fxq "Exec=$BUILT_BINARY" "$entry" ||
         grep -Fxq "Exec=$BUILT_BINARY " "$entry"; then
        mv -- "$entry" "$AUTOSTART_BACKUP_DIR/${entry##*/}.disabled-by-mochi-setup.$(date +%s%N)"
        log "Retired duplicate autostart entry: $entry"
      fi
    done
    printf '[Unit]\nDescription=Mochi desktop companion\nPartOf=graphical-session.target\nAfter=graphical-session.target\n\n[Service]\nType=simple\nWorkingDirectory=%%h\nExecStart=%s\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=graphical-session.target\n' "$BINARY" > "$SYSTEMD_DIR/mochi-app.service"
  else
    printf '[Desktop Entry]\nType=Application\nName=Mochi\nExec="%s"\nHidden=false\nX-GNOME-Autostart-enabled=true\n' "$BINARY" > "$AUTOSTART_FILE"
    chmod 644 "$AUTOSTART_FILE"
    grep -Fq "Exec=\"$BINARY\"" "$AUTOSTART_FILE" || die 'Autostart entry was not written correctly.'
  fi
  systemctl --user daemon-reload >/dev/null || die 'Could not reload user services.'
  systemctl --user enable --now mochi-opencode-cleanup.timer >/dev/null || die 'Could not enable session cleanup timer.'
  if [[ "${desktop_session,,}" == *niri* ]]; then
    systemctl --user enable mochi-app.service >/dev/null || die 'Could not enable Niri autostart service.'
  else
    systemctl --user disable --now mochi-app.service >/dev/null 2>&1 || true
  fi
  retire_previous_autostart
  log 'Created application menu and one desktop autostart method.'
}

start_app() {
  local pid path
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    path="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    case "$path" in
      "$BINARY"|"$BINARY (deleted)"|"$BUILT_BINARY"|"$BUILT_BINARY (deleted)"|"$OLD_BINARY"|"$OLD_BINARY (deleted)")
        kill -TERM "$pid"
        for _ in {1..40}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
        kill -0 "$pid" 2>/dev/null && die "Old Mochi process $pid did not stop."
        ;;
      *) die "Another Mochi is running at $path; close it before launching this build." ;;
    esac
  done < <({ pgrep -x mochi || true; pgrep -x coucou || true; } | sort -u)
  if systemctl --user is-enabled --quiet mochi-app.service 2>/dev/null; then
    systemctl --user restart mochi-app.service || die 'Mochi service failed to start.'
    sleep 2
    systemctl --user is-active --quiet mochi-app.service || die 'Mochi service stopped after launch.'
    log "Mochi running as a graphical-session service (PID $(systemctl --user show -p MainPID --value mochi-app.service))."
    return
  fi
  nohup "$BINARY" >/dev/null 2>&1 </dev/null &
  pid=$!
  sleep 2
  kill -0 "$pid" 2>/dev/null || die "Mochi failed to start; check $DATA_HOME/mochi/mochi.log"
  log "Mochi running (PID $pid)."
}

((EUID != 0)) || die 'Run setup as your desktop user, without sudo; it requests sudo only when system packages are missing.'
export PATH="$HOME/.cargo/bin:$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
install_system_dependencies
if ((CHECK_ONLY)); then
  node_is_supported || { log 'Node.js 22.20+ or 24.12+ with npm is needed; setup can download Node.js 24 LTS.'; CHECK_MISSING=1; }
  command -v rustup >/dev/null 2>&1 || { log 'Rust is missing; setup can install it with rustup.'; CHECK_MISSING=1; }
  [[ "$(opencode --version 2>/dev/null || true)" == *'v2.'* ]] || { log 'OpenCode v2 is missing; setup can install it.'; CHECK_MISSING=1; }
  log 'Dependency check complete; no changes made.'
  exit "$CHECK_MISSING"
fi
ensure_checkout
ensure_node
ensure_rust
ensure_opencode
build_app
install_files
opencode service start >/dev/null || die 'Could not start the OpenCode background service.'
if ((NO_LAUNCH)); then
  log 'Setup complete. Launch skipped (--no-launch).'
else
  start_app
  log 'Setup complete.'
fi
