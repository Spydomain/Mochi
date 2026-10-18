#!/usr/bin/env bash
# Exercise the real installation recipe and its standalone uninstaller in a sandbox.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d -p "${TMPDIR:-/tmp/opencode}" mochi-uninstall-install.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
if ((EUID == 0)); then
  echo 'Standalone desktop-user lifecycle fixture skipped as root; run the Python unit fixtures instead.'
  exit 0
fi
export HOME="$tmp/home with spaces"
export XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data"
export XDG_CACHE_HOME="$tmp/cache" XDG_STATE_HOME="$tmp/state" XDG_RUNTIME_DIR="$tmp/runtime"
mkdir -p "$tmp/commands" "$HOME/received" "$XDG_CONFIG_HOME/mochi" "$XDG_RUNTIME_DIR"
printf '#!/usr/bin/env bash\nexit 3\n' > "$tmp/commands/systemctl"
printf '#!/usr/bin/env bash\necho "Unexpected sudo in fixture" >&2\nexit 99\n' > "$tmp/commands/sudo"
chmod 755 "$tmp/commands/systemctl" "$tmp/commands/sudo"
export PATH="$tmp/commands:$PATH"
MOCHI_DIR="$repo"
WINDOWS_DIR="$tmp/windows"
mkdir -p "$WINDOWS_DIR/scripts" "$WINDOWS_DIR/airdrop" "$WINDOWS_DIR/src-tauri/icons" "$WINDOWS_DIR/target/release"
for name in cleanup-opencode-sessions.sh mochi-airdrop-confirm.sh mochi-airdrop-pick.py mochi-opencode.js uninstall-mochi.py; do
  cp "$repo/windows/scripts/$name" "$WINDOWS_DIR/scripts/$name"
done
cp "$repo/windows/airdrop/mochi_discover.py" "$repo/windows/airdrop/mochi_send.py" "$WINDOWS_DIR/airdrop/"
cp /usr/bin/true "$WINDOWS_DIR/target/release/mochi-hook"
printf 'fixture icon\n' > "$WINDOWS_DIR/src-tauri/icons/128x128.png"
DATA_HOME="$XDG_DATA_HOME" CONFIG_HOME="$XDG_CONFIG_HOME"
BUILT_BINARY=/usr/bin/true
BINARY="$DATA_HOME/mochi/bin/mochi"
HOOK_FILE="$DATA_HOME/mochi/bin/mochi-hook"
CLEANUP_FILE="$DATA_HOME/mochi/bin/cleanup-opencode-sessions"
AIRDROP_CONFIRM_FILE="$DATA_HOME/mochi/bin/mochi-airdrop-confirm"
AIRDROP_PICKER_FILE="$DATA_HOME/mochi/bin/mochi-airdrop-pick"
SETTINGS_FILE="$CONFIG_HOME/mochi/settings.json"
PLUGIN_FILE="$CONFIG_HOME/opencode/plugins/mochi.js"
DESKTOP_FILE="$DATA_HOME/applications/io.github.spydomain.mochi.desktop"
LEGACY_DESKTOP_FILE="$DATA_HOME/applications/mochi.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/128x128/apps/mochi.png"
SYSTEMD_DIR="$CONFIG_HOME/systemd/user"
AUTOSTART_FILE="$CONFIG_HOME/autostart/mochi.desktop"
CLEANUP_AUTOSTART_FILE="$CONFIG_HOME/autostart/mochi-session-cleanup.desktop"
OLD_APP_SERVICE=coucou-app.service OLD_CLEANUP_TIMER=coucou-opencode-cleanup.timer
NO_AIRDROP=1
source <(sed -n '/^install_executable() {/,/^}/p' "$repo/mochi-full-setup.sh")
source <(sed -n '/^install_consent_hook() {/,/^}/p' "$repo/mochi-full-setup.sh")
source <(sed -n '/^install_files() {/,/^start_app() {/p' "$repo/mochi-full-setup.sh" | sed '$d')
log() { :; }
die() { echo "$*" >&2; exit 1; }
migrate_previous_settings() { :; }
retire_previous_autostart() { :; }
write_settings() {
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  python3 - "$SETTINGS_FILE" "$HOME/received" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'airdropDirectory':sys.argv[2]}))
PY
}
has_user_systemd() { return 1; }
write_settings
install_files
source <(sed -n '/^record_install_revision() {/,/^}/p' "$repo/mochi-full-setup.sh")
INSTALLED_REVISION="$DATA_HOME/mochi/installed-revision"
NO_AIRDROP=1
record_install_revision
test "$(cat "$DATA_HOME/mochi/installed-no-airdrop")" = 1
grep -Eq '^[0-9a-f]{40}( dirty)?$' "$INSTALLED_REVISION"
# Rerunning regular setup is an explicit opt-in, not a permanent opt-out.
NO_AIRDROP=0
record_install_revision
test ! -e "$DATA_HOME/mochi/installed-no-airdrop"
NO_AIRDROP=1
cmp "$repo/uninstall-mochi.sh" "$DATA_HOME/mochi/bin/uninstall-mochi"
cmp "$repo/windows/scripts/uninstall-mochi.py" "$DATA_HOME/mochi/bin/uninstall-mochi.py"
test -x "$DATA_HOME/mochi/bin/uninstall-mochi"
printf 'received PDF fixture\n' > "$HOME/received/test.pdf"
"$DATA_HOME/mochi/bin/uninstall-mochi" --purge --dry-run > "$tmp/dry-run"
test -x "$BINARY"
test -f "$SETTINGS_FILE"
"$DATA_HOME/mochi/bin/uninstall-mochi" --purge --yes > "$tmp/uninstall"
test ! -e "$BINARY"
test ! -e "$SETTINGS_FILE"
test ! -e "$PLUGIN_FILE"
test ! -e "$AUTOSTART_FILE"
test ! -e "$CLEANUP_AUTOSTART_FILE"
test ! -e "$DESKTOP_FILE"
test -f "$HOME/received/test.pdf"
# Also exercise the exact generated Niri service and cleanup timer, not a
# handwritten approximation. This function never contacts a user manager.
has_user_systemd() { return 0; }
systemctl() { return 0; }
export XDG_CURRENT_DESKTOP=niri
AUTOSTART_BACKUP_DIR="$CONFIG_HOME/mochi/autostart-backups"
write_settings
install_files
test -f "$SYSTEMD_DIR/mochi-app.service"
test -f "$SYSTEMD_DIR/mochi-opencode-cleanup.timer"
"$DATA_HOME/mochi/bin/uninstall-mochi" --purge --yes > "$tmp/uninstall-systemd"
test ! -e "$SYSTEMD_DIR/mochi-app.service"
test ! -e "$SYSTEMD_DIR/mochi-opencode-cleanup.timer"
test -f "$HOME/received/test.pdf"
echo 'Real autostart/Niri install recipes, standalone dry run, full user-data removal and received-file preservation passed.'
