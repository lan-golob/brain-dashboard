#!/bin/sh
# Build Brain.app: a small launcher that starts the dashboard server (if it isn't
# running) and opens it in its own Chrome app window (no tabs, no address bar).
# Chrome, not Electron/WebKit, because the free Web Speech voice input needs it.
#
#   app/build.sh                 -> /Applications/Brain.app
#   app/build.sh ~/Applications  -> ~/Applications/Brain.app
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/Applications}/Brain.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# icon
[ -f "$REPO/app/icon.png" ] || python3 "$REPO/app/make_icon.py" "$REPO/app/icon.png"
mkdir "$WORK/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$REPO/app/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$REPO/app/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$WORK/Brain.icns"

rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp "$WORK/Brain.icns" "$DEST/Contents/Resources/Brain.icns"

cat > "$DEST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Brain</string>
  <key>CFBundleDisplayName</key><string>Brain</string>
  <key>CFBundleIdentifier</key><string>com.lan.brain-dashboard</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Brain</string>
  <key>CFBundleIconFile</key><string>Brain</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

cat > "$DEST/Contents/MacOS/Brain" <<EOF
#!/bin/sh
# Launched from Finder/Dock with a minimal PATH, so add where python3 and claude live.
export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
REPO="$REPO"
PORT=4747
URL="http://localhost:\$PORT"
LOG="\$HOME/Library/Logs/brain-dashboard.log"

if ! curl -s -o /dev/null "\$URL/"; then
  cd "\$REPO" && nohup python3 server.py >> "\$LOG" 2>&1 &
  i=0
  while [ \$i -lt 50 ] && ! curl -s -o /dev/null "\$URL/"; do sleep 0.1; i=\$((i + 1)); done
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="\$URL" --window-size=1440,900
else
  open "\$URL"
fi
EOF
chmod +x "$DEST/Contents/MacOS/Brain"

# refresh the icon cache for this bundle
touch "$DEST"
echo "Built $DEST"
