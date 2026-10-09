'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const paths = require('./paths');

const MAX_WIDTH = 1366;
// The Grayout service refuses any image taller than twice MAX_WIDTH (contract
// 6.11 step 1: at most 1366 px wide and 2732 px tall). Only a very tall
// portrait display gets near it, but without this limit every check from such
// a Mac would come back 400 and never be judged.
const MAX_HEIGHT = 2 * MAX_WIDTH;
const MAX_DISPLAYS = 3;          // cost ceiling: 3 images per check
// A capture of a black/asleep display compresses to almost nothing. Below this
// we treat it as "nothing to see" rather than as evidence of anything.
const MIN_PLAUSIBLE_BYTES = 6000;

/**
 * The size to shrink a capture to so it fits within MAX_WIDTH by MAX_HEIGHT,
 * keeping its shape, or null when it already fits. Rounded, then clamped, so
 * floating-point error can never leave it one pixel over a limit.
 */
function fitSize(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
  if (scale >= 1) return null;
  return {
    width: Math.max(1, Math.min(MAX_WIDTH, Math.round(width * scale))),
    height: Math.max(1, Math.min(MAX_HEIGHT, Math.round(height * scale)))
  };
}

function outPath(i) {
  return path.join(paths.FRAMES_DIR, `raw-${i}.jpg`);
}

function runScreencapture(files) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/sbin/screencapture',
      ['-x', '-t', 'jpg', ...files],
      { timeout: 20000 },
      err => (err ? reject(new Error(`screencapture: ${err.message}`)) : resolve())
    );
  });
}

/**
 * Capture every display (up to MAX_DISPLAYS).
 *
 * Capturing only the main display would be wrong: the consequence (grayscale +
 * red border) is applied to ALL displays, so judging from one of them can gray
 * out a second monitor based on a screen the model never saw.
 *
 * Uses the macOS `screencapture` binary rather than Electron's desktopCapturer:
 * on recent macOS the ScreenCaptureKit path silently returns zero sources once
 * the app's Screen Recording approval goes stale, while getMediaAccessStatus()
 * still reports "granted". The CLI keeps working.
 *
 * Frames are written to a per-process temp dir and unlinked as soon as they
 * are encoded, whatever happens.
 *
 * Returns { images: base64 JPEG[], blank: true when every display was blank }.
 */
async function captureScreens(nativeImage, displayCount = 1) {
  const n = Math.max(1, Math.min(MAX_DISPLAYS, displayCount));
  fs.mkdirSync(paths.FRAMES_DIR, { recursive: true, mode: 0o700 });
  const files = [];
  for (let i = 0; i < n; i++) {
    const p = outPath(i);
    try { fs.unlinkSync(p); } catch {}
    files.push(p);
  }

  try {
    await runScreencapture(files);

    const images = [];
    const seen = new Set();
    let sawAnyFile = false;

    for (const p of files) {
      let buf;
      try { buf = fs.readFileSync(p); } catch { continue; }
      sawAnyFile = true;
      if (buf.length < MIN_PLAUSIBLE_BYTES) continue; // blank/asleep display

      // Mirrored displays produce byte-identical captures; judge each once.
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);

      let img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) continue;
      const { width, height } = img.getSize();
      const fit = fitSize(width, height);
      if (fit) img = img.resize({ width: fit.width, height: fit.height, quality: 'good' });
      images.push(img.toJPEG(65).toString('base64'));
    }

    if (!sawAnyFile) {
      throw new Error('screen capture produced no file — check Screen Recording permission');
    }
    return { images, blank: images.length === 0 };
  } finally {
    for (const p of files) { try { fs.unlinkSync(p); } catch {} }
  }
}

module.exports = { captureScreens, fitSize, MAX_WIDTH, MAX_HEIGHT, MAX_DISPLAYS, MIN_PLAUSIBLE_BYTES };
