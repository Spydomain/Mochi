#!/usr/bin/env bash
# No running processes are killed; /proc fixtures cover app-update refusal.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d -p "${TMPDIR:-/tmp/opencode}" mochi-workflow-test.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
source "$repo/windows/scripts/airdrop-install-common.sh"
mkdir -p "$tmp/proc/123"
data="$tmp/data with spaces/mochi"
for program in "$data/bin/mochi-airdrop-pick" "$data/bin/mochi-airdrop-send" "$data/omdrop-plugin/bin/pick.py"; do
  printf '%s\0' python3 "$program" > "$tmp/proc/123/cmdline"
  if airdrop_require_app_idle "$data" "$tmp/proc" > "$tmp/refusal" 2>&1; then
    echo 'App update ignored an active file chooser.' >&2; exit 1
  fi
done
for program in "$data/owl/.venv-opendrop/bin/opendrop" "$data/omdrop-plugin/bin/omdrop"; do
  printf '%s\0' python3 "$program" -i awdl0 send -f '/files/test.pdf' > "$tmp/proc/123/cmdline"
  if airdrop_require_app_idle "$data" "$tmp/proc" > "$tmp/refusal" 2>&1; then
    echo 'App update ignored an active sender.' >&2; exit 1
  fi
done
# A current receiving daemon, normal app or an unrelated Python process must
# not prevent an ordinary UI update that leaves the receiver service intact.
for program in "$data/airdrop-mt7921/daemon/airdropd" "$data/bin/mochi" /other/opendrop; do
  printf '%s\0' "$program" run > "$tmp/proc/123/cmdline"
  airdrop_require_app_idle "$data" "$tmp/proc"
done
printf '%s\0' python3 "$data/owl/.venv-opendrop/bin/opendrop" find > "$tmp/proc/123/cmdline"
airdrop_require_app_idle "$data" "$tmp/proc"
# The real restart entry point must refuse before invoking service/process
# management, not merely detect a busy helper after killing the old app.
source <(sed -n '/^start_app() {/,/^}/p' "$repo/mochi-full-setup.sh")
if (
  DATA_HOME="$tmp/data with spaces"
  airdrop_require_app_idle() { return 1; }
  die() { exit 42; }
  systemctl() { printf 'service touched\n' >> "$tmp/touched"; }
  pgrep() { printf 'process inspected for shutdown\n' >> "$tmp/touched"; }
  kill() { printf 'process killed\n' >> "$tmp/touched"; }
  start_app
); then
  echo 'App restart continued despite an outgoing workflow.' >&2; exit 1
fi
[[ ! -e "$tmp/touched" ]]
printf 'Outgoing AirDrop/chooser update refusal and independent receiver preservation checks passed.\n'
