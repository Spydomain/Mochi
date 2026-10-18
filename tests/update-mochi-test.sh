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
mkdir -p "$test_dir/work/windows/airdrop"
printf '# mock browser\n' > "$test_dir/work/windows/airdrop/mochi_discover.py"
printf '# mock sender\n' > "$test_dir/work/windows/airdrop/mochi_send.py"
printf '#!/usr/bin/env bash\nexit "${MOCHI_TEST_FAIL_BACKEND:-0}"\n' > "$test_dir/work/windows/scripts/install-airdrop-mt7922.sh"
printf '#!/usr/bin/env bash\n# mocked AirDrop consent\n' > "$test_dir/work/windows/scripts/mochi-airdrop-confirm.sh"
printf '#!/usr/bin/env bash\n# mocked cleanup\n' > "$test_dir/work/windows/scripts/cleanup-opencode-sessions.sh"
printf '#!/usr/bin/env python3\n# mocked picker\n' > "$test_dir/work/windows/scripts/mochi-airdrop-pick.py"
install -m 755 "$repo_dir/uninstall-mochi.sh" "$test_dir/work/uninstall-mochi.sh"
install -m 755 "$repo_dir/windows/scripts/uninstall-mochi.py" "$test_dir/work/windows/scripts/uninstall-mochi.py"
cat > "$test_dir/work/mochi-full-setup.sh" <<'SETUP'
#!/usr/bin/env bash
set -euo pipefail
[[ "${MOCHI_TEST_FAIL_SETUP:-0}" != 1 ]] || exit 42
if [[ "${MOCHI_TEST_EXPECT_NO_AIRDROP:-0}" == 1 ]]; then
  [[ $# == 1 && "$1" == --no-airdrop ]] || exit 43
fi
printf 'updated\n' >> "$MOCHI_TEST_MARKER"
mkdir -p "$XDG_DATA_HOME/mochi/bin"
install -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi"
install -m 755 /usr/bin/true "$XDG_DATA_HOME/mochi/bin/mochi-hook"
install -m 755 "$(dirname "$0")/windows/scripts/mochi-airdrop-confirm.sh" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-confirm"
install -m 755 "$(dirname "$0")/windows/scripts/mochi-airdrop-pick.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-pick"
install -m 755 "$(dirname "$0")/windows/airdrop/mochi_discover.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-browse"
install -m 755 "$(dirname "$0")/windows/airdrop/mochi_send.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-send"
install -m 755 "$(dirname "$0")/windows/scripts/cleanup-opencode-sessions.sh" "$XDG_DATA_HOME/mochi/bin/cleanup-opencode-sessions"
install -m 755 "$(dirname "$0")/uninstall-mochi.sh" "$XDG_DATA_HOME/mochi/bin/uninstall-mochi"
install -m 755 "$(dirname "$0")/windows/scripts/uninstall-mochi.py" "$XDG_DATA_HOME/mochi/bin/uninstall-mochi.py"
git -C "$(dirname "$0")" rev-parse HEAD > "$XDG_DATA_HOME/mochi/installed-revision"
SETUP
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
install -m 755 "$test_dir/work/windows/scripts/mochi-airdrop-pick.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-pick"
install -m 755 "$test_dir/work/windows/airdrop/mochi_discover.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-browse"
install -m 755 "$test_dir/work/windows/airdrop/mochi_send.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-send"
install -m 755 "$test_dir/work/uninstall-mochi.sh" "$XDG_DATA_HOME/mochi/bin/uninstall-mochi"
install -m 755 "$test_dir/work/windows/scripts/uninstall-mochi.py" "$XDG_DATA_HOME/mochi/bin/uninstall-mochi.py"
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
mv -- "$test_dir/work/local-note" "$test_dir/local-note-after-test"
# Sending must work on a fresh install without a separate Omdrop checkout.
rm -- "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-pick"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-picker.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 8 ]]
cmp "$test_dir/work/windows/scripts/mochi-airdrop-pick.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-pick"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-picker-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 8 ]]
printf '# stale picker\n' > "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-pick"
"$test_dir/work/update-mochi.sh" > "$test_dir/stale-picker.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 9 ]]
cmp "$test_dir/work/windows/scripts/mochi-airdrop-pick.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-pick"
rm -- "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-browse"
printf '# stale sender\n' > "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-send"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-live-helpers.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 10 ]]
cmp "$test_dir/work/windows/airdrop/mochi_discover.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-browse"
cmp "$test_dir/work/windows/airdrop/mochi_send.py" "$XDG_DATA_HOME/mochi/bin/mochi-airdrop-send"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-live-helpers-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 10 ]]
rm -- "$XDG_DATA_HOME/mochi/bin/uninstall-mochi"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-uninstaller.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 11 ]]
cmp "$test_dir/work/uninstall-mochi.sh" "$XDG_DATA_HOME/mochi/bin/uninstall-mochi"
printf '# stale uninstaller\n' > "$XDG_DATA_HOME/mochi/bin/uninstall-mochi.py"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-uninstaller-helper.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 12 ]]
cmp "$test_dir/work/windows/scripts/uninstall-mochi.py" "$XDG_DATA_HOME/mochi/bin/uninstall-mochi.py"
"$test_dir/work/update-mochi.sh" > "$test_dir/repaired-uninstaller-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 12 ]]
# A radio opt-out must survive no-op and repair updates on supported hardware.
printf '1\n' > "$XDG_DATA_HOME/mochi/installed-no-airdrop"
MOCHI_TEST_FAIL_BACKEND=1 "$test_dir/work/update-mochi.sh" > "$test_dir/opt-out-noop.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 12 ]]
grep -Fq 'No updates available' "$test_dir/opt-out-noop.log"
rm -- "$XDG_DATA_HOME/mochi/bin/mochi-hook"
MOCHI_TEST_FAIL_BACKEND=1 MOCHI_TEST_EXPECT_NO_AIRDROP=1 "$test_dir/work/update-mochi.sh" > "$test_dir/opt-out-repair.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 13 ]]
MOCHI_TEST_FAIL_BACKEND=1 "$test_dir/work/update-mochi.sh" > "$test_dir/opt-out-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 13 ]]

# Preserve the radio choice on a genuine upstream fast-forward, too.
git -C "$test_dir/publisher" fetch --quiet "$test_dir/work" main
git -C "$test_dir/publisher" merge --quiet --ff-only FETCH_HEAD
printf 'radio opt-out update\n' > "$test_dir/publisher/CHANGELOG-test"
git -C "$test_dir/publisher" add .
git -C "$test_dir/publisher" commit --quiet -m opt-out-update
git -C "$test_dir/remote.git" fetch --quiet "$test_dir/publisher" main:main
MOCHI_TEST_FAIL_BACKEND=1 MOCHI_TEST_EXPECT_NO_AIRDROP=1 "$test_dir/work/update-mochi.sh" > "$test_dir/opt-out-update.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 14 ]]
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$(git -C "$test_dir/publisher" rev-parse HEAD)" ]]
MOCHI_TEST_FAIL_BACKEND=1 "$test_dir/work/update-mochi.sh" > "$test_dir/opt-out-update-repeat.log"
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 14 ]]

# Offline checks must fail without changing the source, app or revision marker.
before="$(git -C "$test_dir/work" rev-parse HEAD)"
before_binary="$(sha256sum "$XDG_DATA_HOME/mochi/bin/mochi")"
if MOCHI_UPDATE_REMOTE="$test_dir/unavailable.git" "$test_dir/work/update-mochi.sh" > "$test_dir/offline.log" 2>&1; then
  echo 'Updater reported success with an unavailable remote.' >&2; exit 1
fi
[[ "$(git -C "$test_dir/work" rev-parse HEAD)" == "$before" ]]
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$before" ]]
[[ "$(sha256sum "$XDG_DATA_HOME/mochi/bin/mochi")" == "$before_binary" ]]
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 14 ]]

# Divergent histories require manual review, never a reset or implicit rebase.
printf 'local branch\n' > "$test_dir/work/LOCAL-BRANCH"
git -C "$test_dir/work" add .
git -C "$test_dir/work" commit --quiet -m diverging-local
printf 'upstream branch\n' > "$test_dir/publisher/UPSTREAM-BRANCH"
git -C "$test_dir/publisher" add .
git -C "$test_dir/publisher" commit --quiet -m diverging-upstream
git -C "$test_dir/remote.git" fetch --quiet "$test_dir/publisher" main:main
divergent="$(git -C "$test_dir/work" rev-parse HEAD)"
if "$test_dir/work/update-mochi.sh" > "$test_dir/divergent.log" 2>&1; then
  echo 'Updater accepted divergent histories.' >&2; exit 1
fi
grep -Fq 'diverged' "$test_dir/divergent.log"
[[ "$(git -C "$test_dir/work" rev-parse HEAD)" == "$divergent" ]]
[[ "$(< "$XDG_DATA_HOME/mochi/installed-revision")" == "$before" ]]
[[ "$(wc -l < "$MOCHI_TEST_MARKER")" -eq 14 ]]
printf 'Updater no-op, fast-forward, dirty/divergent refusal, offline safety, repair, failure recovery, local-ahead and AirDrop opt-out checks passed.\n'
