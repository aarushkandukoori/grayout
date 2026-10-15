#!/usr/bin/env bash
# Gate for a Mac App Store build of Grayout. Run by `npm run mas:dev` and
# `npm run mas`; exits non-zero on the first problem.
#
#   bash scripts/verify-mas.sh dist/mas-dev-arm64/Grayout.app
#   bash scripts/verify-mas.sh dist/mas-arm64/Grayout.app dist/mas-arm64/Grayout-2.0.0-mas.pkg
#
# It never launches the app. The installer signature is checked only when a
# .pkg path is given (a mas-dev build has none).
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist" 2>/dev/null || true; }
has_key() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist" >/dev/null 2>&1; }
ents() { codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null || true; }
is_macho() { file -b "$1" | grep -q 'Mach-O'; }
# One value (a PlistBuddy path, so dots in keys are fine) from the plist on stdin.
# plutil reads stdin to EOF (PlistBuddy on /dev/stdin only sees what is already
# in the pipe and fails on large or slow input). Dots inside keys are escaped.
pval() { plutil -extract "$1" raw -o - - 2>/dev/null || true; }

# Prints the first file or link under $1 that carries com.apple.quarantine.
# Not `xattr -lr | grep -q`: under pipefail grep's early exit killed xattr with
# SIGPIPE and a fully quarantined bundle passed, and xattr follows symlinks, so
# it never saw the attribute on a link itself.
quarantined() { find "$1" -xattrname com.apple.quarantine -print -quit 2>/dev/null || true; }

# App Store Connect matches the profile's application-identifier against
# <ElectronTeamID>.<CFBundleIdentifier>. osx-sign signs that pair from
# Info.plist and embeds whatever profile it is given, and codesign compares
# neither, so a leftover MAS_APP_ID would otherwise only fail at upload.
#   check_app_id TEAM BID MAIN_ENTITLEMENTS_XML [DECODED_PROFILE_XML]
check_app_id() {
  local want="$1.$2" got
  got=$(printf '%s' "$3" | pval 'com\.apple\.application-identifier')
  [ -z "$got" ] || [ "$got" = "$want" ] || fail "signed application-identifier $got != $want"
  [ -n "${4:-}" ] || return 0
  got=$(printf '%s' "$4" | pval TeamIdentifier.0)
  [ "$got" = "$1" ] || fail "profile team $got != ElectronTeamID $1"
  got=$(printf '%s' "$4" | pval 'Entitlements.com\.apple\.application-identifier')
  [ "$got" = "$want" ] || fail "profile application-identifier ${got:-missing} != $want (is MAS_APP_ID set?)"
}

# Sourced by tests/build-config.test.js to call the checks above: stop here.
if (return 0 2>/dev/null); then return 0; fi

APP="${1:?usage: verify-mas.sh path/to/Grayout.app [path/to/Grayout-x.y.z-mas.pkg]}"
PKG="${2:-}"
[ -d "$APP/Contents" ] || fail "$APP is not an app bundle"

BID=$(plist CFBundleIdentifier)
TEAM=$(plist ElectronTeamID)
EXE=$(plist CFBundleExecutable)
HELPER="$APP/Contents/Resources/helper/grayout-overlay"

# --- Info.plist ---------------------------------------------------------------
[ -n "$BID" ] || fail "CFBundleIdentifier missing"
[ -n "$TEAM" ] || fail "ElectronTeamID missing from Info.plist"
[ "$(plist LSUIElement)" = "true" ] || fail "LSUIElement must be true (menu bar app)"
[ "$(plist ITSAppUsesNonExemptEncryption)" = "false" ] || fail "ITSAppUsesNonExemptEncryption must be false"
[ "$(plist LSMinimumSystemVersion)" = "13.0" ] || fail "LSMinimumSystemVersion must be 13.0"
plist NSScreenCaptureUsageDescription | grep -q "OpenAI" || fail "the Screen Recording purpose string must name OpenAI (5.1.1(ii))"
plist NSCameraUsageDescription | grep -q "OpenAI" || fail "the camera purpose string must name OpenAI (5.1.1(ii))"
for k in NSAppleEventsUsageDescription NSMicrophoneUsageDescription NSAudioCaptureUsageDescription \
         NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription NSAppTransportSecurity; do
  if has_key "$k"; then fail "Info.plist still has $k"; fi
done

# --- contents -----------------------------------------------------------------
# Electron's darwin build ships Squirrel for autoUpdater; the MAS build does not.
[ ! -e "$APP/Contents/Frameworks/Squirrel.framework" ] || fail "Squirrel.framework present: this is not Electron's MAS build"
[ -x "$HELPER" ] || fail "helper/grayout-overlay missing"
[ ! -e "$APP/Contents/Resources/helper/grayscale" ] || fail "the private-API grayscale helper is in the bundle"
[ ! -e "$APP/Contents/Resources/app-update.yml" ] || fail "app-update.yml present (set publish: null)"
Q=$(quarantined "$APP")
[ -z "$Q" ] || fail "com.apple.quarantine xattr present on ${Q#"$APP"/}"
# No Mach-O may even contain the private Color Filters symbol names (2.5.1).
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  if LC_ALL=C grep -a -q "MADisplayFilterPref" "$f"; then fail "MADisplayFilterPref found in ${f#"$APP"/}"; fi
done < <(find "$APP/Contents" -type f -print0)

# --- signatures and entitlements ----------------------------------------------
codesign --verify --deep --strict "$APP" || fail "codesign --verify --deep --strict"
MAIN=$(ents "$APP")
echo "$MAIN" | grep -q "com.apple.security.app-sandbox" || fail "main app not sandboxed"
echo "$MAIN" | grep -q "com.apple.security.network.client" || fail "main app lacks network.client"
echo "$MAIN" | grep -q "<string>$TEAM.$BID</string>" || fail "application-groups must contain $TEAM.$BID"
if echo "$MAIN" | grep -q "com.apple.security.inherit"; then fail "main app must not use inherit"; fi
if echo "$MAIN" | grep -q "com.apple.security.network.server"; then fail "main app must not have network.server"; fi
# Every other Mach-O executable is a child of the app: sandbox + inherit
# (dylibs carry no entitlements). The login helper runs on its own: no inherit.
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q "Mach-O.*executable" || continue
  case "$f" in "$APP/Contents/MacOS/"*|*"/Library/LoginItems/"*) continue;; esac
  e=$(ents "$f")
  echo "$e" | grep -q "com.apple.security.app-sandbox" && echo "$e" | grep -q "com.apple.security.inherit" \
    || fail "child not sandbox+inherit: ${f#"$APP"/}"
done < <(find "$APP/Contents" -type f -perm -u+x -print0)
HE=$(ents "$HELPER")
echo "$HE" | grep -q "com.apple.security.inherit" || fail "grayout-overlay must inherit the sandbox"
for lh in "$APP"/Contents/Library/LoginItems/*.app; do
  [ -e "$lh" ] || continue
  e=$(ents "$lh")
  echo "$e" | grep -q "com.apple.security.app-sandbox" || fail "login helper not sandboxed"
  if echo "$e" | grep -q "com.apple.security.inherit"; then fail "login helper must not use inherit"; fi
done
PROFILE=""
if [ -f "$APP/Contents/embedded.provisionprofile" ]; then
  PROFILE=$(security cms -D -i "$APP/Contents/embedded.provisionprofile") || fail "cannot decode embedded.provisionprofile"
  [ -n "$PROFILE" ] || fail "embedded.provisionprofile decodes to nothing"
fi
check_app_id "$TEAM" "$BID" "$MAIN" "$PROFILE"
if [ -n "$PKG" ]; then
  [ -f "$PKG" ] || fail "no installer at $PKG"
  pkgutil --check-signature "$PKG" | grep -q "3rd Party Mac Developer Installer" || fail "pkg not signed with the Mac Installer Distribution certificate"
fi

echo "OK: $BID team=$TEAM build=$(plist CFBundleVersion) archs=$(lipo -archs "$APP/Contents/MacOS/$EXE")"
