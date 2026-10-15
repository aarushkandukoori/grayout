#!/usr/bin/env bash
# Builds the two tiny universal (arm64 + x86_64) display helpers. Needs Xcode
# Command Line Tools.
#
#   helper/grayscale        direct download: flips macOS's Color Filters switch
#                           (private MediaAccessibility API, never in the MAS build)
#   helper/grayout-overlay  Mac App Store: grays the screen with a click-through
#                           overlay window (sandbox-safe), and reports the
#                           frontmost app
set -euo pipefail
cd "$(dirname "$0")/.."
clang -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -framework CoreFoundation -framework MediaAccessibility \
  -o helper/grayscale helper/grayscale.c
lipo -info helper/grayscale
./helper/grayscale status || echo 'helper status skipped (no display session)'

tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp:?}"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/overlay-Info.plist \
    -o "$tmp/grayout-overlay-$arch" helper/overlay.swift
done
lipo -create -output helper/grayout-overlay "$tmp/grayout-overlay-arm64" "$tmp/grayout-overlay-x86_64"
lipo -info helper/grayout-overlay
# Non-visual smoke checks only: never send "on" from a build script.
printf 'ping\nstatus\n' | ./helper/grayout-overlay
./helper/grayout-overlay front || echo 'overlay front skipped (no display session)'
