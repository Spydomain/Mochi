#!/usr/bin/env bash
# No sudo or radio changes: exercise hardware gates and recreate the pinned
# third-party patch trees in isolated checkouts.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_parent="${TMPDIR:-/tmp}"
[[ ! -d /tmp/opencode ]] || tmp_parent=/tmp/opencode
tmp="$(mktemp -d -p "$tmp_parent" mochi-stack-test.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
script="$repo/windows/scripts/install-airdrop-mt7922.sh"
patches="$repo/windows/airdrop/patches"

MOCHI_AIRDROP_SYSFS="$tmp/empty" bash "$script" --check > "$tmp/unsupported.log"
grep -q 'skipped' "$tmp/unsupported.log"
mkdir -p "$tmp/net/wlan0/device" "$tmp/drivers/mt7921e"
printf '0x14c3\n' > "$tmp/net/wlan0/device/vendor"
printf '0x0616\n' > "$tmp/net/wlan0/device/device"
ln -s "$tmp/drivers/mt7921e" "$tmp/net/wlan0/device/driver"
MOCHI_AIRDROP_SYSFS="$tmp/net" bash "$script" --check > "$tmp/supported.log"
grep -q 'Supported MT7922' "$tmp/supported.log"
if MOCHI_AIRDROP_SYSFS="$tmp/net" XDG_DATA_HOME="$tmp/isolated" bash "$script" --verify > "$tmp/verify.log" 2>&1; then
  printf 'Incomplete backend passed verification.\n' >&2
  exit 1
fi

# Clone only committed revisions; local working-tree edits must come solely
# from the tested patch bundle, not from the machine running this test.
for item in 'airdrop-mt7921:airdrop-mt7921-local' 'owl:owl-local'; do
  name="${item%%:*}"
  delta="${item#*:}"
  upstream="${XDG_DATA_HOME:-$HOME/.local/share}/mochi/$name"
  if [[ ! -d "$upstream/.git" ]]; then
    printf 'No local %s checkout; patch recreation test skipped (hardware-gate tests passed).\n' "$name"
    exit 0
  fi
  git clone --quiet --no-hardlinks "$upstream" "$tmp/$name"
  git -C "$tmp/$name" apply --check "$patches/$delta.patch"
  git -C "$tmp/$name" apply "$patches/$delta.patch"
  git -C "$tmp/$name" diff --binary | cmp - "$patches/$delta.patch"
  git -C "$tmp/$name" apply --reverse --check "$patches/$delta.patch"
done
install -m 644 "$repo/windows/airdrop/tests/test_awdl_rx.cpp" "$tmp/owl/tests/test_awdl_rx.cpp"
git -C "$tmp/owl" apply --reverse "$patches/owl-discovery-upgrade-v1.patch"
[[ "$(git -C "$tmp/owl" diff --binary | sha256sum | cut -d' ' -f1)" == 7dd07e0cb289b732aedd744e4ef61d54ac4643a12bc4390862e13fb5bae3166a ]]
git -C "$tmp/owl" apply --check "$patches/owl-discovery-upgrade-v1.patch"
git -C "$tmp/owl" apply "$patches/owl-discovery-upgrade-v1.patch"
git -C "$tmp/owl" diff --binary | cmp - "$patches/owl-local.patch"
# Installed trees upgrade only through reviewed, exact patch deltas.
git -C "$tmp/airdrop-mt7921" apply --reverse "$patches/airdrop-mt7921-upgrade-v2.patch"
[[ "$(git -C "$tmp/airdrop-mt7921" diff --binary | sha256sum | cut -d' ' -f1)" == 16ab16d8f3459c9edc9b93525e98d7fa614894e43ccc5063447f42f51d45717b ]]
git -C "$tmp/airdrop-mt7921" apply --reverse "$patches/airdrop-mt7921-upgrade-v1.patch"
[[ "$(git -C "$tmp/airdrop-mt7921" diff --binary | sha256sum | cut -d' ' -f1)" == bb5c8a5f308361d765ae32d1ee30624830372340ecc36794422e13f12cb0446a ]]
git -C "$tmp/airdrop-mt7921" apply --check "$patches/airdrop-mt7921-upgrade-v1.patch"
git -C "$tmp/airdrop-mt7921" apply "$patches/airdrop-mt7921-upgrade-v1.patch"
git -C "$tmp/airdrop-mt7921" apply --check "$patches/airdrop-mt7921-upgrade-v2.patch"
git -C "$tmp/airdrop-mt7921" apply "$patches/airdrop-mt7921-upgrade-v2.patch"
git -C "$tmp/airdrop-mt7921" diff --binary | cmp - "$patches/airdrop-mt7921-local.patch"
# Exercise owl-start without hardware or root. Only awdl0 may get a short queue;
# a queue configuration failure must not be reported as a successful radio.
python3 "$repo/tests/airdrop-tap-queue-test.py" "$tmp/airdrop-mt7921/daemon/airdrop-helper"
python3 "$repo/tests/airdrop-ack-filter-test.py" "$tmp/airdrop-mt7921/daemon/airdrop-helper"
bash "$repo/tests/airdrop-wake-lifecycle-test.sh" "$tmp/airdrop-mt7921/daemon/airdropd"
installed_opendrop="${XDG_DATA_HOME:-$HOME/.local/share}/mochi/owl/.venv-opendrop"
opendrop_source="$(find "$installed_opendrop" -path '*/site-packages/opendrop/server.py' -print -quit 2>/dev/null || true)"
if [[ -n "$opendrop_source" ]]; then
  mkdir -p "$tmp/opendrop/opendrop"
  cp "$opendrop_source" "$tmp/opendrop/opendrop/server.py"
  security_patch="$patches/opendrop-receive-security.patch"
  progress_patch="$patches/opendrop-receive-progress.patch"
  tls_patch="$patches/opendrop-concurrent-tls.patch"
  finish_patch="$patches/opendrop-receive-finish.patch"
  if patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$finish_patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --reverse < "$finish_patch" >/dev/null
  fi
  if patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$tls_patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --reverse < "$tls_patch" >/dev/null
  fi
  if patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$progress_patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --reverse < "$progress_patch" >/dev/null
  fi
  # Security overlaps workspace hunks, so unwind newest-first on this copy.
  if patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse \
      < "$security_patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --reverse \
      < "$security_patch" >/dev/null
  fi
  # Restore the pre-workspace baseline to prove both overlay directions.
  if patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse \
      < "$patches/opendrop-receive-workspace.patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --reverse \
      < "$patches/opendrop-receive-workspace.patch" >/dev/null
  fi
  # An already-installed receiver carries this patch. Applying it twice would
  # reverse it, so accept whichever state the copy is actually in.
  if ! patch --batch --forward --fuzz=0 -d "$tmp/opendrop" -p1 --dry-run --reverse \
      < "$patches/opendrop-verified-archive.patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 -d "$tmp/opendrop" -p1 < "$patches/opendrop-verified-archive.patch" >/dev/null
  fi
  python3 "$repo/tests/opendrop-archive-test.py" "$tmp/opendrop/opendrop/server.py"
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" < "$patches/opendrop-receive-workspace.patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse \
      < "$patches/opendrop-receive-workspace.patch" >/dev/null
  python3 "$repo/tests/opendrop-archive-test.py" "$tmp/opendrop/opendrop/server.py"
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" < "$security_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$security_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" < "$progress_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$progress_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" < "$tls_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$tls_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" < "$finish_patch" >/dev/null
  patch --batch --forward --fuzz=0 "$tmp/opendrop/opendrop/server.py" --dry-run --reverse < "$finish_patch" >/dev/null
  "$installed_opendrop/bin/python" "$repo/tests/airdrop-tls-test.py" "$tmp/opendrop/opendrop/server.py"
  "$installed_opendrop/bin/python" "$repo/tests/airdrop-receive-test.py" "$tmp/opendrop/opendrop/server.py" --no-network
  cp "$(dirname "$opendrop_source")/config.py" "$tmp/opendrop/opendrop/config.py"
  identity_patch="$patches/opendrop-stable-service-id.patch"
  if patch --batch --forward -d "$tmp/opendrop/opendrop" -p1 --fuzz=0 --dry-run --reverse \
      < "$identity_patch" >/dev/null 2>&1; then
    patch --batch --forward -d "$tmp/opendrop/opendrop" -p1 --fuzz=0 --reverse < "$identity_patch" >/dev/null
  fi
  patch --batch --forward -d "$tmp/opendrop/opendrop" -p1 --fuzz=0 < "$identity_patch" >/dev/null
  patch --batch --forward -d "$tmp/opendrop/opendrop" -p1 --fuzz=0 --dry-run --reverse < "$identity_patch" >/dev/null
  "$installed_opendrop/bin/python" "$repo/tests/airdrop-identity-test.py" "$tmp/opendrop/opendrop/config.py"
  for name in client cli util; do
    cp "$(dirname "$opendrop_source")/$name.py" "$tmp/opendrop/opendrop/$name.py"
  done
  formats_patch="$patches/opendrop-file-formats.patch"
  if patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 --dry-run --reverse \
      < "$formats_patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 --reverse < "$formats_patch" >/dev/null
  fi
  patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 < "$formats_patch" >/dev/null
  patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 --dry-run --reverse < "$formats_patch" >/dev/null
  "$installed_opendrop/bin/python" "$repo/tests/airdrop-file-formats-test.py" \
    "$tmp/opendrop/opendrop/client.py" "$tmp/opendrop/opendrop/util.py"
  discovery_patch="$patches/opendrop-send-discovery.patch"
  if patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 --dry-run --reverse \
      < "$discovery_patch" >/dev/null 2>&1; then
    patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 --reverse < "$discovery_patch" >/dev/null
  fi
  patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 < "$discovery_patch" >/dev/null
  patch --batch --forward --fuzz=0 -d "$tmp/opendrop/opendrop" -p1 --dry-run --reverse < "$discovery_patch" >/dev/null
  "$installed_opendrop/bin/python" "$repo/tests/airdrop-discovery-test.py" \
    "$tmp/opendrop/opendrop/client.py" "$tmp/opendrop/opendrop/cli.py"
  cp "$tmp/opendrop/opendrop/server.py" "$tmp/workspace-server.py"
  patch --batch --forward --fuzz=0 --reverse "$tmp/workspace-server.py" < "$finish_patch" >/dev/null
  patch --batch --forward --fuzz=0 --reverse "$tmp/workspace-server.py" < "$tls_patch" >/dev/null
  patch --batch --forward --fuzz=0 --reverse "$tmp/workspace-server.py" < "$progress_patch" >/dev/null
  patch --batch --forward --fuzz=0 --reverse "$tmp/workspace-server.py" < "$security_patch" >/dev/null
  bash "$repo/tests/setup-airdrop-receiver-test.sh" "$tmp/workspace-server.py" \
    "$tmp/opendrop/opendrop/config.py" "$tmp/opendrop/opendrop/client.py" "$tmp/opendrop/opendrop/cli.py" "$tmp/opendrop/opendrop/util.py"
fi
if [[ -n "${MOCHI_TEST_HOSTAPD_TARBALL:-}" ]]; then
  printf '%s  %s\n' '2b3facb632fd4f65e32f4bf82a76b4b72c501f995a4f62e330219fe7aed1747a' \
    "$MOCHI_TEST_HOSTAPD_TARBALL" | sha256sum -c --status
  tar -xzf "$MOCHI_TEST_HOSTAPD_TARBALL" -C "$tmp"
  patch --batch --forward --fuzz=0 -d "$tmp/hostapd-2.11" -p1 < "$patches/hostapd-p2p-go-iftype.patch"
  patch --batch --forward --fuzz=0 -d "$tmp/hostapd-2.11" -p1 --dry-run --reverse \
    < "$patches/hostapd-p2p-go-iftype.patch" >/dev/null
fi
printf 'MT7922 hardware gates and clean-source patch reproduction passed.\n'
