#!/usr/bin/env bash
# Isolated installer regression. Optional args exercise the actual overlay set
# against copied workspace-only OpenDrop server.py and config.py fixtures.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d -p "${TMPDIR:-/tmp}" mochi-receiver-installer.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
scripts="$tmp/windows/scripts"
assets="$tmp/windows/airdrop"
venv="$tmp/venv"
package="$venv/lib/python3/site-packages/opendrop"
mkdir -p "$scripts" "$assets/patches" "$package" "$venv/bin" "$tmp/bin" "$tmp/runtime"
chmod 700 "$tmp/runtime"
cp "$repo/windows/scripts/install-airdrop-receiver.sh" "$repo/windows/scripts/airdrop-install-common.sh" "$scripts/"
cp "$repo/windows/airdrop/mochi_receive.py" "$assets/mochi_receive.py"
ln -s "$(command -v python3)" "$venv/bin/python"
printf '#!/usr/bin/env bash\n[[ ${MOCHI_TEST_SERVICE_ACTIVE:-0} == 1 ]]\n' > "$tmp/bin/systemctl"
printf '#!/usr/bin/env bash\nif [[ ${MOCHI_TEST_SOCKET_ACTIVE:-0} == 1 ]]; then printf "listener\\n"; fi\n' > "$tmp/bin/ss"
chmod 755 "$tmp/bin/systemctl" "$tmp/bin/ss"
export PATH="$tmp/bin:$PATH" XDG_RUNTIME_DIR="$tmp/runtime"
unset MOCHI_AIRDROP_INSTALL_LOCK_FD
installer="$scripts/install-airdrop-receiver.sh"
patches="$assets/patches"

if [[ $# == 2 ]]; then
  cp "$repo/windows/airdrop/patches/"opendrop-{receive-workspace,receive-security,stable-service-id}.patch "$patches/"
  cp -- "$1" "$package/server.py"
  cp -- "$2" "$package/config.py"
  # The supplied server is workspace-only. Restore the upstream installer
  # baseline so the first phase really covers a fresh overlay installation.
  patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-workspace.patch" >/dev/null
  if patch --batch --forward --fuzz=0 --dry-run --reverse "$package/config.py" < "$patches/opendrop-stable-service-id.patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 --reverse "$package/config.py" < "$patches/opendrop-stable-service-id.patch" >/dev/null
  fi
else
  [[ $# == 0 ]] || { echo 'Usage: setup-airdrop-receiver-test.sh [WORKSPACE_SERVER CONFIG]' >&2; exit 2; }
  # Overlapping miniature overlays keep this regression runnable from a clean
  # clone without a preinstalled OpenDrop environment or network downloads.
  printf 'WORKSPACE = False\n' > "$package/server.py"
  printf 'WORKSPACE = True\n' > "$tmp/workspace.py"
  printf 'WORKSPACE = "secured"\n' > "$tmp/security.py"
  printf 'SERVICE_ID = False\n' > "$package/config.py"
  printf 'SERVICE_ID = True\n' > "$tmp/config-after.py"
  diff -u --label a/server.py --label b/server.py "$package/server.py" "$tmp/workspace.py" > "$patches/opendrop-receive-workspace.patch" || [[ $? == 1 ]]
  diff -u --label a/server.py --label b/server.py "$tmp/workspace.py" "$tmp/security.py" > "$patches/opendrop-receive-security.patch" || [[ $? == 1 ]]
  diff -u --label a/config.py --label b/config.py "$package/config.py" "$tmp/config-after.py" > "$patches/opendrop-stable-service-id.patch" || [[ $? == 1 ]]
fi

snapshot() { sha256sum "$package/server.py" "$package/config.py" "$package/mochi_receive.py"; }
cp "$package/server.py" "$tmp/server-baseline.py"
cp "$package/config.py" "$tmp/config-baseline.py"
printf '# stale module\n' > "$package/mochi_receive.py"
snapshot > "$tmp/before"
if bash "$installer" "$venv" --verify > "$tmp/fresh-verify.log" 2>&1; then
  echo 'Fresh unpatched receiver passed verification.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/before" "$tmp/after"

# No mochi service or socket is needed for a live standalone daemon to exclude
# the installer. The lock must be checked before touching any receiver file.
mkdir -m 700 "$XDG_RUNTIME_DIR/airdropd"
exec 9>>"$XDG_RUNTIME_DIR/airdropd/lock"
flock -n 9
if bash "$installer" "$venv" > "$tmp/locked.log" 2>&1; then
  echo 'Receiver installer ignored the daemon lock.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/before" "$tmp/after"
exec 9>&-
for kind in SERVICE SOCKET; do
  if env "MOCHI_TEST_${kind}_ACTIVE=1" bash "$installer" "$venv" > "$tmp/active-$kind.log" 2>&1; then
    echo "Receiver installer ignored active $kind." >&2; exit 1
  fi
  snapshot > "$tmp/after"
  cmp "$tmp/before" "$tmp/after"
  flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true
done

bash "$installer" "$venv" > "$tmp/fresh-install.log"
bash "$installer" "$venv" --verify
cmp "$assets/mochi_receive.py" "$package/mochi_receive.py"
snapshot > "$tmp/current"
bash "$installer" "$venv" > "$tmp/repeat.log"
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"
flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true

# A current active receiver is verified without any file replacement or lock.
MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv" --verify
MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv"
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# Upgrade a workspace-only installation: the new security overlay is required,
# and existing workspace/identity patches must never be reversed by detection.
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-security.patch" >/dev/null
if bash "$installer" "$venv" --verify > "$tmp/old-security.log" 2>&1; then
  echo 'Workspace-only receiver passed security verification.' >&2; exit 1
fi
bash "$installer" "$venv" > "$tmp/security-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# Unknown sources must fail before publishing ANY staged file; retrying after
# restoring the baseline must work, and no staged directory may survive.
printf '# incompatible server\n' > "$package/server.py"
snapshot > "$tmp/incompatible"
if bash "$installer" "$venv" > "$tmp/incompatible.log" 2>&1; then
  echo 'Receiver installer accepted incompatible source.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/incompatible" "$tmp/after"
[[ -z "$(find "$package" -maxdepth 1 -name '.mochi-receiver.*' -print)" ]]
flock -n "$XDG_RUNTIME_DIR/airdropd/lock" true
cp "$tmp/server-baseline.py" "$package/server.py"
cp "$tmp/config-baseline.py" "$package/config.py"
bash "$installer" "$venv" > "$tmp/retry.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"
printf 'Receiver fresh install, strict overlay verification/order, active refusal, atomic staging and failure retry passed.\n'
