'use strict';
// 8x8 average hash ("aHash") of a captured frame, used only for change-gating:
// if every display looks the same as it did at the last real check, and the
// frontmost app has not changed, the loop skips the call and the previous
// verdict stands (docs/API-CONTRACT.md, "Change-gating").
//
// This is a similarity hash, not a fingerprint: it is 64 bits of 8x8 luminance,
// it never leaves this Mac, and it is thrown away when the app quits.

const SIZE = 8;                 // 8x8 cells → 64 bits
const BITS = SIZE * SIZE;
const HEX_LEN = BITS / 4;       // 16 hex characters
const MAX_DISTANCE = 3;         // "within a Hamming distance of 3"
const HASH_RE = /^[0-9a-f]{16}$/;

// Rec. 601 luma. Any consistent weighting works; this one matches what the eye
// notices, so a window swapping color but not layout still reads as a change.
function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

/**
 * Average-hash raw 4-byte-per-pixel image data.
 *
 * `pixels` is a Buffer/Uint8Array/array of length >= width*height*4.
 * `order` is 'bgra' (what Electron's nativeImage.toBitmap() returns on macOS)
 * or 'rgba'. The image is box-averaged down to 8x8, and each cell becomes one
 * bit: 1 when the cell is at or above the mean of all 64 cells.
 *
 * Returns 16 lowercase hex characters, most significant bit = top-left cell,
 * or null when the input cannot be hashed.
 */
function hashPixels(pixels, width, height, opts = {}) {
  const order = opts.order === 'rgba' ? 'rgba' : 'bgra';
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!pixels || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  if (pixels.length < w * h * 4) return null;

  const rIdx = order === 'rgba' ? 0 : 2;
  const bIdx = order === 'rgba' ? 2 : 0;

  const cells = new Array(BITS);
  let total = 0;
  for (let cy = 0; cy < SIZE; cy++) {
    const y0 = Math.floor((cy * h) / SIZE);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / SIZE));
    for (let cx = 0; cx < SIZE; cx++) {
      const x0 = Math.floor((cx * w) / SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / SIZE));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        for (let x = x0; x < x1 && x < w; x++) {
          const p = (y * w + x) * 4;
          sum += luma(pixels[p + rIdx], pixels[p + 1], pixels[p + bIdx]);
          n++;
        }
      }
      const value = n ? sum / n : 0;
      cells[cy * SIZE + cx] = value;
      total += value;
    }
  }

  const mean = total / BITS;
  let hex = '';
  for (let i = 0; i < BITS; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) if (cells[i + j] >= mean) nibble |= 1 << (3 - j);
    hex += nibble.toString(16);
  }
  return hex;
}

function isHash(v) { return typeof v === 'string' && HASH_RE.test(v); }

/** Number of differing bits, or Infinity when either side is not a hash. */
function hamming(a, b) {
  if (!isHash(a) || !isHash(b)) return Infinity;
  let d = 0;
  for (let i = 0; i < HEX_LEN; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * Hash one base64 JPEG through Electron's nativeImage (injected, so this file
 * still loads under plain Node). Returns null on anything unexpected — a null
 * hash disables gating for that tick, which costs a call and never skips one.
 */
function hashFrame(nativeImage, b64) {
  try {
    if (!nativeImage || typeof b64 !== 'string' || !b64) return null;
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (!img || img.isEmpty()) return null;
    const small = img.resize({ width: SIZE, height: SIZE, quality: 'good' });
    const size = small.getSize();
    return hashPixels(small.toBitmap(), size.width, size.height, { order: 'bgra' });
  } catch {
    return null;
  }
}

/** Hash every display of one capture. Null if any frame could not be hashed. */
function hashFrames(nativeImage, images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const out = [];
  for (const b64 of images) {
    const h = hashFrame(nativeImage, b64);
    if (!h) return null;
    out.push(h);
  }
  return out;
}

/**
 * True when every display is within `maxDistance` bits of where it was. A
 * different number of displays (a monitor plugged in) is always a change.
 */
function unchanged(prev, next, maxDistance = MAX_DISTANCE) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  if (prev.length === 0 || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!(hamming(prev[i], next[i]) <= maxDistance)) return false;
  }
  return true;
}

module.exports = { SIZE, BITS, MAX_DISTANCE, hashPixels, hashFrame, hashFrames, hamming, isHash, unchanged };
