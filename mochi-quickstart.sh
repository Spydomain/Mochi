#!/usr/bin/env bash
# Compatibility entry point; use the same dependency-aware setup path.
set -euo pipefail
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/mochi-full-setup.sh" "$@"
