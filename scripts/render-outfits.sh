#!/bin/bash
# render-outfits.sh — compile and run the Mochi outfit planche renderer
# NOT in CI. Run manually: bash scripts/render-outfits.sh
# Output: /tmp/mochi-outfits.png

set -e
cd "$(dirname "$0")/.."

SDK=$(xcrun --sdk macosx --show-sdk-path)

echo "Compiling renderer..."
swiftc \
  -parse-as-library \
  -sdk "$SDK" \
  -target arm64-apple-macosx15.0 \
  NotchBuddy/Sources/MochiKit/IslandScreenGeometry.swift \
  NotchBuddy/Sources/MochiKit/IslandTypes.swift \
  NotchBuddy/Sources/MochiKit/MochiWardrobe.swift \
  NotchBuddy/Sources/MochiKit/BotEngine.swift \
  NotchBuddy/Sources/MochiKit/MochiOutfitDrawing.swift \
  scripts/RenderOutfits.swift \
  -framework AppKit \
  -framework SwiftUI \
  -o /tmp/mochi-render-outfits \
  2>&1

echo "Running renderer..."
/tmp/mochi-render-outfits
echo "Opening..."
open /tmp/mochi-outfits.png
