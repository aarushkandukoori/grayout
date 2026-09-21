#!/usr/bin/env bash
# Builds the tiny universal (arm64 + x86_64) grayscale helper that flips
# macOS's system-wide force-to-gray switch. Needs Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."
clang -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -framework ApplicationServices -o helper/grayscale helper/grayscale.c
lipo -info helper/grayscale
./helper/grayscale status || echo 'helper status skipped (no display session)'
