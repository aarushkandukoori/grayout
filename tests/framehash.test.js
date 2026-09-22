'use strict';
// The 8x8 average hash behind change-gating. Every expectation here is a hash
// worked out by hand from the pixels, so a change in bit order, in the
// luminance weights, or in the downsampling shows up as a different string.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('framehash');
const framehash = require('../src/framehash');
const { hashPixels, hashFrame, hashFrames, hamming, isHash, unchanged, SIZE, BITS, MAX_DISTANCE } = framehash;

after(() => helpers.cleanup(dir));

/** 64 gray levels (row-major, one per cell) → an 8x8 4-byte-per-pixel buffer. */
function grayBuffer(cells) {
  const buf = Buffer.alloc(cells.length * 4);
  cells.forEach((v, i) => { buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = 255; });
  return buf;
}

/** width*height gray levels at an arbitrary size. */
function grayImage(values) { return grayBuffer(values); }

const fill = v => new Array(64).fill(v);
const byCell = fn => Array.from({ length: 64 }, (_, i) => fn(i % SIZE, Math.floor(i / SIZE)));

describe('hashPixels: known bit patterns', () => {
  test('a flat image is all ones (every cell is at the mean)', () => {
    assert.equal(hashPixels(grayBuffer(fill(0)), 8, 8), 'ffffffffffffffff');
    assert.equal(hashPixels(grayBuffer(fill(255)), 8, 8), 'ffffffffffffffff');
    assert.equal(hashPixels(grayBuffer(fill(37)), 8, 8), 'ffffffffffffffff');
  });

  test('left half dark, right half light → 0f repeated (one nibble per 4 cells)', () => {
    const cells = byCell(x => (x < 4 ? 0 : 255));
    assert.equal(hashPixels(grayBuffer(cells), 8, 8), '0f0f0f0f0f0f0f0f');
  });

  test('top half dark, bottom half light → the first 32 bits are zero', () => {
    const cells = byCell((_x, y) => (y < 4 ? 0 : 255));
    assert.equal(hashPixels(grayBuffer(cells), 8, 8), '00000000ffffffff');
  });

  test('a per-cell checkerboard → 5 or a repeated', () => {
    assert.equal(hashPixels(grayBuffer(byCell(x => (x % 2 ? 255 : 0))), 8, 8), '5555555555555555');
    // Rows alternate 0101 (0x5) and 1010 (0xa).
    assert.equal(hashPixels(grayBuffer(byCell((x, y) => ((x + y) % 2 ? 255 : 0))), 8, 8), '55aa55aa55aa55aa');
  });

  test('bit order is row-major with the top-left cell most significant', () => {
    const one = fill(0); one[0] = 255;
    assert.equal(hashPixels(grayBuffer(one), 8, 8), '8000000000000000');
    const last = fill(0); last[63] = 255;
    assert.equal(hashPixels(grayBuffer(last), 8, 8), '0000000000000001');
    const fifth = fill(0); fifth[4] = 255;
    assert.equal(hashPixels(grayBuffer(fifth), 8, 8), '0800000000000000');
  });

  test('it is a similarity hash: one cell crossing the mean moves exactly one bit', () => {
    const base = byCell(x => (x < 4 ? 0 : 255));
    const moved = base.slice(); moved[0] = 255;
    assert.equal(hamming(hashPixels(grayBuffer(base), 8, 8), hashPixels(grayBuffer(moved), 8, 8)), 1);
  });

  test('64 bits, 16 hex characters, always', () => {
    assert.equal(BITS, 64);
    assert.equal(SIZE, 8);
    assert.equal(hashPixels(grayBuffer(fill(9)), 8, 8).length, 16);
    assert.ok(isHash(hashPixels(grayBuffer(byCell(x => x * 30)), 8, 8)));
  });
});

describe('hashPixels: downsampling and colour', () => {
  test('a 16x16 image box-averages into the same 8x8 hash', () => {
    const big = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) big.push(x < 8 ? 0 : 255);
    assert.equal(hashPixels(grayImage(big), 16, 16), '0f0f0f0f0f0f0f0f');
  });

  test('a size that is not a multiple of 8 still produces a hash', () => {
    const odd = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) odd.push(y < 5 ? 0 : 255);
    assert.equal(hashPixels(grayImage(odd), 10, 10), '00000000ffffffff');
  });

  test('byte order matters: bgra (Electron) and rgba read a colour differently', () => {
    // Left half is 255 in the first channel, right half 255 in the third.
    const buf = Buffer.alloc(64 * 4);
    for (let i = 0; i < 64; i++) {
      const left = (i % SIZE) < 4;
      buf[i * 4] = left ? 255 : 0;
      buf[i * 4 + 1] = 0;
      buf[i * 4 + 2] = left ? 0 : 255;
      buf[i * 4 + 3] = 255;
    }
    // rgba: the left half is red (luma .299), brighter than blue (.114).
    assert.equal(hashPixels(buf, 8, 8, { order: 'rgba' }), 'f0f0f0f0f0f0f0f0');
    // bgra: the same bytes mean the left half is blue, so the bits invert.
    assert.equal(hashPixels(buf, 8, 8, { order: 'bgra' }), '0f0f0f0f0f0f0f0f');
    assert.equal(hashPixels(buf, 8, 8), hashPixels(buf, 8, 8, { order: 'bgra' }), 'bgra is the default');
  });

  test('unusable input hashes to null rather than throwing', () => {
    assert.equal(hashPixels(null, 8, 8), null);
    assert.equal(hashPixels(grayBuffer(fill(0)), 0, 8), null);
    assert.equal(hashPixels(grayBuffer(fill(0)), 8, 0), null);
    assert.equal(hashPixels(grayBuffer(fill(0)), 'x', 8), null);
    assert.equal(hashPixels(Buffer.alloc(8), 8, 8), null, 'buffer too small for the stated size');
  });
});

describe('hamming', () => {
  test('identical is 0, inverted is 64', () => {
    assert.equal(hamming('ffffffffffffffff', 'ffffffffffffffff'), 0);
    assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
    assert.equal(hamming('0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0'), 64);
  });

  test('counts single bits', () => {
    assert.equal(hamming('0000000000000000', '8000000000000000'), 1);
    assert.equal(hamming('0000000000000000', '0000000000000001'), 1);
    assert.equal(hamming('0000000000000000', '000000000000000f'), 4);
    assert.equal(hamming('0000000000000000', '0000000000000007'), 3);
  });

  test('anything that is not a hash is infinitely far away', () => {
    for (const bad of [null, undefined, '', 'zzzz', 'FFFFFFFFFFFFFFFF', '0f0f', 42, {}]) {
      assert.equal(hamming('0000000000000000', bad), Infinity, String(bad));
      assert.equal(hamming(bad, '0000000000000000'), Infinity, String(bad));
    }
    assert.equal(isHash('FFFFFFFFFFFFFFFF'), false, 'lowercase only');
  });
});

describe('unchanged', () => {
  const A = '0f0f0f0f0f0f0f0f';

  test('within the distance is unchanged, past it is not', () => {
    assert.equal(MAX_DISTANCE, 3);
    assert.equal(unchanged([A], [A]), true);
    assert.equal(unchanged([A], ['0f0f0f0f0f0f0f0e']), true, '1 bit');
    assert.equal(unchanged([A], ['0f0f0f0f0f0f0f08']), true, '3 bits');
    assert.equal(unchanged([A], ['0f0f0f0f0f0f0f00']), false, '4 bits');
    assert.equal(unchanged([A], ['0f0f0f0f0f0f0f08'], 2), false, 'tighter bound');
  });

  test('every display has to match', () => {
    assert.equal(unchanged([A, A], [A, A]), true);
    assert.equal(unchanged([A, A], [A, 'f0f0f0f0f0f0f0f0']), false);
  });

  test('a different number of displays, an empty list, or a bad hash is a change', () => {
    assert.equal(unchanged([A], [A, A]), false);
    assert.equal(unchanged([], []), false);
    assert.equal(unchanged(null, [A]), false);
    assert.equal(unchanged([A], null), false);
    assert.equal(unchanged([A], [null]), false);
    assert.equal(unchanged(['nonsense'], ['nonsense']), false);
  });
});

describe('hashFrame / hashFrames through a nativeImage', () => {
  const bitmap = grayBuffer(byCell(x => (x < 4 ? 0 : 255)));
  const fakeImage = (over = {}) => ({
    isEmpty: () => false,
    resize: () => ({ getSize: () => ({ width: 8, height: 8 }), toBitmap: () => bitmap }),
    ...over
  });
  const nativeImage = over => ({ createFromBuffer: () => fakeImage(over) });

  test('a frame hashes through resize + toBitmap', () => {
    assert.equal(hashFrame(nativeImage(), 'AAAA'), '0f0f0f0f0f0f0f0f');
    assert.deepEqual(hashFrames(nativeImage(), ['AAAA', 'BBBB']), ['0f0f0f0f0f0f0f0f', '0f0f0f0f0f0f0f0f']);
  });

  test('anything unexpected hashes to null, which disables gating rather than skipping', () => {
    assert.equal(hashFrame(null, 'AAAA'), null);
    assert.equal(hashFrame(nativeImage(), ''), null);
    assert.equal(hashFrame(nativeImage(), 42), null);
    assert.equal(hashFrame(nativeImage({ isEmpty: () => true }), 'AAAA'), null);
    assert.equal(hashFrame({ createFromBuffer: () => { throw new Error('decode failed'); } }, 'AAAA'), null);
    assert.equal(hashFrames(nativeImage(), []), null);
    assert.equal(hashFrames(nativeImage(), null), null);
  });

  test('one unhashable display makes the whole capture unhashable', () => {
    let n = 0;
    const flaky = { createFromBuffer: () => (++n === 2 ? fakeImage({ isEmpty: () => true }) : fakeImage()) };
    assert.equal(hashFrames(flaky, ['A', 'B']), null);
  });
});
