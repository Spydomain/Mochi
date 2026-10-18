#!/usr/bin/env bash
# Check distro selection without installing packages or building the app.
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
for command_name in pacman apt-get dnf zypper; do
  ln -s /usr/bin/true "$test_dir/bin/$command_name"
done

check_distro() {
  local os_id="$1" os_like="$2" expected="$3" output
  printf 'ID=%s\nID_LIKE="%s"\nPRETTY_NAME="Test %s"\n' "$os_id" "$os_like" "$os_id" > "$test_dir/os-release"
  output="$(MOCHI_OS_RELEASE_FILE="$test_dir/os-release" PATH="$test_dir/bin:$PATH" "$repo_dir/mochi-full-setup.sh" --check 2>&1)" || true
  [[ "$output" == *"using $expected."* ]] || {
    printf 'Wrong package manager for %s: %s\n' "$os_id" "$output" >&2
    return 1
  }
}

check_distro cachyos arch pacman
check_distro linuxmint ubuntu apt-get
check_distro fedora '' dnf
check_distro opensuse-tumbleweed suse zypper

# Inspect complete install package requests, not just the detected manager.
# These functions never invoke a real package manager in this test.
source <(sed -n '/^install_system_dependencies() {/,/^}/p' "$repo_dir/mochi-full-setup.sh")
missing_packages() { printf '%s\n' "$@"; }
has_mt7922() { return 0; }
run_as_root() { printf '%s\n' "$@" >> "$test_dir/packages"; }
log() { :; }
CHECK_ONLY=0
for PACKAGE_MANAGER in pacman apt-get dnf zypper; do
  NO_AIRDROP=0
  : > "$test_dir/packages"
  install_system_dependencies
  for required in cmake iw tcpdump bluez; do
    grep -Fxq "$required" "$test_dir/packages" || { echo "Missing $required for $PACKAGE_MANAGER" >&2; exit 1; }
  done
  case "$PACKAGE_MANAGER" in
    pacman) required=(networkmanager python-dbus python-gobject libpcap libarchive) ;;
    apt-get) required=(network-manager python3-venv python3-dbus python3-gi gir1.2-gtk-3.0 libpcap-dev libarchive-dev) ;;
    dnf) required=(NetworkManager python3-dbus python3-gobject libpcap-devel libarchive-devel) ;;
    zypper) required=(NetworkManager python3-dbus-python python3-gobject typelib-1_0-Gtk-3_0 libpcap-devel libarchive-devel) ;;
  esac
  for package in "${required[@]}"; do
    grep -Fxq "$package" "$test_dir/packages" || { echo "Missing $package for $PACKAGE_MANAGER" >&2; exit 1; }
  done
  NO_AIRDROP=1
  : > "$test_dir/packages"
  install_system_dependencies
  python_package=python3
  [[ "$PACKAGE_MANAGER" != pacman ]] || python_package=python
  grep -Fxq "$python_package" "$test_dir/packages" || {
    echo "Missing standalone-uninstaller Python dependency for $PACKAGE_MANAGER" >&2; exit 1
  }
  xz_package=xz
  [[ "$PACKAGE_MANAGER" != apt-get ]] || xz_package=xz-utils
  for package in tar "$xz_package"; do
    grep -Fxq "$package" "$test_dir/packages" || {
      echo "Missing Node archive dependency $package for $PACKAGE_MANAGER" >&2; exit 1
    }
  done
  if grep -Fxq bluez "$test_dir/packages"; then
    echo "--no-airdrop still provisions radio dependencies for $PACKAGE_MANAGER" >&2; exit 1
  fi
done

printf 'ID=unsupported\nPRETTY_NAME="Unsupported Test"\n' > "$test_dir/os-release"
if MOCHI_OS_RELEASE_FILE="$test_dir/os-release" PATH="$test_dir/bin:$PATH" "$repo_dir/mochi-full-setup.sh" --check > "$test_dir/unsupported.log" 2>&1; then
  printf 'Unsupported distribution was accepted.\n' >&2
  exit 1
fi
grep -Fq 'Unsupported Linux distribution' "$test_dir/unsupported.log"
printf 'Linux distribution selection checks passed.\n'
