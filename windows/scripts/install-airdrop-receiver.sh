#!/usr/bin/env bash
# Install Mochi's bounded-memory receiver overlay after the pinned OpenDrop patches.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
venv="${1:?Usage: install-airdrop-receiver.sh VENV [--verify]}"
mode="${2:-}"
[[ $# -le 2 && ( -z "$mode" || "$mode" == --verify ) ]] || exit 2
source_module="$here/../airdrop/mochi_receive.py"
delta="$here/../airdrop/patches/opendrop-receive-workspace.patch"
identity_delta="$here/../airdrop/patches/opendrop-stable-service-id.patch"
shopt -s nullglob
servers=("$venv"/lib/python*/site-packages/opendrop/server.py)
[[ ${#servers[@]} == 1 ]] || { echo 'Cannot identify the OpenDrop receiver.' >&2; exit 1; }
server="${servers[0]}"
module="$(dirname -- "$server")/mochi_receive.py"
config="$(dirname -- "$server")/config.py"
if patch --batch --dry-run --reverse "$server" < "$delta" >/dev/null 2>&1 &&
   patch --batch --forward --fuzz=0 --dry-run --reverse "$config" < "$identity_delta" >/dev/null 2>&1 &&
   cmp -s "$source_module" "$module"; then
  echo '[mochi-airdrop] Streaming receiver is up to date.'
  exit 0
fi
[[ "$mode" != --verify ]] || { echo 'Streaming receiver is missing or stale.' >&2; exit 1; }
if systemctl --user is-active --quiet mochi-airdrop.service ||
   ss -ltnH '( sport = :8771 )' | grep -q .; then
  echo 'Turn AirDrop off before updating the receiver; no running transfer was changed.' >&2
  exit 1
fi
if patch --batch --dry-run --reverse "$server" < "$delta" >/dev/null 2>&1; then
  :
elif patch --batch --dry-run "$server" < "$delta" >/dev/null 2>&1; then
  patch --batch "$server" < "$delta"
else
  echo 'Unknown receiver version; existing files were preserved.' >&2
  exit 1
fi
if patch --batch --forward --fuzz=0 --dry-run --reverse "$config" < "$identity_delta" >/dev/null 2>&1; then
  :
elif patch --batch --forward --fuzz=0 --dry-run "$config" < "$identity_delta" >/dev/null 2>&1; then
  patch --batch --forward --fuzz=0 "$config" < "$identity_delta"
else
  echo 'Unknown receiver identity configuration; existing files were preserved.' >&2
  exit 1
fi
install -m 644 "$source_module" "$module"
"$venv/bin/python" -m py_compile "$server" "$module" "$config"
echo '[mochi-airdrop] Streaming receiver installed.'
