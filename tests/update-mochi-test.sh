#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT

git init --bare --quiet --initial-branch=main "$test_dir/remote.git"
git init --quiet --initial-branch=main "$test_dir/work"
git -C "$test_dir/work" config user.name 'Mochi test'
git -C "$test_dir/work" config user.email 'test@example.invalid'
install -m 755 "$repo_dir/update-mochi.sh" "$test_dir/work/update-mochi.sh"
mkdir -p "$test_dir/work/windows/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' > "$test_dir/work/windows/scripts/install-airdrop-mt7922.sh"
printf '#!/usr/bin/env bash\n# mocked AirDrop consent\n' > "$test_dir/work/windows/scripts/mochi-airdrop-confirm.sh"
printf '#!/usr/bin/env bash\n# mocked cleanup\n' > "$test_dir/work/windows/scripts/cleanup-opencode-sessions.sh"
printf '#!/usr/bin/env bash\nset -euo pipefail\n[[ "${MOCHI_TEST_FAIL_SETUP:-0}" != 1 ]] || exit 42\nprintf "updated\\n" >> "$MOCHI_TEST_MARKER"\nmkdir -p "$XDG_DATA_HOME/mochi/bin"\ninstall -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi"\ninstall -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi-hook"\ninstall -m 755 "$(dirname "$0")/windows/scripts/mochi-airdrop-confirm.sh" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-confirm"\ninstall -m 755 "$(dirname "$0")/windows/scripts/cleanup-opencode-sessions.sh" "$XDG_DATA_HOME/mochi/bin/cleanup-opencode-sessions"\ngit -C "$(dirname "$0")" rev-parse HEAD > "$XDG_DATA_HOME/mochi/installed-revision"\n' > "$test_dir/work/mochi-full-setup.sh"
chmod 755 "$test_dir/work/mochi-full-setup.sh"
git -C "$test_dir/work" add .
git -C "$test_dir/work" commit --quiet -m initial
git -C "$test_dir/work" remote add origin "$test_dir/remote.git"
git -C "$test_dir/remote.git" fetch --quiet "$test_dir/work" main:main

export MOCHI_UPDATE_REMOTE="$test_dir/remote.git"
export MOCHI_TEST_MARKER="$test_dir/installed.log"
export XDG_DATA_HOME="$test_dir/data"
mkdir -p "$XDG_DATA_HOME/mochi/bin"
install -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi"
install -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi-hook"
install -m 755 "$test_dir/work/windows/scripts/mochi-airdrop-confirm.sh" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-confirm"
install -m 755 "$test_dir/work/windows/scripts/cleanup-opencode-sessions.sh" "$XDG_DATA_HOME/mochi/bin/cleanup-opencode-sessions"
git -C "$test_dir/work" rev-parse HEAD > "$XDG_DATA_HOME/mochi/installed-revision"

# No upstream change: no setup invocation and no worktree mutation.
output="$("$test_dir/work/update-mochi.sh")"
[[ "$output" == *'No updates available'* ]]
[[ ! -e "$MOCHI_TEST_MARKER" ]]

git clone --quiet --branch main "$test_dir/remote.git" "$test_dir/publisher"
git -C "$test_dir/publisher" config user.name 'Mochi test'
git -C "$test_dir/publisher" config user.email 'test@example.invalid'
printf 'new upstream commit\n' > "$test_dir/publisher/CHANGELOG-test"
git -C "$test_dir/publisher" add .
git -C "$test_dir/publisher" commit --quiet -m update
git -C "$test_dir/remote.git" fetch --quiet "$test_dir/publisher" main:main

# Local edits must survive an available upstream update unchanged.
printf 'keep me\n' > "$test_dir/work/local-note"
before="$(git -C "$test_dir/work" rev-parse HEAD)"
if "$test_dir/work/update-mochi.sh" > "$test_dir/dirty.log" 2>&1; then
  printf 'Updater accepted a dirty checkout.\n' >&2
  exit 1
fi
[[ "$(git -C "$test_dir/work" rev-parse HEAD)" == "$before" ]]
[[ ! -e "$MOCHI_TEST_MARKER" ]]
mv -- "$test_dir/work/local-note" "$test_dir/local-note"

"$test_dir/work/update-mochi.sh" > "$test_dir/updated.log"
[[ "$(git -C "$test_dir/work" rev-parse HEAD)" == "$(git -C "$test_dir/publisher" rev-parse HEAD)" ]]
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 1 ]]

# Repeating it must not rerun setup.
"$test_dir/work/update-mochi.sh" > "$test_dir/repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 1 ]]

# A missing successful-install marker repairs the installation, even when
# GitHub has no newer commit. A second run must again be a no-op.
mv -- "$XDG_DATA_HOME/mochi/installed-revision" "$test_dir/old-installed-revision"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 2 ]]
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 2 ]]

# A previous installation with a missing or stale consent hook must be
# repaired even with no new upstream commit and a matching revision marker.
printf 'old hook\n' > "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-confirm"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-hook.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 3 ]]
cmp "$test_dir/work/windows/scripts/mochi-airdrop-confirm.sh" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-confirm"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-hook-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 3 ]]
rm -- "$XDG_DATA_HOME/mochi/bin/mochi-hook"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-relay.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 4 ]]
test -x "$XDG_DATA_HOME/mochi/bin/mochi-hook"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-relay-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 4 ]]

# A build failure after fast-forward must be retried on the next invocation.
printf 'second upstream commit\n' > "$test_dir/publisher/CHANGELOG-test"
git -C "$test_dir/publisher" add .
git -C "$test_dir/publisher" commit --quiet -m second-update
git -C "$test_dir/remote.git" fetch --quiet "$test_dir/publisher" main:main
before_install="$(< "$XDG_DATA_HOME/mochi/installed-revision")"
if MOCHI_TEST_FAIL_SETUP=1 "$test_dir/work/update-mochi.sh" > "$test_dir/failed-setup.log" 2>&1; then
  printf 'Updater accepted a failed setup.\n' >&2
  exit 1
fi
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$before_install" ]]
"$test_dir/work/update-mochi.sh" > "$test_dir/recovered.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 5 ]]
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$(git -C "$test_dir/work" rev-parse HEAD)" ]]
# Local commits ahead of upstream must not prevent repair or alter history.
printf 'local commit\n' > "$test_dir/work/local-committed"
git -C "$test_dir/work" add local-committed
git -C "$test_dir/work" commit --quiet -m local
ahead="$(git -C "$test_dir/work" rev-parse HEAD)"
rm -- "$XDG_DATA_HOME/mochi/installed-revision"
"$test_dir/work/update-mochi.sh" > "$test_dir/ahead-repair.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 6 ]]
[[ "$(git -C "$test_dir/work" rev-parse HEAD)" == "$ahead" ]]
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$ahead" ]]
"$test_dir/work/update-mochi.sh" > "$test_dir/ahead-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 6 ]]
rm -- "$XDG_DATA_HOME/mochi/bin/mochi-hook"
"$test_dir/work/update-mochi.sh" > "$test_dir/ahead-relay.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 7 ]]
printf 'dirty ahead checkout\n' > "$test_dir/work/local-note"
if "$test_dir/work/update-mochi.sh" > "$test_dir/ahead-dirty.log" 2>&1; then
  printf 'Updater accepted dirty local-ahead source.\n' >&2
  exit 1
fi
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 7 ]]
[[ "$(< "$test_dir/work/local-note")" == 'dirty ahead checkout' ]]
printf 'Updater no-change, dirty-checkout, repair, failed-setup recovery, local-ahead and repeat checks passed.\n'
