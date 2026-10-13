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
printf '#!/usr/bin/env bash\nset -euo pipefail\n[[ "${MOCHI_TEST_FAIL_SETUP:-0}" != 1 ]] || exit 42\nprintf "updated\\n" >> "$MOCHI_TEST_MARKER"\nmkdir -p "$XDG_DATA_HOME/mochi/bin"\ninstall -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi"\ngit -C "$(dirname "$0")" rev-parse HEAD > "$XDG_DATA_HOME/mochi/installed-revision"\n' > "$test_dir/work/mochi-full-setup.sh"
chmod 755 "$test_dir/work/mochi-full-setup.sh"
git -C "$test_dir/work" add .
git -C "$test_dir/work" commit --quiet -m initial
git -C "$test_dir/work" remote add origin "$test_dir/remote.git"
git -C "$test_dir/work" push --quiet origin main

export MOCHI_UPDATE_REMOTE="$test_dir/remote.git"
export MOCHI_TEST_MARKER="$test_dir/installed.log"
export XDG_DATA_HOME="$test_dir/data"
mkdir -p "$XDG_DATA_HOME/mochi/bin"
install -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi"
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
git -C "$test_dir/publisher" push --quiet origin main

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

# A build failure after fast-forward must be retried on the next invocation.
printf 'second upstream commit\n' > "$test_dir/publisher/CHANGELOG-test"
git -C "$test_dir/publisher" add .
git -C "$test_dir/publisher" commit --quiet -m second-update
git -C "$test_dir/publisher" push --quiet origin main
before_install="$(< "$XDG_DATA_HOME/mochi/installed-revision")"
if MOCHI_TEST_FAIL_SETUP=1 "$test_dir/work/update-mochi.sh" > "$test_dir/failed-setup.log" 2>&1; then
  printf 'Updater accepted a failed setup.\n' >&2
  exit 1
fi
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$before_install" ]]
"$test_dir/work/update-mochi.sh" > "$test_dir/recovered.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 3 ]]
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$(git -C "$test_dir/work" rev-parse HEAD)" ]]
printf 'Updater no-change, dirty-checkout, repair, failed-setup recovery and repeat checks passed.\n'
