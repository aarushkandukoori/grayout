'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const paths = require('./paths');

const MAX_WIDTH = 1366;
const MAX_DISPLAYS = 3;          // cost ceiling: 3 images per check
// A capture of a black/asleep display compresses to almost nothing. Below this
// we treat it as "nothing to see" rather than as evidence of anything.
const MIN_PLAUSIBLE_BYTES = 6000;

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
      const { width } = img.getSize();
      if (width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, quality: 'good' });
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

module.exports = { captureScreens, MAX_WIDTH, MAX_DISPLAYS, MIN_PLAUSIBLE_BYTES };
