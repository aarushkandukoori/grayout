import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_LENGTH, CROCKFORD, PREFIX, constantTimeEqual, generateDeviceCode,
  generateLicense, isDeviceCodeShape, isLicenseShape, maskLicense,
  normalizeDeviceCode, normalizeLicense
} from '../src/license.js';

describe('the alphabet', () => {
  test('is Crockford base32: 32 symbols, no I, L, O or U', () => {
    assert.equal(CROCKFORD.length, 32);
    assert.equal(new Set(CROCKFORD).size, 32);
    for (const c of 'ILOU') assert.equal(CROCKFORD.includes(c), false, `${c} must not be in the alphabet`);
    assert.equal(CROCKFORD.slice(0, 10), '0123456789');
  });
});

describe('generateLicense', () => {
  test('is gry_live_ plus 24 Crockford symbols', () => {
    for (let i = 0; i < 200; i++) {
      const key = generateLicense();
      assert.match(key, /^gry_live_[0-9A-HJKMNP-TV-Z]{24}$/);
      assert.equal(key.length, PREFIX.length + BODY_LENGTH);
      assert.ok(isLicenseShape(key));
    }
  });

  test('does not repeat itself', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(generateLicense());
    assert.equal(seen.size, 500);
  });

  test('uses the whole alphabet, so no symbol is quietly unreachable', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) for (const c of generateLicense().slice(PREFIX.length)) seen.add(c);
    assert.equal(seen.size, 32);
  });
});

describe('isLicenseShape', () => {
  const good = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';
  test('accepts the contract example', () => assert.ok(isLicenseShape(good)));
  test('rejects a wrong prefix', () => assert.equal(isLicenseShape(good.replace('gry_live_', 'gry_test_')), false));
  test('rejects a missing prefix', () => assert.equal(isLicenseShape(good.slice(PREFIX.length)), false));
  test('rejects the wrong length', () => {
    assert.equal(isLicenseShape(good + 'X'), false);
    assert.equal(isLicenseShape(good.slice(0, -1)), false);
  });
  test('rejects the ambiguous letters', () => {
    for (const c of 'ILOU') assert.equal(isLicenseShape(PREFIX + c.repeat(24)), false);
  });
  test('rejects lower case in the body', () => assert.equal(isLicenseShape(good.toLowerCase()), false));
  test('rejects things that are not strings', () => {
    for (const v of [null, undefined, 42, {}, []]) assert.equal(isLicenseShape(v), false);
  });
});

describe('normalizeLicense', () => {
  const canonical = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';

  test('leaves a canonical key alone', () => assert.equal(normalizeLicense(canonical), canonical));

  test('folds the look-alikes a person types: I and L become 1, O becomes 0', () => {
    const typed = 'GRY_LIVE_7KQ2R9XW4MOZT8VN3HJ5CB6D'.replace('0', 'O');
    assert.equal(normalizeLicense(typed), canonical);
    assert.equal(normalizeLicense('gry_live_' + 'I'.repeat(24)), 'gry_live_' + '1'.repeat(24));
    assert.equal(normalizeLicense('gry_live_' + 'l'.repeat(24)), 'gry_live_' + '1'.repeat(24));
  });

  test('strips spaces and dashes and adds a missing prefix', () => {
    assert.equal(normalizeLicense(' 7KQ2-R9XW-4M0Z-T8VN-3HJ5-CB6D '), canonical);
    assert.equal(normalizeLicense('gry_live_7KQ2 R9XW 4M0Z T8VN 3HJ5 CB6D'), canonical);
  });

  test('does not invent a valid key out of nothing', () => {
    assert.equal(isLicenseShape(normalizeLicense('')), false);
    assert.equal(isLicenseShape(normalizeLicense(null)), false);
    assert.equal(isLicenseShape(normalizeLicense('hello')), false);
  });
});

describe('constantTimeEqual', () => {
  const key = 'gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D';

  test('matches a key against itself', () => assert.equal(constantTimeEqual(key, key), true));

  test('rejects a key that differs anywhere', () => {
    for (const i of [0, 9, 10, 20, key.length - 1]) {
      const c = key[i] === 'X' ? 'Y' : 'X';
      const guess = key.slice(0, i) + c + key.slice(i + 1);
      assert.equal(constantTimeEqual(key, guess), false, `differs at ${i}`);
    }
  });

  test('rejects a prefix, a suffix and a longer string', () => {
    assert.equal(constantTimeEqual(key, key.slice(0, -1)), false);
    assert.equal(constantTimeEqual(key, key + 'X'), false);
    assert.equal(constantTimeEqual(key, PREFIX), false);
  });

  test('two missing secrets are not a match', () => {
    assert.equal(constantTimeEqual('', ''), false);
    assert.equal(constantTimeEqual(null, null), false);
    assert.equal(constantTimeEqual(undefined, undefined), false);
    assert.equal(constantTimeEqual(key, null), false);
  });

  test('compares every byte: no early exit hides in the loop', () => {
    // A timing measurement would be flaky on a shared machine. This asserts the
    // property that makes the function constant time instead: the loop runs to
    // the end whatever it finds.
    const src = constantTimeEqual.toString();
    const loop = src.slice(src.indexOf('for ('), src.indexOf('return diff === 0'));
    assert.ok(loop.length > 0, 'the loop should be findable');
    assert.equal(/\breturn\b/.test(loop), false, 'no return inside the comparison loop');
    assert.equal(/\bbreak\b/.test(loop), false, 'no break inside the comparison loop');
    assert.equal(/&&|\|\|/.test(loop), false, 'no short-circuiting inside the comparison loop');
  });
});

describe('maskLicense', () => {
  test('keeps the prefix and the last four characters', () => {
    assert.equal(maskLicense('gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D'), 'gry_live_…CB6D');
  });
  test('never returns more than the prefix and four symbols', () => {
    const masked = maskLicense(generateLicense());
    assert.equal(masked.length, PREFIX.length + 1 + 4);
  });
  test('handles a short or empty value without throwing', () => {
    assert.equal(maskLicense(''), '');
    assert.equal(maskLicense('AB'), 'gry_live_…AB');
    assert.equal(maskLicense(null), '');
  });
});

describe('device codes', () => {
  test('are eight Crockford symbols shown as XXXX-XXXX', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateDeviceCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.ok(isDeviceCodeShape(normalizeDeviceCode(code)));
    }
  });

  test('normalize the way a person would mistype them', () => {
    assert.equal(normalizeDeviceCode('abcd-efgh'), 'ABCDEFGH');
    assert.equal(normalizeDeviceCode(' ab cd ef gh '), 'ABCDEFGH');
    assert.equal(normalizeDeviceCode('OIL0-1234'), '0110-1234'.replace('-', ''));
  });

  test('reject anything that is not eight symbols', () => {
    assert.equal(isDeviceCodeShape('ABCDEFG'), false);
    assert.equal(isDeviceCodeShape('ABCDEFGHI'), false);
    assert.equal(isDeviceCodeShape('ABCD-EFGH'), false, 'the dash is display only');
  });
});
