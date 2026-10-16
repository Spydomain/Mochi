#!/usr/bin/env bash
# Install Mochi's bounded-memory receiver overlay after the pinned OpenDrop patches.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$here/airdrop-install-common.sh"
venv="${1:?Usage: install-airdrop-receiver.sh VENV [--verify]}"
mode="${2:-}"
[[ $# -le 2 && ( -z "$mode" || "$mode" == --verify ) ]] || exit 2
source_module="$here/../airdrop/mochi_receive.py"
delta="$here/../airdrop/patches/opendrop-receive-workspace.patch"
identity_delta="$here/../airdrop/patches/opendrop-stable-service-id.patch"
security_delta="$here/../airdrop/patches/opendrop-receive-security.patch"
shopt -s nullglob
servers=("$venv"/lib/python*/site-packages/opendrop/server.py)
[[ ${#servers[@]} == 1 ]] || { echo 'Cannot identify the OpenDrop receiver.' >&2; exit 1; }
server="${servers[0]}"
module="$(dirname -- "$server")/mochi_receive.py"
config="$(dirname -- "$server")/config.py"
receiver_server_current() (
  # Later overlays overlap earlier hunks. Unwind a COPY newest-first instead
  # of certifying individual patches against an incompatible layered server.
  staged="$(mktemp -d)" || exit 1
  trap 'rm -rf -- "$staged"' EXIT
  cp -- "$server" "$staged/server.py" || exit 1
  for overlay in "$security_delta" "$delta"; do
    patch --batch --forward --fuzz=0 --reverse "$staged/server.py" < "$overlay" >/dev/null 2>&1 || exit 1
  done
)
if receiver_server_current &&
   patch --batch --forward --fuzz=0 --dry-run --reverse "$config" < "$identity_delta" >/dev/null 2>&1 &&
   cmp -s "$source_module" "$module"; then
  echo '[mochi-airdrop] Streaming receiver is up to date.'
  exit 0
fi
[[ "$mode" != --verify ]] || { echo 'Streaming receiver is missing or stale.' >&2; exit 1; }
if ! airdrop_install_lock || ! airdrop_require_idle; then
  echo 'Turn AirDrop off before updating the receiver; no running transfer was changed.' >&2
  exit 1
fi
# Stage and compile the whole overlay set before replacing installed files.
# The daemon lock prevents a worker starting between these atomic renames.
staged="$(mktemp -d "$(dirname -- "$server")/.mochi-receiver.XXXXXXXX")"
trap 'rm -rf -- "$staged"' EXIT
cp -- "$server" "$staged/server.py"
cp -- "$config" "$staged/config.py"
install -m 644 "$source_module" "$staged/mochi_receive.py"
if patch --batch --forward --fuzz=0 --dry-run --reverse "$staged/server.py" < "$security_delta" >/dev/null 2>&1; then
  patch --batch --forward --fuzz=0 --reverse "$staged/server.py" < "$security_delta"
fi
if patch --batch --forward --fuzz=0 --dry-run --reverse "$staged/server.py" < "$delta" >/dev/null 2>&1; then
  :
elif patch --batch --forward --fuzz=0 --dry-run "$staged/server.py" < "$delta" >/dev/null 2>&1; then
  patch --batch --forward --fuzz=0 "$staged/server.py" < "$delta"
else
  echo 'Unknown receiver version; existing files were preserved.' >&2
  exit 1
fi
patch --batch --forward --fuzz=0 "$staged/server.py" < "$security_delta" || {
  echo 'Unknown receiver security version; existing files were preserved.' >&2; exit 1;
}
if patch --batch --forward --fuzz=0 --dry-run --reverse "$staged/config.py" < "$identity_delta" >/dev/null 2>&1; then
  :
elif patch --batch --forward --fuzz=0 --dry-run "$staged/config.py" < "$identity_delta" >/dev/null 2>&1; then
  patch --batch --forward --fuzz=0 "$staged/config.py" < "$identity_delta"
else
  echo 'Unknown receiver identity configuration; existing files were preserved.' >&2
  exit 1
fi
"$venv/bin/python" -m py_compile "$staged/server.py" "$staged/mochi_receive.py" "$staged/config.py"
mv -f -- "$staged/server.py" "$server"
mv -f -- "$staged/config.py" "$config"
mv -f -- "$staged/mochi_receive.py" "$module"
echo '[mochi-airdrop] Streaming receiver installed.'
