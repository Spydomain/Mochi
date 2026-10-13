#!/usr/bin/env bash
# Check distro selection without installing packages or building the app.
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
for command_name in apt-get dnf zypper; do
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

printf 'ID=unsupported\nPRETTY_NAME="Unsupported Test"\n' > "$test_dir/os-release"
if MOCHI_OS_RELEASE_FILE="$test_dir/os-release" PATH="$test_dir/bin:$PATH" "$repo_dir/mochi-full-setup.sh" --check > "$test_dir/unsupported.log" 2>&1; then
  printf 'Unsupported distribution was accepted.\n' >&2
  exit 1
fi
grep -Fq 'Unsupported Linux distribution' "$test_dir/unsupported.log"
printf 'Linux distribution selection checks passed.\n'
