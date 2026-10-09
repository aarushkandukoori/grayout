import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_ID_RE, DEVICE_TOKEN_RE, LICENSE_RE, constantTimeEqual, deviceTokenFor, formatDeviceCode,
  ipHashFor, licenseKeyFor, maskSessionId, newDeviceCode, newDeviceId, normalizeDeviceCode,
  normalizeLicense, sha256Hex
} from '../src/ids.js';
import { ipKeyFor, scrub } from '../src/http.js';
import { iso, monthKey, dayKey, nextMonthStart, monthKeyMonthsAgo } from '../src/time.js';

const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstu';

describe('device ids and tokens', () => {
  test('a device id is dev_ + 26 Crockford symbols, and each is new', () => {
    const ids = new Set(Array.from({ length: 200 }, newDeviceId));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, DEVICE_ID_RE);
  });

  test('a token is 43 base64url characters and depends on the secret and the id', async () => {
    const id = newDeviceId();
    const token = await deviceTokenFor(SECRET, id);
    assert.match(token, DEVICE_TOKEN_RE);
    assert.equal(await deviceTokenFor(SECRET, id), token, 'recomputed, never stored');
    assert.notEqual(await deviceTokenFor(SECRET + 'x', id), token);
    assert.notEqual(await deviceTokenFor(SECRET, newDeviceId()), token);
  });

  test('the IP hash is 32 hex characters and is not the address', async () => {
    const hash = await ipHashFor(SECRET, '203.0.113.7');
    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.equal(hash.includes('203'), false);
  });
});

describe('license keys', () => {
  test('derived from the customer: same customer, same key; another customer, another key', async () => {
    const a = await licenseKeyFor(SECRET, 'cus_A');
    assert.match(a, LICENSE_RE);
    assert.ok(a.startsWith('gry_live_'));
    assert.equal(await licenseKeyFor(SECRET, 'cus_A'), a);
    assert.notEqual(await licenseKeyFor(SECRET, 'cus_B'), a);
    assert.notEqual(await licenseKeyFor(SECRET, 'cus_A', 2), a, 'a new generation replaces one key');
  });

  test('sandbox customers get gry_test_ keys', async () => {
    assert.match(await licenseKeyFor(SECRET, 'cus_A', 1, false), /^gry_test_[0-9A-HJKMNP-TV-Z]{24}$/);
  });

  test('a pasted key is normalized: case, spaces, dashes and look-alike letters', async () => {
    const key = await licenseKeyFor(SECRET, 'cus_A');
    const body = key.slice('gry_live_'.length);
    const messy = ` GRY_LIVE_${body.slice(0, 12).toLowerCase()}-${body.slice(12)} `;
    assert.equal(normalizeLicense(messy), key);
    assert.equal(normalizeLicense('gry_live_' + '0'.repeat(23).replace(/0/g, 'O') + '1'), 'gry_live_' + '0'.repeat(23) + '1');
    assert.equal(normalizeLicense('gry_live_short'), '');
    assert.equal(normalizeLicense('sk_live_whatever'), '');
    assert.equal(normalizeLicense(42), '');
  });

  test('only the hash is stored: 64 hex characters', async () => {
    assert.match(await sha256Hex('gry_live_X'), /^[0-9a-f]{64}$/);
  });
});

describe('device codes', () => {
  test('8 symbols, shown as XXXX-XXXX, read back with or without the dash, any case', () => {
    const code = newDeviceCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    const shown = formatDeviceCode(code);
    assert.match(shown, /^.{4}-.{4}$/);
    assert.equal(normalizeDeviceCode(shown), code);
    assert.equal(normalizeDeviceCode(shown.toLowerCase()), code);
    assert.equal(normalizeDeviceCode('7kq2-r9xw'), '7KQ2R9XW');
    assert.equal(normalizeDeviceCode('abc'), '');
    assert.equal(normalizeDeviceCode(null), '');
  });
});

describe('constant-time comparison', () => {
  test('equal strings match; anything else does not', () => {
    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
    assert.equal(constantTimeEqual('', ''), false);
    assert.equal(constantTimeEqual(null, null), false);
  });
});

describe('the caller IP key', () => {
  const req = ip => new Request('https://x.test/', { headers: ip ? { 'CF-Connecting-IP': ip } : {} });
  test('IPv4 is the full address, IPv6 is its /64, and no header is "local"', () => {
    assert.equal(ipKeyFor(req('203.0.113.7')), '203.0.113.7');
    assert.equal(ipKeyFor(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd')), '2001:db8:1:2::/64');
    assert.equal(ipKeyFor(req('2001:db8:1:2::5')), '2001:db8:1:2::/64');
    assert.equal(ipKeyFor(req('2001:db8::1')), '2001:db8:0:0::/64');
    assert.equal(ipKeyFor(req('::ffff:198.51.100.4')), '198.51.100.4');
    assert.equal(ipKeyFor(req(null)), 'local');
  });
});

describe('log scrubbing', () => {
  test('keys, session ids and secrets never reach a log line whole', () => {
    const line = scrub('key gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D session cs_test_a1b2c3d4e5f6g7h8 rk_live_abc123 whsec_abcdef123');
    assert.equal(line.includes('7KQ2R9XW'), false);
    assert.equal(line.includes('a1b2c3d4e5f6'), false);
    assert.ok(line.includes('g7h8'), 'a session id keeps its last 4');
    assert.equal(line.includes('abc123'), false);
    assert.equal(line.includes('abcdef123'), false);
    assert.equal(maskSessionId('cs_test_a1b2c3d4'), '…c3d4');
  });
});

describe('time helpers', () => {
  const t = Date.parse('2026-12-31T23:59:59Z') / 1000;
  test('ISO without milliseconds, month and day keys, next month, months ago', () => {
    assert.equal(iso(t), '2026-12-31T23:59:59Z');
    assert.equal(iso(null), null);
    assert.equal(monthKey(t), '2026-12');
    assert.equal(dayKey(t), '2026-12-31');
    assert.equal(iso(nextMonthStart(t)), '2027-01-01T00:00:00Z');
    assert.equal(monthKeyMonthsAgo(t, 13), '2025-11');
  });
});
