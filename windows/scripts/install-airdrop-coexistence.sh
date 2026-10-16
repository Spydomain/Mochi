#!/usr/bin/env bash
# Update an already-installed optional MT7922 backend; never grant new sudo rights.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backend="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/mochi/airdrop-mt7921}"
source_helper="$backend/daemon/airdrop-helper"
installed_helper=/usr/local/bin/airdrop-helper
coexistence_patch="$script_dir/airdrop-wifi-coexistence.patch"

if [[ ! -f "$source_helper" || ! -x "$installed_helper" ]]; then
  printf '[mochi] Optional AirDrop backend is not installed; skipped radio update.\n'
  exit 0
fi

if git -C "$backend" apply --check "$coexistence_patch" 2>/dev/null; then
  git -C "$backend" apply "$coexistence_patch"
elif ! git -C "$backend" apply --reverse --check "$coexistence_patch" 2>/dev/null; then
  printf '[mochi] AirDrop helper differs from the supported version; preserved it. Review %s.\n' "$coexistence_patch" >&2
  exit 1
fi
bash -n "$source_helper"

if cmp -s "$source_helper" "$installed_helper"; then
  printf '[mochi] AirDrop coexistence update is already installed.\n'
  exit 0
fi

if [[ ! -f "$installed_helper" || -L "$installed_helper" || "$(stat -c '%u' "$installed_helper")" != 0 ]]; then
  printf '[mochi] Refusing to replace an AirDrop helper that is not a regular root-owned installation.\n' >&2
  exit 1
fi

as_root() {
  if ((EUID == 0)); then "$@"; else sudo "$@"; fi
}
staged_helper="/usr/local/bin/.airdrop-helper.mochi.$$"
as_root install -o root -g root -m 755 "$source_helper" "$staged_helper"
as_root mv -f -- "$staged_helper" "$installed_helper"
printf '[mochi] AirDrop will keep Wi-Fi awake while active and restore its previous power setting when stopped.\n'
