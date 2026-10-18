#!/usr/bin/env bash
# Update a clean Mochi checkout only when its official GitHub default branch
# has new commits. Building happens through the same setup path as a fresh install.
set -euo pipefail

REPO_URL="${MOCHI_UPDATE_REMOTE:-https://github.com/Spydomain/Mochi.git}"
MOCHI_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

log() { printf '[mochi-update] %s\n' "$*"; }
die() { printf '[mochi-update] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$MOCHI_DIR/mochi-full-setup.sh" ]] || die 'Run the updater from a Mochi checkout.'
[[ "$(git -C "$MOCHI_DIR" rev-parse --show-toplevel 2>/dev/null || true)" == "$MOCHI_DIR" ]] ||
  die 'The updater needs a Git checkout of Mochi.'

# A read-only remote check means a no-update run never rebuilds, restarts, or
# modifies the installed application, even if this checkout has local edits.
remote_info="$(git ls-remote --symref "$REPO_URL" HEAD)" || die 'Could not check GitHub for updates; the current app was left unchanged.'
branch="$(printf '%s\n' "$remote_info" | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2 }')"
remote_sha="$(printf '%s\n' "$remote_info" | awk '$2 == "HEAD" && $1 != "ref:" { print $1 }')"
[[ -n "$branch" && "$remote_sha" =~ ^[0-9a-f]{40}$ ]] || die 'Could not identify the upstream default branch; the current app was left unchanged.'
local_sha="$(git -C "$MOCHI_DIR" rev-parse HEAD)" || die 'Could not read the local revision.'
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALLED_BINARY="$DATA_HOME/mochi/bin/mochi"
INSTALLED_HOOK="$DATA_HOME/mochi/bin/mochi-hook"
INSTALLED_CLEANUP="$DATA_HOME/mochi/bin/cleanup-opencode-sessions"
INSTALLED_CONFIRM="$DATA_HOME/mochi/bin/mochi-airdrop-confirm"
INSTALLED_PICKER="$DATA_HOME/mochi/bin/mochi-airdrop-pick"
INSTALLED_REVISION="$DATA_HOME/mochi/installed-revision"
installed_sha="$(sed -n '1p' "$INSTALLED_REVISION" 2>/dev/null || true)"
NO_AIRDROP=0
[[ "$(cat "$DATA_HOME/mochi/installed-no-airdrop" 2>/dev/null || true)" != 1 ]] || NO_AIRDROP=1

run_setup() {
  local -a options=()
  (( !NO_AIRDROP )) || options+=(--no-airdrop)
  "$MOCHI_DIR/mochi-full-setup.sh" "${options[@]}"
}

installation_complete() {
  [[ -x "$INSTALLED_BINARY" && -x "$INSTALLED_HOOK" && -x "$INSTALLED_CLEANUP" && -x "$INSTALLED_CONFIRM" && -x "$INSTALLED_PICKER" ]] &&
    cmp -s "$MOCHI_DIR/windows/scripts/mochi-airdrop-pick.py" "$INSTALLED_PICKER" &&
    [[ -x "$DATA_HOME/mochi/bin/mochi-airdrop-browse" && -x "$DATA_HOME/mochi/bin/mochi-airdrop-send" ]] &&
    cmp -s "$MOCHI_DIR/windows/airdrop/mochi_discover.py" "$DATA_HOME/mochi/bin/mochi-airdrop-browse" &&
    cmp -s "$MOCHI_DIR/windows/airdrop/mochi_send.py" "$DATA_HOME/mochi/bin/mochi-airdrop-send" &&
    [[ -x "$DATA_HOME/mochi/bin/uninstall-mochi" && -x "$DATA_HOME/mochi/bin/uninstall-mochi.py" ]] &&
    cmp -s "$MOCHI_DIR/uninstall-mochi.sh" "$DATA_HOME/mochi/bin/uninstall-mochi" &&
    cmp -s "$MOCHI_DIR/windows/scripts/uninstall-mochi.py" "$DATA_HOME/mochi/bin/uninstall-mochi.py" &&
    cmp -s "$MOCHI_DIR/windows/scripts/mochi-airdrop-confirm.sh" "$INSTALLED_CONFIRM" &&
    cmp -s "$MOCHI_DIR/windows/scripts/cleanup-opencode-sessions.sh" "$INSTALLED_CLEANUP" &&
    { ((NO_AIRDROP)) || bash "$MOCHI_DIR/windows/scripts/install-airdrop-mt7922.sh" --verify >/dev/null 2>&1; }
}

verify_install() {
  local expected="$1"
  installation_complete || die 'Setup returned without the full app, relay, cleanup, uninstaller, AirDrop file chooser, and consent hook.'
  [[ "$(sed -n '1p' "$INSTALLED_REVISION" 2>/dev/null || true)" == "$expected" ]] ||
    die 'Setup returned without confirming the installed revision; rerun setup or inspect its output.'
}

if [[ "$local_sha" == "$remote_sha" ]]; then
  if [[ "$installed_sha" == "$local_sha" ]] && installation_complete; then
    log 'No updates available. Current Mochi installation unchanged.'
    exit 0
  fi
  if [[ -n "$(git -C "$MOCHI_DIR" status --porcelain --untracked-files=normal)" ]]; then
    log 'No upstream updates. The checkout has local edits, so the installed app was left unchanged.'
    exit 0
  fi
  log 'Source is current, but the installed app is missing or an earlier setup did not finish. Reinstalling.'
  run_setup || die 'Setup failed; the existing app was left as-is where possible.'
  verify_install "$local_sha"
  log 'Mochi installation repaired.'
  exit 0
fi

if [[ -n "$(git -C "$MOCHI_DIR" status --porcelain --untracked-files=normal)" ]]; then
  die 'An update may be available, but this checkout has local changes. Commit or stash them first; the app was left unchanged.'
fi

git -C "$MOCHI_DIR" fetch --no-tags "$REPO_URL" "$branch" || die 'Could not fetch the update; the current app was left unchanged.'
fetched_sha="$(git -C "$MOCHI_DIR" rev-parse FETCH_HEAD)"
if git -C "$MOCHI_DIR" merge-base --is-ancestor "$fetched_sha" HEAD; then
  if [[ "$installed_sha" == "$local_sha" ]] && installation_complete; then
    log 'No updates available. Current Mochi installation unchanged.'
    exit 0
  fi
  log 'Local source is ahead of upstream, but its installation is incomplete. Reinstalling the local revision.'
  run_setup || die 'Setup failed; the existing app was left as-is where possible.'
  verify_install "$local_sha"
  log 'Mochi installation repaired.'
  exit 0
fi
git -C "$MOCHI_DIR" merge-base --is-ancestor HEAD "$fetched_sha" ||
  die 'Local and upstream history have diverged. Resolve this manually; the app was left unchanged.'

log "Updating $local_sha to $fetched_sha."
git -C "$MOCHI_DIR" merge --ff-only "$fetched_sha" || die 'Fast-forward failed; the installed app was left unchanged.'
run_setup || die 'Source updated, but setup failed. The previous installed app may still be running; inspect setup output.'
verify_install "$fetched_sha"
log 'Mochi updated and restarted.'
