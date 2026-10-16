#!/usr/bin/env bash
# The patched OpenDrop /Ask hook. Only an explicit island decision accepts.
# With no island, timeout, a malformed request, or a crashed app: decline.
set -u
umask 077

runtime="${XDG_RUNTIME_DIR:-}/mochi-airdrop"
[[ -n "${XDG_RUNTIME_DIR:-}" ]] || exit 1
mkdir -m 700 -p "$runtime" || exit 1
chmod 700 "$runtime" || exit 1
mkdir -m 700 "$runtime/active" 2>/dev/null || exit 1
active="$runtime/active"
trap 'rm -f -- "$active/request.json" "$active/request.tmp" "$active/decision"; rmdir -- "$active" 2>/dev/null || true' EXIT
trap 'exit 1' INT TERM HUP

id=$(python3 -c 'import secrets; print(secrets.token_hex(16))') || exit 1
python3 - "$id" "${1:-Unknown sender}" "${2:-Incoming file}" > "$active/request.tmp" <<'PY' || exit 1
import json, sys
print(json.dumps({"id": sys.argv[1], "sender": sys.argv[2][:80], "detail": sys.argv[3][:140]}))
PY
mv -- "$active/request.tmp" "$active/request.json" || exit 1

timeout_s="${AIRDROP_CONFIRM_TIMEOUT:-15}"
[[ "$timeout_s" =~ ^[0-9]+$ ]] || timeout_s=15
(( timeout_s > 0 && timeout_s <= 30 )) || timeout_s=15
for (( n=0; n<timeout_s*10; n++ )); do
  if [[ -f "$active/decision" ]]; then
    if [[ $(cat -- "$active/decision") == accept ]]; then
      log_size=$(stat -c %s "$XDG_RUNTIME_DIR/airdropd/airdropd.log" 2>/dev/null || echo 0)
      # The receiver runs in the destination directory. Record it with the
      # consent marker so Mochi can measure the growing raw upload by stat(2),
      # without ever guessing a save folder or parsing one from a log line.
      python3 - "$(date +%s)" "$log_size" > "$runtime/transfer.tmp" <<'PY' || exit 1
import json, os, sys
print(json.dumps({"start": int(sys.argv[1]), "offset": int(sys.argv[2]), "directory": os.getcwd()}))
PY
      mv -- "$runtime/transfer.tmp" "$runtime/transfer.json" || exit 1
      exit 0
    fi
    exit 1
  fi
  sleep 0.1
done
exit 1
