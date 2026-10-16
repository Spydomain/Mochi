#!/usr/bin/env bash
# Check receiver-owned BLE advertisement lifecycle without BlueZ or a radio.
set -euo pipefail
source_file="${1:?pass the patched airdropd path}"
grep -q '^  stop_receiver_wake$' "$source_file"
grep -q '^    start_receiver_wake$' "$source_file"
tmp_parent="${TMPDIR:-/tmp}"
[[ ! -d /tmp/opencode ]] || tmp_parent=/tmp/opencode
tmp="$(mktemp -d -p "$tmp_parent" mochi-wake-test.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/backend/tools"
cat > "$tmp/backend/tools/blewake-dbus.py" <<'PY'
import signal

signal.signal(signal.SIGTERM, lambda *_: exit(0))
print('advert up', flush=True)
signal.pause()
PY
awk '
  /^start_receiver_wake\(\) \{/ || /^stop_receiver_wake\(\) \{/ { copying=1 }
  copying { print; if ($0 == "}") copying=0 }
' "$source_file" > "$tmp/functions.sh"
[[ "$(grep -c '^.*() {' "$tmp/functions.sh")" == 2 ]]
MOCHI_WAKE_TEST_DIR="$tmp" timeout 10 bash -c '
  set -euo pipefail
  source "$MOCHI_WAKE_TEST_DIR/functions.sh"
  REPO="$MOCHI_WAKE_TEST_DIR/backend"
  LOG="$MOCHI_WAKE_TEST_DIR/advert.log"
  RX_WAKE_PID=""
  trap '\''stop_receiver_wake'\'' EXIT
  start_receiver_wake
  first="$RX_WAKE_PID"
  [[ "$first" =~ ^[0-9]+$ ]]
  for ((i = 0; i < 100; i++)); do
    [[ -s "$LOG" ]] && break
    kill -0 "$first" || exit 1
    sleep 0.05
  done
  grep -q "^advert up$" "$LOG" # Startup must actually complete.
  start_receiver_wake
  [[ "$RX_WAKE_PID" == "$first" ]] # A second receive loop must not register twice.
  stop_receiver_wake
  [[ -z "$RX_WAKE_PID" ]]
  if kill -0 "$first" 2>/dev/null; then exit 1; fi
  stop_receiver_wake # Stopping twice is safe.
  REPO="$MOCHI_WAKE_TEST_DIR/backend"
  : > "$LOG"
  start_receiver_wake # A later receive loop can restart a stopped advert.
  second="$RX_WAKE_PID"
  [[ "$second" =~ ^[0-9]+$ && "$second" != "$first" ]]
  for ((i = 0; i < 100; i++)); do
    [[ -s "$LOG" ]] && break
    kill -0 "$second" || exit 1
    sleep 0.05
  done
  grep -q "^advert up$" "$LOG"
  stop_receiver_wake
  REPO="$MOCHI_WAKE_TEST_DIR/missing"
  start_receiver_wake
  [[ -z "$RX_WAKE_PID" ]] # No script must not bring the receiver down.
'
printf 'Receiver BLE wake starts once and stops with its service.\n'
