#!/usr/bin/env bash
# Opt-in integration check: install from a clean local clone into isolated XDG paths.
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d -p "$HOME" mochi-setup-smoke.XXXXXX)"
trap 'rm -rf -- "$test_dir"' EXIT

git clone --quiet --local "$repo_dir" "$test_dir/mochi"
mkdir -p "$test_dir/bin" "$test_dir/config" "$test_dir/data"
ln -s "$repo_dir/tests/fixtures/setup-bin/node" "$test_dir/bin/node"
ln -s "$repo_dir/tests/fixtures/setup-bin/npm" "$test_dir/bin/npm"
ln -s "$repo_dir/tests/fixtures/setup-bin/opencode" "$test_dir/bin/opencode"
ln -s "$repo_dir/tests/fixtures/setup-bin/systemctl" "$test_dir/bin/systemctl"

export XDG_CONFIG_HOME="$test_dir/config"
export XDG_DATA_HOME="$test_dir/data"
export XDG_CURRENT_DESKTOP=niri
export NIRI_SOCKET="$test_dir/niri-socket"
export PATH="$test_dir/bin:$PATH"

if "$test_dir/mochi/mochi-full-setup.sh" --check; then
  printf 'Expected --check to report the simulated old Node.js.\n' >&2
  exit 1
fi

"$test_dir/mochi/mochi-full-setup.sh" --no-launch

test -x "$test_dir/data/mochi/bin/mochi"
test -x "$test_dir/data/mochi/bin/mochi-hook"
test -f "$test_dir/config/mochi/settings.json"
test -f "$test_dir/config/opencode/plugins/mochi.js"
test -f "$test_dir/config/systemd/user/mochi-app.service"
test -f "$test_dir/config/systemd/user/mochi-opencode-cleanup.timer"
test -x "$test_dir/data/mochi/toolchain/node-v24.21.0-linux-x64/bin/node" ||
  test -x "$test_dir/data/mochi/toolchain/node-v24.21.0-linux-arm64/bin/node"

printf 'Fresh-clone setup completed in isolated XDG directories.\n'
