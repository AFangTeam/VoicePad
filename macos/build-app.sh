#!/bin/zsh
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
app_dir="$root_dir/VoicePad.app"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

for tool in node ffmpeg ffprobe swiftc iconutil sips; do
  if ! command -v "$tool" >/dev/null; then
    print -u2 "缺少 $tool，无法构建 VoicePad.app"
    exit 1
  fi
done

rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources/web"

cp -L "$(command -v node)" "$app_dir/Contents/MacOS/node"
cp -L "$(command -v ffmpeg)" "$app_dir/Contents/MacOS/ffmpeg"
cp -L "$(command -v ffprobe)" "$app_dir/Contents/MacOS/ffprobe"
cp "$root_dir/server.js" "$app_dir/Contents/Resources/web/server.js"
cp -R "$root_dir/public" "$app_dir/Contents/Resources/web/public"

swiftc -O -framework AppKit -framework WebKit \
  "$root_dir/macos/VoicePadApp.swift" -o "$app_dir/Contents/MacOS/VoicePad"
swiftc -O -framework AppKit \
  "$root_dir/macos/GenerateIcon.swift" -o "$temp_dir/generate-icon"
icon_png="$root_dir/macos/AppIcon.png"
"$temp_dir/generate-icon" "$icon_png"

iconset_dir="$temp_dir/AppIcon.iconset"
mkdir -p "$iconset_dir"
for points in 16 32 128 256 512; do
  sips -z "$points" "$points" "$icon_png" \
    --out "$iconset_dir/icon_${points}x${points}.png" >/dev/null
  retina=$((points * 2))
  sips -z "$retina" "$retina" "$icon_png" \
    --out "$iconset_dir/icon_${points}x${points}@2x.png" >/dev/null
done
iconutil -c icns "$iconset_dir" -o "$app_dir/Contents/Resources/AppIcon.icns"

cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>VoicePad</string>
  <key>CFBundleDisplayName</key><string>VoicePad</string>
  <key>CFBundleIdentifier</key><string>dev.voicepad.app</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>VoicePad</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict></plist>
PLIST

codesign --force --deep --sign - "$app_dir" >/dev/null
print "已创建 $app_dir"
