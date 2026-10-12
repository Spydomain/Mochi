#!/usr/bin/env bash
# Compatibility entry point; the full installer is safe to rerun.
set -euo pipefail
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/mochi-full-setup.sh" "$@"
