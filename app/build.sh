#!/bin/sh
# Build "Math Board.app" from app/MathBoard.swift with the Xcode command line tools (no Xcode
# project). macOS 12 or later.
#
#   app/build.sh              -> app/build/Math Board.app
#   app/build.sh --install    also copies it to ~/Applications, where board_open looks for it
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/build/Math Board.app"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/../package.json" | head -1)

rm -rf "$out"
mkdir -p "$out/Contents/MacOS"
swiftc -O -framework Cocoa -framework WebKit "$here/MathBoard.swift" -o "$out/Contents/MacOS/MathBoard"
cat > "$out/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Math Board</string>
  <key>CFBundleDisplayName</key><string>Math Board</string>
  <key>CFBundleIdentifier</key><string>io.github.smdesai27.math-board</string>
  <key>CFBundleExecutable</key><string>MathBoard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
# Ad-hoc signature: enough to run on the machine that built it.
codesign --force --sign - "$out" >/dev/null 2>&1 || echo "note: could not sign the app (it still runs when built locally)"
echo "Built $out"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Math Board.app"
  cp -R "$out" "$HOME/Applications/"
  echo "Installed to $HOME/Applications/Math Board.app"
fi
