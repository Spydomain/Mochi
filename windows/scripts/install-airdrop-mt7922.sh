#!/usr/bin/env bash
# Reproduce the tested MT7922 stack without touching a running radio session.
# Third-party source is pinned; Mochi's reviewed delta is in windows/airdrop/patches.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$here/airdrop-install-common.sh"
patches="$here/../airdrop/patches"
data="${XDG_DATA_HOME:-$HOME/.local/share}/mochi"
backend="$data/airdrop-mt7921"
owl="$data/owl"
hostapd="$data/build/mochi-hostapd-2.11"
backend_url=https://github.com/jedbillyb/airdrop-mt7921.git
backend_sha=27edf28900d6b9a948816ee5e864afe1ce245056
owl_url=https://github.com/jedbillyb/owl.git
owl_sha=832d70f815c3d4a06a02117bf0fc5e868daa1ff0
hostapd_url=https://w1.fi/releases/hostapd-2.11.tar.gz
hostapd_sum=2b3facb632fd4f65e32f4bf82a76b4b72c501f995a4f62e330219fe7aed1747a
check=0
verify=0
[[ "${1:-}" != --check ]] || check=1
[[ "${1:-}" != --verify ]] || verify=1
[[ $# -le 1 && ( $# == 0 || "$1" == --check || "$1" == --verify ) ]] || { echo 'Usage: install-airdrop-mt7922.sh [--check|--verify]' >&2; exit 2; }
log() { printf '[mochi-airdrop] %s\n' "$*"; }
die() { printf '[mochi-airdrop] ERROR: %s\n' "$*" >&2; exit 1; }

# Only this PCI ID/driver was tested. A stock backend chooses exclusive mode,
# which would disconnect a managed station; never install that on another card.
found=0
net_root=/sys/class/net
# The synthetic sysfs root is usable for read-only installer tests only.
if ((check || verify)); then net_root="${MOCHI_AIRDROP_SYSFS:-$net_root}"; fi
for nic in "$net_root"/*; do
  [[ -r "$nic/device/vendor" && -r "$nic/device/device" ]] || continue
  [[ "$(< "$nic/device/vendor")" == 0x14c3 && "$(< "$nic/device/device")" == 0x0616 ]] || continue
  [[ "$(basename "$(readlink -f "$nic/device/driver")")" == mt7921e ]] || continue
  found=1
done
if (( !found )); then log 'No supported MT7922 (14c3:0616, mt7921e); radio installation skipped.'; exit 0; fi
if ((check)); then log 'Supported MT7922 detected; one-shot receiver installation is available.'; exit 0; fi
config="${AIRDROP_CONF:-${XDG_CONFIG_HOME:-$HOME/.config}/airdrop/config}"
confirm_hook="$data/bin/mochi-airdrop-confirm"
if ((verify)); then
  bash "$here/install-airdrop-receiver.sh" "$owl/.venv-opendrop" --verify || die 'Streaming receiver verification failed.'
  airdrop_verify_consent "$config" "$confirm_hook" "$here/mochi-airdrop-confirm.sh" ||
    die 'Receiver identity or matching executable consent hook verification failed.'
  [[ -x "$backend/daemon/airdropd" && -x "$owl/.venv-opendrop/bin/opendrop" &&
     -x /usr/local/bin/airdrop-helper && -x /usr/local/bin/airdrop-owl &&
     -x /usr/local/bin/airdrop-go-hostapd ]] || die 'MT7922 backend is incomplete.'
  [[ "$(git -C "$backend" rev-parse HEAD 2>/dev/null)" == "$backend_sha" ]] &&
    git -C "$backend" diff --binary | cmp -s - "$patches/airdrop-mt7921-local.patch" ||
    die 'MT7922 backend does not match the tested patch set.'
  [[ "$(git -C "$owl" rev-parse HEAD 2>/dev/null)" == "$owl_sha" ]] &&
    git -C "$owl" diff --binary | cmp -s - "$patches/owl-local.patch" ||
    die 'OWL does not match the tested patch set.'
  cmp -s "$here/../airdrop/tests/test_awdl_rx.cpp" "$owl/tests/test_awdl_rx.cpp" ||
    die 'OWL receive regression source is missing or changed.'
  for name in opendrop-incomplete-response opendrop-verified-archive owl-ios26-action-trailer owl-tx-backpressure; do
    cmp -s "$patches/$name.patch" "$backend/patches/$name.patch" || die "AirDrop patch $name is missing or changed."
  done
  for installed in /usr/local/bin/airdrop-helper /usr/local/bin/airdrop-owl /usr/local/bin/airdrop-go-hostapd; do
    [[ ! -L "$installed" && "$(stat -c '%u %a' "$installed")" == '0 755' ]] ||
      die "Untrusted root-owned binary: $installed"
  done
  cmp -s "$backend/daemon/airdrop-helper" /usr/local/bin/airdrop-helper &&
    cmp -s "$owl/build/daemon/owl" /usr/local/bin/airdrop-owl &&
    cmp -s "$hostapd/hostapd/hostapd" /usr/local/bin/airdrop-go-hostapd ||
    die 'A root-owned radio component is missing or stale.'
  grep -q 'application/x-dvzip' "$owl/.venv-opendrop/lib"/python*/site-packages/opendrop/server.py ||
    die 'OpenDrop is missing iPhone upload support.'
  exit 0
fi
[[ "$(id -u)" != 0 ]] || die 'Run as the desktop user, not root.'
command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null 2>&1 ||
  die 'The MT7922 receiver requires a running systemd user manager.'
if ! airdrop_install_lock || ! airdrop_require_idle; then
  die 'A receiver is active. Turn AirDrop off and wait for transfers before updating radio components.'
fi
for installed in /usr/local/bin/airdrop-helper /usr/local/bin/airdrop-ble-watch \
                 /usr/local/bin/airdrop-owl /usr/local/bin/airdrop-go-hostapd; do
  if [[ -e "$installed" || -L "$installed" ]]; then
    [[ ! -L "$installed" && -f "$installed" && "$(stat -c '%u %a' "$installed")" == '0 755' ]] ||
      die "Untrusted existing radio component: $installed"
  fi
done
for cmd in git curl tar patch sha256sum cmake make cc python3 pkg-config iw ip tcpdump nmcli sudo visudo ss; do
  command -v "$cmd" >/dev/null || die "Missing build dependency: $cmd"
done
python3 -c 'import venv' || die 'Python venv support is missing.'
pkg-config --exists libnl-3.0 libnl-genl-3.0 openssl || die 'libnl and OpenSSL development files are needed for patched hostapd.'

prepare_repo() {
  local path="$1" url="$2" sha="$3" delta="$4"
  if [[ ! -e "$path" ]]; then
    git clone --recurse-submodules "$url" "$path"
    if [[ "$(git -C "$path" rev-parse HEAD)" != "$sha" ]]; then
      git -C "$path" fetch --depth 1 origin "$sha"
      git -C "$path" switch --detach "$sha"
      git -C "$path" submodule update --init --recursive
    fi
  fi
  [[ -d "$path/.git" && "$(git -C "$path" remote get-url origin)" == "$url" ]] ||
    die "Unknown or modified source checkout: $path"
  [[ "$(git -C "$path" rev-parse HEAD)" == "$sha" ]] ||
    die "Source revision changed in $path; review before updating it."
  if git -C "$path" apply --reverse --check "$delta" 2>/dev/null; then
    log "Tested patch already applied to $path"
  elif [[ "$path" == "$owl" &&
          "$(git -C "$path" diff --binary | sha256sum | cut -d' ' -f1)" == 7dd07e0cb289b732aedd744e4ef61d54ac4643a12bc4390862e13fb5bae3166a ]] &&
       git -C "$path" apply --check "$patches/owl-discovery-upgrade-v1.patch"; then
    git -C "$path" apply "$patches/owl-discovery-upgrade-v1.patch"
  elif [[ "$path" == "$backend" &&
          "$(git -C "$path" diff --binary | sha256sum | cut -d' ' -f1)" == 16ab16d8f3459c9edc9b93525e98d7fa614894e43ccc5063447f42f51d45717b ]] &&
       git -C "$path" apply --check "$patches/airdrop-mt7921-upgrade-v2.patch"; then
    git -C "$path" apply "$patches/airdrop-mt7921-upgrade-v2.patch"
  elif [[ "$path" == "$backend" &&
          "$(git -C "$path" diff --binary | sha256sum | cut -d' ' -f1)" == bb5c8a5f308361d765ae32d1ee30624830372340ecc36794422e13f12cb0446a ]] &&
       git -C "$path" apply --check "$patches/airdrop-mt7921-upgrade-v1.patch"; then
    # Only the exact previously shipped tree may be upgraded in place.
    git -C "$path" apply "$patches/airdrop-mt7921-upgrade-v1.patch"
    git -C "$path" apply "$patches/airdrop-mt7921-upgrade-v2.patch"
  elif git -C "$path" apply --check "$delta" 2>/dev/null; then
    [[ -z "$(git -C "$path" diff --binary)" ]] || die "Other local edits in $path; preserved."
    git -C "$path" apply "$delta"
  else
    die "Unknown edits or incompatible source at $path; preserved."
  fi
  git -C "$path" diff --binary | cmp -s - "$delta" ||
    die "Unexpected source changes in $path; preserved."
}

mkdir -p "$data"
prepare_repo "$backend" "$backend_url" "$backend_sha" "$patches/airdrop-mt7921-local.patch"
prepare_repo "$owl" "$owl_url" "$owl_sha" "$patches/owl-local.patch"
# CMake checks source existence even when building only the owl target. This
# regression used to exist only as an untracked file on the development host.
owl_test="$owl/tests/test_awdl_rx.cpp"
if [[ -e "$owl_test" ]]; then
  cmp -s "$here/../airdrop/tests/test_awdl_rx.cpp" "$owl_test" || die 'Existing OWL receive test differs; preserved.'
else
  install -m 644 "$here/../airdrop/tests/test_awdl_rx.cpp" "$owl_test"
fi
for name in opendrop-incomplete-response opendrop-verified-archive owl-ios26-action-trailer owl-tx-backpressure; do
  target="$backend/patches/$name.patch"
  if [[ -e "$target" ]]; then
    cmp -s "$patches/$name.patch" "$target" || die "Existing $target differs; preserved."
  else
    install -m 644 "$patches/$name.patch" "$target"
  fi
done

# Never let the upstream installer's default 'exclusive' disconnect Wi-Fi.
if [[ ! -e "$config" ]]; then
  install -d -m 700 "$(dirname "$config")"
  (umask 077; printf '%s\n' '# Mochi: keep the existing Wi-Fi station connected.' 'AIRDROP_MODE="${AIRDROP_MODE:-shared}"' > "$config")
fi
# airdrop sources this file and defaults CONFIRM to its own notification-based
# hook. On a desktop with no matching notifier that hook declines in under a
# second with nothing shown anywhere, so every transfer was silently refused
# while Mochi's island prompt sat unused. Point the receiver at Mochi's hook.
# An AIRDROP_CONFIRM the user set themselves is left alone.
[[ -x "$confirm_hook" ]] || die "Mochi's AirDrop consent hook is missing: $confirm_hook"
# OpenDrop otherwise changes its advertised service ID on every restart. iOS
# can retain the old entry as a second Mochi tile. Keep one 6-byte ID in the
# existing per-user AirDrop config across both app and backend updates.
airdrop_config normalize "$config" "$confirm_hook" || die 'Receiver config was preserved; review its consent hook and identity.'

# Build the P2P-GO hostapd extension from a checksum-verified upstream source.
# This never loads modules, brings up an interface or changes Wi-Fi settings.
[[ ! -e "$hostapd" || -d "$hostapd" ]] || die "Unexpected hostapd build path: $hostapd"
if [[ ! -d "$hostapd" ]]; then
  mkdir -p "$(dirname "$hostapd")"
  staging="$(mktemp -d "$(dirname "$hostapd")/.mochi-hostapd.XXXXXXXX")"
  trap 'rm -rf -- "$staging"' EXIT
  curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "$hostapd_url" -o "$staging/hostapd.tar.gz"
  printf '%s  %s\n' "$hostapd_sum" "$staging/hostapd.tar.gz" | sha256sum -c --status ||
    die 'hostapd source checksum mismatch.'
  tar -xzf "$staging/hostapd.tar.gz" -C "$staging"
  mv -- "$staging/hostapd-2.11" "$hostapd"
  rm -f -- "$staging/hostapd.tar.gz"
  rmdir -- "$staging"
  trap - EXIT
fi
if patch --batch --forward --fuzz=0 -d "$hostapd" -p1 --dry-run --reverse < "$patches/hostapd-p2p-go-iftype.patch" >/dev/null 2>&1; then
  :
elif patch --batch --forward --fuzz=0 -d "$hostapd" -p1 --dry-run < "$patches/hostapd-p2p-go-iftype.patch" >/dev/null 2>&1; then
  patch --batch --forward --fuzz=0 -d "$hostapd" -p1 < "$patches/hostapd-p2p-go-iftype.patch"
else
  die "Unknown hostapd source changes in $hostapd; preserved."
fi
if [[ ! -f "$hostapd/hostapd/.config" ]]; then
  cp "$hostapd/hostapd/defconfig" "$hostapd/hostapd/.config"
  # hostapd 2.11 requires libnl3 when built with nl80211.
  grep -q '^CONFIG_LIBNL32=y$' "$hostapd/hostapd/.config" ||
    printf '\nCONFIG_LIBNL32=y\n' >> "$hostapd/hostapd/.config"
fi
make -C "$hostapd/hostapd" -j"$(nproc)" hostapd
[[ -x "$hostapd/hostapd/hostapd" ]] || die 'Patched hostapd did not build.'
grep -aq 'HOSTAPD_P2P_GO=1' "$hostapd/hostapd/hostapd" || die 'Built hostapd lacks the P2P-GO patch.'

# Upstream installs only root-owned fixed helper paths, validates sudoers with
# visudo and builds the pinned OWL/OpenDrop receiver. No radio is started here.
OWL_DIR="$owl" bash "$backend/install.sh" --yes
bash "$here/install-airdrop-receiver.sh" "$owl/.venv-opendrop"
[[ -x "$owl/.venv-opendrop/bin/opendrop" ]] || die 'Patched OpenDrop is missing.'
grep -q 'application/x-dvzip' "$owl/.venv-opendrop/lib"/python*/site-packages/opendrop/server.py ||
  die 'OpenDrop did not receive the iPhone upload patches.'

if [[ -e /usr/local/bin/airdrop-go-hostapd ]]; then
  [[ ! -L /usr/local/bin/airdrop-go-hostapd && "$(stat -c '%u' /usr/local/bin/airdrop-go-hostapd)" == 0 ]] ||
    die 'Refusing to replace an untrusted hostapd installation.'
fi
if ! cmp -s "$hostapd/hostapd/hostapd" /usr/local/bin/airdrop-go-hostapd; then
  sudo install -o root -g root -m 755 "$hostapd/hostapd/hostapd" /usr/local/bin/.airdrop-go-hostapd.mochi
  sudo mv -f -- /usr/local/bin/.airdrop-go-hostapd.mochi /usr/local/bin/airdrop-go-hostapd
fi
cmp -s "$hostapd/hostapd/hostapd" /usr/local/bin/airdrop-go-hostapd || die 'Patched hostapd did not install.'
bash "$here/install-airdrop-coexistence.sh" "$backend" || die 'Wi-Fi coexistence helper update failed.'
log 'Pinned receiver, patched hostapd and Wi-Fi coexistence installed; radio remains off.'
