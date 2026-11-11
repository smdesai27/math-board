#!/bin/sh
# Build a distributable universal app and companion npm archive. Run on macOS.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
sh app/build.sh
mkdir -p app/build/release
out="$root/app/build/release"
ditto -c -k --sequesterRsrc --keepParent "app/build/Math Board.app" "$out/Math-Board-macOS-universal.zip"
npm pack --pack-destination "$out"
cp docs/agent-setup.md "$out/Agent-Setup.md"
(cd "$out" && shasum -a 256 Math-Board-macOS-universal.zip pi-math-board-*.tgz Agent-Setup.md > SHA256SUMS)
echo "Release files: $out"
