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
# An installed v1 tree upgrades only through the reviewed, exact patch delta.
git -C "$tmp/airdrop-mt7921" apply --reverse "$patches/airdrop-mt7921-upgrade-v1.patch"
[[ "$(git -C "$tmp/airdrop-mt7921" diff --binary | sha256sum | cut -d' ' -f1)" == bb5c8a5f308361d765ae32d1ee30624830372340ecc36794422e13f12cb0446a ]]
git -C "$tmp/airdrop-mt7921" apply --check "$patches/airdrop-mt7921-upgrade-v1.patch"
git -C "$tmp/airdrop-mt7921" apply "$patches/airdrop-mt7921-upgrade-v1.patch"
git -C "$tmp/airdrop-mt7921" diff --binary | cmp - "$patches/airdrop-mt7921-local.patch"
installed_opendrop="${XDG_DATA_HOME:-$HOME/.local/share}/mochi/owl/.venv-opendrop"
opendrop_source="$(find "$installed_opendrop" -path '*/site-packages/opendrop/server.py' -print -quit 2>/dev/null || true)"
if [[ -n "$opendrop_source" ]]; then
  mkdir -p "$tmp/opendrop/opendrop"
  cp "$opendrop_source" "$tmp/opendrop/opendrop/server.py"
  # An already-installed receiver carries this patch. Applying it twice would
  # reverse it, so accept whichever state the copy is actually in.
  if ! patch --batch -d "$tmp/opendrop" -p1 --dry-run --reverse \
      < "$patches/opendrop-verified-archive.patch" >/dev/null 2>&1; then
    patch --batch -d "$tmp/opendrop" -p1 < "$patches/opendrop-verified-archive.patch" >/dev/null
  fi
  python3 "$repo/tests/opendrop-archive-test.py" "$tmp/opendrop/opendrop/server.py"
fi
if [[ -n "${MOCHI_TEST_HOSTAPD_TARBALL:-}" ]]; then
  printf '%s  %s\n' '2b3facb632fd4f65e32f4bf82a76b4b72c501f995a4f62e330219fe7aed1747a' \
    "$MOCHI_TEST_HOSTAPD_TARBALL" | sha256sum -c --status
  tar -xzf "$MOCHI_TEST_HOSTAPD_TARBALL" -C "$tmp"
  patch --batch -d "$tmp/hostapd-2.11" -p1 < "$patches/hostapd-p2p-go-iftype.patch"
  patch --batch -d "$tmp/hostapd-2.11" -p1 --dry-run --reverse \
    < "$patches/hostapd-p2p-go-iftype.patch" >/dev/null
fi
printf 'MT7922 hardware gates and clean-source patch reproduction passed.\n'
