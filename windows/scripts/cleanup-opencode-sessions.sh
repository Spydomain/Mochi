#!/usr/bin/env bash
# Retain Mochi chat sessions for 30 days, leaving all other OpenCode work alone.
set -euo pipefail

cutoff=$(( $(date +%s) - 30*24*60*60 ))
opencode_bin="$(command -v opencode || true)"
if [[ -z "$opencode_bin" ]]; then
  for candidate in "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"; do
    if [[ -x "$candidate" ]]; then opencode_bin="$candidate"; break; fi
  done
fi
[[ -n "$opencode_bin" ]] || exit 0
cd -- "$HOME"  # Mochi runs OpenCode chat in the user's home project.
sessions="$("$opencode_bin" session list --format json --max-count 10000)"
candidates="$(printf '%s' "$sessions" | node -e '
let input="";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  for (const session of JSON.parse(input)) {
    if (session.title !== "Mochi chat") continue;
    const raw = session.updated ?? session.created;
    const seconds = typeof raw === "number"
      ? (raw > 1e11 ? raw / 1000 : raw)
      : Date.parse(raw || "") / 1000;
    if (/^ses_[A-Za-z0-9_-]+$/.test(session.id ?? "") && Number.isFinite(seconds)) {
      console.log(`${session.id}\t${Math.floor(seconds)}`);
    }
  }
});
')"
while IFS=$'\t' read -r id updated; do
  [[ -n "$id" && "$updated" =~ ^[0-9]+$ ]] || continue
  (( updated < cutoff )) || continue
  if [[ "${1:-}" == "--dry-run" ]]; then
    printf 'Would delete Mochi chat session %s\n' "$id"
  else
    "$opencode_bin" session delete "$id" >/dev/null
  fi
done <<< "$candidates"
