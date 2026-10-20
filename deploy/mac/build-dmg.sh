#!/bin/bash
# Builds dist/Sterio-Server.dmg: Sterio Server.app for any Mac
# (Apple silicon and Intel, macOS 12+), with Node, FFmpeg and metaflac inside.
#   deploy/mac/build-dmg.sh [signing identity]
# Without an identity the app is signed ad hoc: another Mac then asks to
# confirm it once in System Settings > Privacy & Security ("Open Anyway").
# With a "Developer ID Application" identity, set NOTARY_PROFILE (a
# `xcrun notarytool store-credentials` profile) to notarize the DMG too.
#   deploy/mac/build-dmg.sh --app-store [upload]
# builds the sandboxed Mac App Store copy instead: an Xcode archive exported
# for App Store Connect (work/mac-server/export-*), or uploaded to TestFlight
# with "upload". APP_BUILD sets the build number (default 1); each upload
# needs a higher one.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
here="$root/deploy/mac"
store=; upload=
if [ "${1:-}" = "--app-store" ]; then store=1; [ "${2:-}" = "upload" ] && upload=1; identity=; else identity=${1:-}; fi
version=$(node -p "require('$root/package.json').version")
build=${APP_BUILD:-1}
[ -n "$store" ] || build=$version
work="$root/work/mac-server"
downloads="$work/downloads"
mkdir -p "$downloads"

node_version=24.22.0
ffmpeg_arm64=arm64/1789931890_9.0.2
ffmpeg_x64=amd64/1789931006_9.0.2
flac_version=1.5.0

fetch() { # url file: downloaded once, kept in work/mac-server/downloads
  [ -s "$downloads/$2" ] && return 0
  curl -fsSL --retry 4 --retry-delay 2 -o "$downloads/$2.part" "$1" && mv "$downloads/$2.part" "$downloads/$2"
}
check() { # file sha256
  echo "$2  $downloads/$1" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch: $1" >&2; rm -f "$downloads/$1"; exit 1; }
}

echo "Downloading Node $node_version"
fetch "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" "node-$node_version-SHASUMS256.txt"
for arch in arm64 x64; do
  file="node-v$node_version-darwin-$arch.tar.gz"
  fetch "https://nodejs.org/dist/v$node_version/$file" "$file"
  check "$file" "$(grep " $file\$" "$downloads/node-$node_version-SHASUMS256.txt" | cut -d' ' -f1)"
done

echo "Downloading FFmpeg"
for pair in "arm64:$ffmpeg_arm64" "x64:$ffmpeg_x64"; do
  arch=${pair%%:*}; path=${pair#*:}
  for tool in ffmpeg ffprobe; do
    fetch "https://ffmpeg.martin-riedl.de/download/macos/$path/$tool.zip" "$tool-$arch.zip"
    fetch "https://ffmpeg.martin-riedl.de/download/macos/$path/$tool.zip.sha256" "$tool-$arch.zip.sha256"
    check "$tool-$arch.zip" "$(awk '{print $1}' "$downloads/$tool-$arch.zip.sha256")"
  done
done

echo "Building metaflac $flac_version"
fetch "https://ftp.osuosl.org/pub/xiph/releases/flac/flac-$flac_version.tar.xz" "flac-$flac_version.tar.xz"
fetch "https://ftp.osuosl.org/pub/xiph/releases/flac/SHA256SUMS.txt" "flac-SHA256SUMS.txt" || true
if grep -q "flac-$flac_version.tar.xz" "$downloads/flac-SHA256SUMS.txt" 2>/dev/null; then
  check "flac-$flac_version.tar.xz" "$(grep "flac-$flac_version.tar.xz" "$downloads/flac-SHA256SUMS.txt" | awk '{print $1}')"
fi
flac_build="$work/flac-$flac_version-universal"
if [ ! -x "$flac_build/src/metaflac/metaflac" ]; then
  mkdir -p "$work/src" && tar -xJf "$downloads/flac-$flac_version.tar.xz" -C "$work/src"
  cmake -S "$work/src/flac-$flac_version" -B "$flac_build" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
    -DCMAKE_IGNORE_PREFIX_PATH="/opt/homebrew;/usr/local" \
    -DBUILD_SHARED_LIBS=OFF -DWITH_OGG=OFF -DBUILD_CXXLIBS=OFF -DBUILD_DOCS=OFF -DBUILD_EXAMPLES=OFF \
    -DBUILD_TESTING=OFF -DBUILD_PROGRAMS=ON -DINSTALL_MANPAGES=OFF -DENABLE_MULTITHREADING=ON > "$work/flac-cmake.log"
  cmake --build "$flac_build" --target metaflac -j 8 > "$work/flac-build.log"
fi

echo "Assembling Sterio Server.app"
# A fresh folder each build; old ones in work/mac-server can be deleted.
stage="$work/stage-$version-$(date +%Y%m%d-%H%M%S)"
app="$stage/Sterio Server.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Helpers" "$app/Contents/Resources/server" "$work/tools"
for arch in arm64 x64; do
  tar -xzf "$downloads/node-v$node_version-darwin-$arch.tar.gz" -C "$work/tools" "node-v$node_version-darwin-$arch/bin/node"
  for tool in ffmpeg ffprobe; do mkdir -p "$work/tools/$tool-$arch" && unzip -oq "$downloads/$tool-$arch.zip" -d "$work/tools/$tool-$arch"; done
done
bin="$app/Contents/Helpers"
lipo -create "$work/tools/node-v$node_version-darwin-arm64/bin/node" "$work/tools/node-v$node_version-darwin-x64/bin/node" -output "$bin/node"
for tool in ffmpeg ffprobe; do lipo -create "$work/tools/$tool-arm64/$tool" "$work/tools/$tool-x64/$tool" -output "$bin/$tool"; done
cp "$flac_build/src/metaflac/metaflac" "$bin/metaflac"
chmod 755 "$bin"/*
cp -R "$root/src" "$app/Contents/Resources/server/src"
cp "$root/package.json" "$app/Contents/Resources/server/package.json"
# Trusted certificates for FFmpeg reading a linked server over HTTPS.
cp /etc/ssl/cert.pem "$app/Contents/Resources/server/cacert.pem"
find "$app" -name .DS_Store -delete

for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -o "$work/launcher-$arch" "$here/launcher/main.swift"
done
lipo -create "$work/launcher-arm64" "$work/launcher-x86_64" -output "$app/Contents/MacOS/Sterio Server"
sed -e "s/__VERSION__/$version/g" -e "s/__BUILD__/$build/g" "$here/Info.plist" > "$app/Contents/Info.plist"

# The Sterio icon with inverted colours, compiled into Assets.car and AppIcon.icns.
swiftc -O -o "$work/invert-icon" "$here/invert-icon.swift"
catalog="$stage-Assets.xcassets"; mkdir -p "$catalog/AppIcon.appiconset"
echo '{"info":{"version":1,"author":"xcode"}}' > "$catalog/Contents.json"
source_icons="$root/../sterio/macos/sterio-macOS/Assets.xcassets/AppIcon.appiconset"
cp "$source_icons/Contents.json" "$catalog/AppIcon.appiconset/"
for icon in "$source_icons"/*.png; do "$work/invert-icon" "$icon" "$catalog/AppIcon.appiconset/$(basename "$icon")"; done
xcrun actool "$catalog" --compile "$app/Contents/Resources" --platform macosx --minimum-deployment-target 12.0 \
  --app-icon AppIcon --output-partial-info-plist "$stage-assets.plist" > "$work/actool.log"

if [ -n "$store" ]; then
  echo "Signing for the Mac App Store"
  # Signed for development here; Xcode signs it again for App Store Connect.
  # The helpers carry only the sandbox and inherit it from the app.
  developer=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')
  for tool in ffmpeg ffprobe metaflac node; do
    codesign --force --sign "$developer" --entitlements "$here/app-store-helper.entitlements" "$bin/$tool"
  done
  codesign --force --sign "$developer" --entitlements "$here/app-store.entitlements" "$app"
  codesign --verify --deep --strict "$app"
  archive="$work/Sterio-Server-$version-$build.xcarchive"
  [ -e "$archive" ] && archive="$work/Sterio-Server-$version-$build-$(date +%H%M%S).xcarchive"
  mkdir -p "$archive/Products/Applications"
  ditto "$app" "$archive/Products/Applications/Sterio Server.app"
  cat > "$archive/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ApplicationProperties</key>
	<dict>
		<key>ApplicationPath</key><string>Applications/Sterio Server.app</string>
		<key>Architectures</key><array><string>arm64</string><string>x86_64</string></array>
		<key>CFBundleIdentifier</key><string>com.sorinbottea.sterio.server</string>
		<key>CFBundleShortVersionString</key><string>$version</string>
		<key>CFBundleVersion</key><string>$build</string>
		<key>SigningIdentity</key><string>$developer</string>
		<key>Team</key><string>6F2KGJWY8C</string>
	</dict>
	<key>ArchiveVersion</key><integer>2</integer>
	<key>CreationDate</key><date>$(date -u +%Y-%m-%dT%H:%M:%SZ)</date>
	<key>Name</key><string>Sterio Server</string>
	<key>SchemeName</key><string>Sterio Server</string>
</dict>
</plist>
PLIST
  destination=export; [ -n "$upload" ] && destination=upload
  options="$work/app-store-export.plist"
  cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>destination</key><string>$destination</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>method</key><string>app-store-connect</string>
	<key>signingStyle</key><string>automatic</string>
	<key>teamID</key><string>6F2KGJWY8C</string>
	<key>uploadSymbols</key><false/>
</dict>
</plist>
PLIST
  export_dir="$work/export-$version-$build-$(date +%H%M%S)"
  xcodebuild -exportArchive -archivePath "$archive" -exportPath "$export_dir" -exportOptionsPlist "$options" -allowProvisioningUpdates
  echo "Archive $archive, export $export_dir"
  exit 0
fi

echo "Signing"
if [ -n "$identity" ]; then
  sign=(codesign --force --timestamp --options runtime --sign "$identity")
else
  sign=(codesign --force --sign -)
fi
for tool in ffmpeg ffprobe metaflac; do "${sign[@]}" "$bin/$tool"; done
# Node compiles JavaScript at run time under the hardened runtime.
"${sign[@]}" --entitlements "$here/node.entitlements" "$bin/node"
"${sign[@]}" "$app"
codesign --verify --deep --strict "$app"

echo "Creating the DMG"
ln -s /Applications "$stage/Applications"
cp "$here/README.txt" "$stage/README.txt"
mkdir -p "$root/dist"
dmg="$root/dist/Sterio-Server.dmg"
hdiutil create -volname "Sterio Server" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
if [ -n "$identity" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
  fi
fi
# The DMG with the instructions, ready to send.
package="$work/package-$version-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$package/Sterio Server"
cp "$dmg" "$here/README.txt" "$package/Sterio Server/"
(cd "$package" && ditto -c -k --norsrc --noextattr --keepParent "Sterio Server" "$root/dist/Sterio-Server-$version.zip")
echo "Built $dmg ($(du -h "$dmg" | cut -f1)) and dist/Sterio-Server-$version.zip, server $version"
