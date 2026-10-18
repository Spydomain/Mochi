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

if [[ $# == 5 ]]; then
  cp "$repo/windows/airdrop/patches/"opendrop-{receive-workspace,receive-security,receive-progress,concurrent-tls,receive-finish,stable-service-id,send-discovery,file-formats}.patch "$patches/"
  cp -- "$1" "$package/server.py"
  cp -- "$2" "$package/config.py"
  cp -- "$3" "$package/client.py"
  cp -- "$4" "$package/cli.py"
  cp -- "$5" "$package/util.py"
  if patch --batch --forward --fuzz=0 -d "$package" -p1 --dry-run --reverse < "$patches/opendrop-file-formats.patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 -d "$package" -p1 --reverse < "$patches/opendrop-file-formats.patch" >/dev/null
  fi
  # The supplied server is workspace-only. Restore the upstream installer
  # baseline so the first phase really covers a fresh overlay installation.
  patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-workspace.patch" >/dev/null
  if patch --batch --forward --fuzz=0 --dry-run --reverse "$package/config.py" < "$patches/opendrop-stable-service-id.patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 --reverse "$package/config.py" < "$patches/opendrop-stable-service-id.patch" >/dev/null
  fi
  if patch --batch --forward --fuzz=0 -d "$package" -p1 --dry-run --reverse < "$patches/opendrop-send-discovery.patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 -d "$package" -p1 --reverse < "$patches/opendrop-send-discovery.patch" >/dev/null
  fi
else
  [[ $# == 0 ]] || { echo 'Usage: setup-airdrop-receiver-test.sh [WORKSPACE_SERVER CONFIG CLIENT CLI UTIL]' >&2; exit 2; }
  # Overlapping miniature overlays keep this regression runnable from a clean
  # clone without a preinstalled OpenDrop environment or network downloads.
  printf 'WORKSPACE = False\n' > "$package/server.py"
  printf 'WORKSPACE = True\n' > "$tmp/workspace.py"
  printf 'WORKSPACE = "secured"\n' > "$tmp/security.py"
  printf 'WORKSPACE = "progress"\n' > "$tmp/progress.py"
  printf 'WORKSPACE = "tls"\n' > "$tmp/tls.py"
  printf 'WORKSPACE = "finished"\n' > "$tmp/finish.py"
  printf 'SERVICE_ID = False\n' > "$package/config.py"
  printf 'SERVICE_ID = True\n' > "$tmp/config-after.py"
  diff -u --label a/server.py --label b/server.py "$package/server.py" "$tmp/workspace.py" > "$patches/opendrop-receive-workspace.patch" || [[ $? == 1 ]]
  diff -u --label a/server.py --label b/server.py "$tmp/workspace.py" "$tmp/security.py" > "$patches/opendrop-receive-security.patch" || [[ $? == 1 ]]
  diff -u --label a/server.py --label b/server.py "$tmp/security.py" "$tmp/progress.py" > "$patches/opendrop-receive-progress.patch" || [[ $? == 1 ]]
  diff -u --label a/server.py --label b/server.py "$tmp/progress.py" "$tmp/tls.py" > "$patches/opendrop-concurrent-tls.patch" || [[ $? == 1 ]]
  diff -u --label a/server.py --label b/server.py "$tmp/tls.py" "$tmp/finish.py" > "$patches/opendrop-receive-finish.patch" || [[ $? == 1 ]]
  diff -u --label a/config.py --label b/config.py "$package/config.py" "$tmp/config-after.py" > "$patches/opendrop-stable-service-id.patch" || [[ $? == 1 ]]
  printf 'UNICAST = False\n' > "$package/client.py"
  printf 'UNICAST = True\n' > "$tmp/client-after.py"
  printf 'EXACT_RECIPIENT = False\n' > "$package/cli.py"
  printf 'EXACT_RECIPIENT = True\n' > "$tmp/cli-after.py"
  diff -u --label a/client.py --label b/client.py "$package/client.py" "$tmp/client-after.py" > "$patches/opendrop-send-discovery.patch" || [[ $? == 1 ]]
  diff -u --label a/cli.py --label b/cli.py "$package/cli.py" "$tmp/cli-after.py" >> "$patches/opendrop-send-discovery.patch" || [[ $? == 1 ]]
  printf 'FORMATS = False\n' > "$package/util.py"
  printf 'FORMATS = True\n' > "$tmp/util-after.py"
  diff -u --label a/util.py --label b/util.py "$package/util.py" "$tmp/util-after.py" > "$patches/opendrop-file-formats.patch" || [[ $? == 1 ]]
fi

snapshot() { sha256sum "$package/server.py" "$package/config.py" "$package/mochi_receive.py" "$package/client.py" "$package/cli.py" "$package/util.py"; }
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

# A format-only upgrade must be verified strictly and refuse active mutation.
patch --batch --forward --fuzz=0 -d "$package" -p1 --reverse < "$patches/opendrop-file-formats.patch" >/dev/null
snapshot > "$tmp/old-formats"
if bash "$installer" "$venv" --verify > "$tmp/old-formats.log" 2>&1; then
  echo 'Sender missing document/optional-preview support passed verification.' >&2; exit 1
fi
if MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv" > "$tmp/active-formats.log" 2>&1; then
  echo 'Format upgrade mutated an active receiver.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/old-formats" "$tmp/after"
bash "$installer" "$venv" > "$tmp/formats-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# A current active receiver is verified without any file replacement or lock.
MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv" --verify
MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv"
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# Upgrade a workspace-only installation: the new security overlay is required,
# and existing workspace/identity patches must never be reversed by detection.
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-finish.patch" >/dev/null
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-concurrent-tls.patch" >/dev/null
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-progress.patch" >/dev/null
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-security.patch" >/dev/null
if bash "$installer" "$venv" --verify > "$tmp/old-security.log" 2>&1; then
  echo 'Workspace-only receiver passed security verification.' >&2; exit 1
fi
bash "$installer" "$venv" > "$tmp/security-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# Progress-only upgrades also refuse active mutation and preserve strict layering.
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-finish.patch" >/dev/null
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-concurrent-tls.patch" >/dev/null
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-progress.patch" >/dev/null
snapshot > "$tmp/old-progress"
if bash "$installer" "$venv" --verify > "$tmp/old-progress.log" 2>&1; then
  echo 'Receiver without live progress passed verification.' >&2; exit 1
fi
if MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv" > "$tmp/active-progress.log" 2>&1; then
  echo 'Progress upgrade mutated an active receiver.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/old-progress" "$tmp/after"
bash "$installer" "$venv" > "$tmp/progress-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# A deployed receiver without only the TLS fix must upgrade without reverting
# consent/progress patches, and must not be changed during an active transfer.
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-finish.patch" >/dev/null
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-concurrent-tls.patch" >/dev/null
snapshot > "$tmp/old-tls"
if bash "$installer" "$venv" --verify > "$tmp/old-tls.log" 2>&1; then
  echo 'Receiver with blocking listener TLS passed verification.' >&2; exit 1
fi
if MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv" > "$tmp/active-tls.log" 2>&1; then
  echo 'TLS upgrade mutated an active receiver.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/old-tls" "$tmp/after"
bash "$installer" "$venv" > "$tmp/tls-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# Finishing HTTP framing is independently upgradeable and never changed live.
patch --batch --forward --fuzz=0 --reverse "$package/server.py" < "$patches/opendrop-receive-finish.patch" >/dev/null
snapshot > "$tmp/old-finish"
if bash "$installer" "$venv" --verify > "$tmp/old-finish.log" 2>&1; then
  echo 'Receiver missing HTTP-ending consumption passed verification.' >&2; exit 1
fi
if MOCHI_TEST_SERVICE_ACTIVE=1 bash "$installer" "$venv" > "$tmp/active-finish.log" 2>&1; then
  echo 'HTTP-ending upgrade mutated an active receiver.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/old-finish" "$tmp/after"
bash "$installer" "$venv" > "$tmp/finish-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# A receiver missing only the sender fix must fail verification and upgrade
# without reversing any current receive/security/identity overlay.
patch --batch --forward --fuzz=0 -d "$package" -p1 --reverse < "$patches/opendrop-send-discovery.patch" >/dev/null
if bash "$installer" "$venv" --verify > "$tmp/old-discovery.log" 2>&1; then
  echo 'Receiver without isolated sender discovery passed verification.' >&2; exit 1
fi
bash "$installer" "$venv" > "$tmp/discovery-upgrade.log"
bash "$installer" "$venv" --verify
snapshot > "$tmp/after"
cmp "$tmp/current" "$tmp/after"

# An unknown utility must not partially publish the already-staged client.
cp "$package/util.py" "$tmp/util-current.py"
printf '# incompatible format utility\n' > "$package/util.py"
snapshot > "$tmp/incompatible-util"
if bash "$installer" "$venv" > "$tmp/incompatible-util.log" 2>&1; then
  echo 'Format installer accepted an incompatible utility.' >&2; exit 1
fi
snapshot > "$tmp/after"
cmp "$tmp/incompatible-util" "$tmp/after"
cp "$tmp/util-current.py" "$package/util.py"

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
