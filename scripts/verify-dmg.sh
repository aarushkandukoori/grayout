#!/usr/bin/env bash
# Release gate for a built DMG (BUILD-SPEC §24 step 2):
#   scripts/verify-dmg.sh dist/Grayout-arm64.dmg
# Mounts the image read-only, then checks the .app inside:
#   - codesign --verify --deep --strict passes (a broken seal = "damaged" dialog for users)
#   - designated requirement is identifier "com.aarushkandukoori.grayout" (afterSign.js)
#   - CFBundleIdentifier matches
#   - helper/grayscale is a universal binary (x86_64 + arm64) and executable
#   - Info.plist has LSUIElement and NSScreenCaptureUsageDescription
#   - the volume carries the /Applications symlink for drag-install
#   - spctl -a -vv is printed for information; an un-notarized build is expected
#     to be rejected there, so it is not a gate.
# Exits non-zero if any gate fails. Always detaches the image.
set -uo pipefail

APP_ID="com.aarushkandukoori.grayout"
DMG="${1:-}"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "usage: $0 <path/to/Grayout-arch.dmg>" >&2
  exit 2
fi

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
info() { printf 'INFO  %s\n' "$1"; }

MNT="$(mktemp -d "${TMPDIR:-/tmp}/grayout-verify.XXXXXX")"
cleanup() {
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || hdiutil detach "$MNT" -force -quiet >/dev/null 2>&1 || true
  rmdir "$MNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null; then
  echo "FAIL  hdiutil attach $DMG" >&2
  exit 1
fi
pass "mounted $DMG at $MNT"

APP="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP" ]; then
  fail "no .app on the volume"
  exit 1
fi
if [ "$(basename "$APP")" = "Grayout.app" ]; then pass "bundle is Grayout.app"; else fail "bundle is $(basename "$APP"), expected Grayout.app"; fi

# --- signature ---------------------------------------------------------------
# --verbose=2 lists every nested bundle as --prepared/--validated; keep only the verdict lines.
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | grep -v -- '^--' | sed 's/^/      /'; then
  pass "codesign --verify --deep --strict"
else
  fail "codesign --verify --deep --strict"
fi

DR="$(codesign -d -r- "$APP" 2>&1)"
if printf '%s' "$DR" | grep -q "designated => identifier \"$APP_ID\""; then
  pass "designated requirement is identifier \"$APP_ID\""
else
  fail "designated requirement is not identifier-based:"
  printf '%s\n' "$DR" | sed 's/^/      /'
fi

# --- Info.plist --------------------------------------------------------------
PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
bid="$($PB -c 'Print :CFBundleIdentifier' "$PLIST" 2>/dev/null)"
if [ "$bid" = "$APP_ID" ]; then pass "CFBundleIdentifier = $bid"; else fail "CFBundleIdentifier = '$bid'"; fi

lsui="$($PB -c 'Print :LSUIElement' "$PLIST" 2>/dev/null)"
if [ "$lsui" = "true" ] || [ "$lsui" = "1" ]; then pass "LSUIElement = $lsui (menu-bar app, no Dock icon)"; else fail "LSUIElement missing or false ('$lsui')"; fi

scd="$($PB -c 'Print :NSScreenCaptureUsageDescription' "$PLIST" 2>/dev/null)"
if [ -n "$scd" ]; then pass "NSScreenCaptureUsageDescription present"; else fail "NSScreenCaptureUsageDescription missing"; fi

exe="$($PB -c 'Print :CFBundleExecutable' "$PLIST" 2>/dev/null)"
if [ "$exe" = "Grayout" ] && [ -x "$APP/Contents/MacOS/Grayout" ]; then pass "CFBundleExecutable = Grayout"; else fail "CFBundleExecutable = '$exe'"; fi

# --- helper ------------------------------------------------------------------
HELPER="$APP/Contents/Resources/helper/grayscale"
if [ -f "$HELPER" ]; then
  if [ -x "$HELPER" ]; then pass "helper/grayscale present and executable"; else fail "helper/grayscale is not executable"; fi
  archs="$(lipo -info "$HELPER" 2>&1)"
  info "$archs"
  if printf '%s' "$archs" | grep -q 'x86_64' && printf '%s' "$archs" | grep -q 'arm64'; then
    pass "helper/grayscale is universal (x86_64 + arm64)"
  else
    fail "helper/grayscale is not universal"
  fi
else
  fail "helper/grayscale missing at Contents/Resources/helper/grayscale"
fi

# --- volume layout -----------------------------------------------------------
if [ -L "$MNT/Applications" ]; then
  pass "Applications symlink present ($(readlink "$MNT/Applications"))"
else
  fail "Applications symlink missing on the volume"
fi

# --- Gatekeeper (informational) ----------------------------------------------
info "spctl -a -vv (an ad-hoc, un-notarized build is expected to be rejected here; not a gate):"
spctl -a -vv -t exec "$APP" 2>&1 | sed 's/^/      /' || true

echo
if [ "$fails" -eq 0 ]; then
  echo "verify-dmg: all gates passed for $DMG"
  exit 0
fi
echo "verify-dmg: $fails gate(s) FAILED for $DMG" >&2
exit 1
