// Device identity: /v1/device, verification, /v1/device-code, /v1/restore.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { harness } from './helpers.js';
import { DEVICE_ID_RE, DEVICE_TOKEN_RE, newDeviceId, deviceTokenFor } from '../src/ids.js';

describe('POST /v1/device', () => {
  test('mints a device id and token, and stores a keyed hash of the network, never the IP', async () => {
    const h = harness();
    const device = await h.mint('203.0.113.7');
    assert.match(device.deviceId, DEVICE_ID_RE);
    assert.match(device.deviceToken, DEVICE_TOKEN_RE);
    const row = h.db.rows('SELECT * FROM devices')[0];
    assert.equal(row.device_id, device.deviceId);
    assert.match(row.mint_ip_hash, /^[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(h.db.rows('SELECT * FROM devices')).includes('203.0.113.7'), false);
    assert.equal(JSON.stringify(h.db.rows('SELECT * FROM devices')).includes(device.deviceToken), false, 'tokens are not stored');
  });

  test('RL_MINT: 3 a minute per IP', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.mint();
    const res = await h.call('/v1/device', {});
    assert.equal(res.status, 429);
    assert.equal(res.body.error.retryAfter, 60);
  });

  test('at most 10 new devices per network per rolling hour, even when the minute limiter resets', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.limiters.RL_MINT.reset();
      await h.mint();
    }
    h.limiters.RL_MINT.reset();
    const res = await h.call('/v1/device', {});
    assert.equal(res.status, 429);
    assert.equal(res.body.error.retryAfter, 600);
    h.clock.advance(3601);
    assert.equal((await h.call('/v1/device', {})).status, 200);
  });

  test('IPv6 neighbours in one /56 share the limit, so rotating /64s does not help', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.mint(`2001:db8:1:${i + 2}::1`);
    assert.equal((await h.call('/v1/device', {}, { ip: '2001:db8:1:ff::99' })).status, 429, 'another /64 in the same /56');
    assert.equal((await h.call('/v1/device', {}, { ip: '2001:db8:1:100::1' })).status, 200, 'the next /56');
  });

  test('without DEVICE_SECRET it is 503 not_configured', async () => {
    const h = harness({ env: { DEVICE_SECRET: '' } });
    const res = await h.call('/v1/device', {});
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'not_configured');
  });
});

describe('device verification', () => {
  test('a made-up id, a wrong token, a missing token, or a well-signed id with no row are all 401', async () => {
    const h = harness();
    const real = await h.mint();
    const madeUp = newDeviceId();
    const cases = [
      {},
      { deviceId: real.deviceId },
      { deviceId: real.deviceId, deviceToken: 'A'.repeat(43) },
      { deviceId: madeUp, deviceToken: real.deviceToken },
      // A correct token for an id the server never stored (as if DEVICE_SECRET leaked).
      { deviceId: madeUp, deviceToken: await deviceTokenFor(h.env.DEVICE_SECRET, madeUp) },
      { deviceId: 'my-own-chosen-id-12345', deviceToken: real.deviceToken }
    ];
    for (const body of cases) {
      const res = await h.call('/v1/restore', body);
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.equal(res.body.error.code, 'device_unverified');
    }
    assert.equal((await h.call('/v1/restore', real)).status, 200);
  });

  test('rotating DEVICE_SECRET unverifies every device', async () => {
    const h = harness();
    const device = await h.mint();
    h.env.DEVICE_SECRET = 'a-brand-new-device-secret-0123456789abcdef';
    assert.equal((await h.call('/v1/restore', device)).body.error.code, 'device_unverified');
  });
});

describe('POST /v1/device-code', () => {
  test('a code shown as XXXX-XXXX that lives an hour', async () => {
    const h = harness();
    const device = await h.mint();
    const res = await h.call('/v1/device-code', device);
    assert.equal(res.status, 200);
    assert.match(res.body.deviceCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(res.body.expiresIn, 3600);
    const row = h.db.rows('SELECT * FROM device_codes')[0];
    assert.equal(row.code, res.body.deviceCode.replace('-', ''));
    assert.equal(row.device_id, device.deviceId);
    assert.equal(row.expires_at - row.created_at, 3600);
  });

  test('needs a verified device', async () => {
    const h = harness();
    assert.equal((await h.call('/v1/device-code', { deviceId: newDeviceId(), deviceToken: 'x'.repeat(43) })).status, 401);
  });
});

describe('POST /v1/restore', () => {
  test('none for a device with no license; the key for a device that bought one', async () => {
    const h = harness();
    const device = await h.mint();
    assert.deepEqual((await h.call('/v1/restore', device)).body, { status: 'none' });
    const { code } = await h.appPurchase(device);
    const claim = await h.call('/v1/claim', { ...device, deviceCode: code });
    const restore = await h.call('/v1/restore', device);
    assert.deepEqual(restore.body, { status: 'ready', license: claim.body.license });
  });
});
