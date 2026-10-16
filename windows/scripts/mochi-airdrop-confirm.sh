#!/usr/bin/env bash
# The patched OpenDrop /Ask hook. Only an explicit island decision accepts.
# With no island, timeout, a malformed request, or a crashed app: decline.
set -u
umask 077

runtime="${XDG_RUNTIME_DIR:-}/mochi-airdrop"
[[ -n "${XDG_RUNTIME_DIR:-}" ]] || exit 1
mkdir -m 700 -p "$runtime" || exit 1
chmod 700 "$runtime" || exit 1

# Record why every refusal happened. A decline used to be completely silent,
# so a receiver running the wrong hook refused every transfer and left nothing
# to diagnose from. This file is private, lives in tmpfs, and stays a few lines
# per transfer. It deliberately records no sender name or filename.
note() {
  printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$runtime/hook.log" 2>/dev/null || true
}

# Two simultaneous /Ask handlers must never share a decision file. Keep this
# inode across requests: removing a flock file permits a second lock on a new
# inode while the first prompt is still alive. A competing request fails closed.
[[ ! -L "$runtime/hook.lock" ]] || { note 'declined: unsafe consent lock'; exit 1; }
exec 9>> "$runtime/hook.lock" || exit 1
flock -n 9 || { note 'declined: another request is awaiting consent'; exit 1; }

if [[ -e "$runtime/active" || -L "$runtime/active" ]]; then
  # A hook killed mid-transfer can leave this behind. Reuse it only when it is
  # a real, private directory of ours; a plain mkdir failed here and declined
  # every later transfer outright.
  [[ -d "$runtime/active" && ! -L "$runtime/active" ]] || { note 'declined: active path is not a private directory'; exit 1; }
  [[ "$(stat -c '%u %a' "$runtime/active")" == "$(id -u) 700" ]] || { note 'declined: active directory is not ours and private'; exit 1; }
else
  mkdir -m 700 "$runtime/active" || { note 'declined: cannot create the active directory'; exit 1; }
fi
active="$runtime/active"

# START FROM NOTHING. A hook killed mid-transfer leaves its answer behind, and
# the wait loop below would then read the PREVIOUS request's decision: a fresh
# transfer declined without anyone being asked, or - worse - accepted with no
# prompt at all. Clear any leftover request, answer and progress first.
rm -f -- "$active/decision" "$active/request.json" "$active/request.tmp" \
      "$runtime/transfer.json" "$runtime/transfer.tmp" ||
  { note 'declined: cannot clear stale state'; exit 1; }
python3 - "$active" <<'PY' || { note 'declined: cannot clear stale answers'; exit 1; }
import pathlib, re, sys
for path in pathlib.Path(sys.argv[1]).iterdir():
    if re.fullmatch(r"decision-[0-9a-f]{32}(?:\.tmp)?", path.name):
        path.unlink(missing_ok=True)
PY

trap 'rm -f -- "$active/request.json" "$active/request.tmp" "$active/decision" "${decision:-$active/no-decision}" "${decision:-$active/no-decision}.tmp"; rmdir -- "$active" 2>/dev/null || true' EXIT
trap 'note "declined: interrupted by a signal"; exit 1' INT TERM HUP

id=$(python3 -c 'import secrets; print(secrets.token_hex(16))') || { note 'declined: no request id'; exit 1; }
decision="$active/decision-$id"
python3 - "$id" "${1:-Unknown sender}" "${2:-Incoming file}" > "$active/request.tmp" <<'PY' || { note 'declined: cannot write the request'; exit 1; }
import json, sys
print(json.dumps({"id": sys.argv[1], "sender": sys.argv[2][:80], "detail": sys.argv[3][:140]}, ensure_ascii=False))
PY
mv -- "$active/request.tmp" "$active/request.json" || { note 'declined: cannot publish the request'; exit 1; }
note 'prompt raised; waiting for an explicit decision'

timeout_s="${AIRDROP_CONFIRM_TIMEOUT:-15}"
[[ "$timeout_s" =~ ^[0-9]+$ ]] || timeout_s=15
(( timeout_s > 0 && timeout_s <= 30 )) || timeout_s=15
for (( n=0; n<timeout_s*10; n++ )); do
  if [[ -f "$decision" && ! -L "$decision" ]]; then
    answer="$(cat -- "$decision")"
    if [[ "$answer" == "$id accept" ]]; then
      log_size=$(stat -c %s "$XDG_RUNTIME_DIR/airdropd/airdropd.log" 2>/dev/null || echo 0)
      # The receiver runs in the destination directory. Record it with the
      # consent marker so Mochi can measure the growing raw upload by stat(2),
      # without ever guessing a save folder or parsing one from a log line.
      python3 - "$(date +%s)" "$log_size" > "$runtime/transfer.tmp" <<'PY' || { note 'declined: cannot write the transfer marker'; exit 1; }
import json, os, sys
print(json.dumps({"start": int(sys.argv[1]), "offset": int(sys.argv[2]), "directory": os.getcwd()}))
PY
      mv -- "$runtime/transfer.tmp" "$runtime/transfer.json" || { note 'declined: cannot publish the transfer marker'; exit 1; }
      note 'accepted by the user'
      exit 0
    fi
    if [[ "$answer" == "$id decline" ]]; then
      note 'declined by the user'
      exit 1
    fi
    # Unknown, incomplete or stale answers never decide this request.
  fi
  sleep 0.1
done
note "declined: nobody answered within ${timeout_s}s"
exit 1
