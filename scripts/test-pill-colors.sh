#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mochi-pill-colors.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc NotchBuddy/Sources/MochiKit/PillColors.swift \
    tests/PillColorsTests.swift -o "$TEST_DIR/pill-colors-tests"
"$TEST_DIR/pill-colors-tests"
