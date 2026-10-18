#!/usr/bin/env bash
# Run as your desktop user; only optional verified system-helper removal uses sudo.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
helper="$here/windows/scripts/uninstall-mochi.py"
[[ -f "$helper" ]] || helper="$here/uninstall-mochi.py"
command -v python3 >/dev/null || { echo 'Python 3 is required to safely remove Mochi integrations.' >&2; exit 1; }
exec python3 "$helper" "$@"
