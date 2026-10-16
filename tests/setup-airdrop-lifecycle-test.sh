#!/usr/bin/env bash
# Exercise setup's AirDrop ordering without installing packages or touching radios.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d -p "${TMPDIR:-/tmp}" mochi-setup-airdrop.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT

source <(sed -n '/^install_airdrop() {/,/^}/p; /^install_executable() {/,/^}/p; /^install_consent_hook() {/,/^}/p' "$repo/mochi-full-setup.sh")
WINDOWS_DIR="$repo/windows"
export XDG_RUNTIME_DIR="$tmp/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"
AIRDROP_CONFIRM_FILE="$tmp/bin/mochi-airdrop-confirm"
NO_AIRDROP=0
log() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
has_mt7922() { [[ ${MOCHI_TEST_SUPPORTED:-1} == 1 ]]; }
systemctl() { [[ ${MOCHI_TEST_SERVICE_ACTIVE:-${MOCHI_TEST_ACTIVE:-0}} == 1 ]]; }
ss() { if [[ ${MOCHI_TEST_SOCKET_ACTIVE:-${MOCHI_TEST_ACTIVE:-0}} == 1 ]]; then printf 'active socket\n'; fi; }
bash() {
  [[ "$1" == "$WINDOWS_DIR/scripts/install-airdrop-mt7922.sh" ]] || exit 1
  if [[ ${2:-} == --verify ]]; then
    [[ ${MOCHI_TEST_CURRENT:-0} == 1 || -e "$tmp/installs" ]]
  else
    [[ -x "$AIRDROP_CONFIRM_FILE" ]] || { printf 'Missing consent hook before backend setup\n' >&2; exit 1; }
    cmp -s "$WINDOWS_DIR/scripts/mochi-airdrop-confirm.sh" "$AIRDROP_CONFIRM_FILE" || exit 1
    # Exercise real nested Bash processes, not just a flag claiming ownership.
    command bash -euc '
      source "$1"
      airdrop_install_lock
      bash -euc '\''source "$1"; airdrop_install_lock'\'' bash "$1"
      exec 9>>"$XDG_RUNTIME_DIR/airdropd/lock"
      if flock -n 9; then echo "Nested installer lost the daemon lock" >&2; exit 1; fi
    ' bash "$WINDOWS_DIR/scripts/airdrop-install-common.sh"
    printf 'installed\n' >> "$tmp/installs"
  fi
}

# Fresh supported hardware: the consent hook must exist BEFORE provisioning.
install_airdrop
[[ "$(wc -l < "$tmp/installs")" == 1 ]]
[[ -x "$AIRDROP_CONFIRM_FILE" ]]
# No descriptor may escape install_airdrop into the app/OpenCode launch.
command flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true

# Matching bytes are not enough: repair a hook whose execute permission was
# lost instead of leaving every incoming consent request unable to run it.
chmod 644 "$AIRDROP_CONFIRM_FILE"
install_consent_hook
[[ -x "$AIRDROP_CONFIRM_FILE" ]]
cmp "$WINDOWS_DIR/scripts/mochi-airdrop-confirm.sh" "$AIRDROP_CONFIRM_FILE"

# Updating the app with a current, active receiver never replaces its hook or
# starts provisioning a root-owned radio helper.
MOCHI_TEST_ACTIVE=1
MOCHI_TEST_CURRENT=1
MOCHI_TEST_INSTALLED=0
rm -- "$tmp/installs"
printf 'old hook\n' > "$AIRDROP_CONFIRM_FILE"
install_airdrop
[[ "$(< "$AIRDROP_CONFIRM_FILE")" == 'old hook' && ! -e "$tmp/installs" ]]

# A stale active backend must be left untouched and the setup must fail before
# modifying the hook. Once the receiver is off, a retry can install safely.
MOCHI_TEST_CURRENT=0
if ( install_airdrop ) > "$tmp/stale.log" 2>&1; then
  printf 'Setup updated a live receiver.\n' >&2
  exit 1
fi
grep -Fq 'Finish the active transfer' "$tmp/stale.log"
[[ "$(< "$AIRDROP_CONFIRM_FILE")" == 'old hook' && ! -e "$tmp/installs" ]]
MOCHI_TEST_ACTIVE=0
install_airdrop
[[ "$(wc -l < "$tmp/installs")" == 1 ]]
cmp "$WINDOWS_DIR/scripts/mochi-airdrop-confirm.sh" "$AIRDROP_CONFIRM_FILE"

# Either service or listener alone is sufficient to refuse an update.
for kind in SERVICE SOCKET; do
  rm -- "$tmp/installs"
  printf 'old hook\n' > "$AIRDROP_CONFIRM_FILE"
  if ( export "MOCHI_TEST_${kind}_ACTIVE=1"; install_airdrop ) > "$tmp/active-$kind.log" 2>&1; then
    printf 'Setup ignored active %s.\n' "$kind" >&2; exit 1
  fi
  [[ "$(< "$AIRDROP_CONFIRM_FILE")" == 'old hook' && ! -e "$tmp/installs" ]]
  install_airdrop
done

# A standalone daemon can hold its lock before opening any listening socket.
rm -- "$tmp/installs"
printf 'old hook\n' > "$AIRDROP_CONFIRM_FILE"
exec 9>>"$XDG_RUNTIME_DIR/airdropd/lock"
flock -n 9
if ( install_airdrop ) > "$tmp/locked.log" 2>&1; then
  printf 'Setup ignored a standalone daemon lock.\n' >&2; exit 1
fi
[[ "$(< "$AIRDROP_CONFIRM_FILE")" == 'old hook' && ! -e "$tmp/installs" ]]
# Merely exporting a descriptor number must not bypass a daemon's lock. This
# fd names the same inode but has a different open file description.
if ( exec 21>>"$XDG_RUNTIME_DIR/airdropd/lock"; export MOCHI_AIRDROP_INSTALL_LOCK_FD=21; install_airdrop ) > "$tmp/false-inheritance.log" 2>&1; then
  printf 'Setup trusted a forged inherited lock descriptor.\n' >&2; exit 1
fi
exec 9>&-
install_airdrop
command flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true

# Both hook failures and nested backend failures release the lock for retry.
rm -- "$tmp/installs"
if ( install_consent_hook() { exit 42; }; install_airdrop ) > "$tmp/failed-hook.log" 2>&1; then
  printf 'Setup accepted a failed hook install.\n' >&2; exit 1
fi
command flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true
if ( bash() { return 42; }; install_airdrop ) > "$tmp/failed-backend.log" 2>&1; then
  printf 'Setup accepted a failed backend install.\n' >&2; exit 1
fi
command flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true
install_airdrop

# Other adapters should never attempt MT7922 provisioning or radio updates.
MOCHI_TEST_SUPPORTED=0
rm -- "$tmp/installs"
install_airdrop
[[ ! -e "$tmp/installs" ]]
printf 'Fresh install, active update, standalone lock, nested inheritance/release, failure retry and hardware gate passed.\n'
