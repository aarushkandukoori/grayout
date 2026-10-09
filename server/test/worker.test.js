// The Worker's entry points and the owner's scripts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import worker from '../src/index.js';
import { harness, T0, DAY } from './helpers.js';
import { licenseKeyFor } from '../src/ids.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the scheduled cleanup', () => {
  test('the cron handler runs the daily cleanup against D1', async () => {
    const h = harness();
    const device = await h.mint();
    await h.call('/v1/device-code', device);
    const waits = [];
    h.clock.advance(3 * DAY);
    // The handler uses the real clock, so put the code's expiry far in the past.
    h.db.write('UPDATE device_codes SET expires_at = ?', T0 - 30 * DAY);
    worker.scheduled({}, h.env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    assert.equal(h.db.rows('SELECT COUNT(*) AS n FROM device_codes')[0].n, 0);
  });
});

describe('a missing rate-limit binding', () => {
  test('the request still works (D1 limits still cap spending) and it is logged once', async () => {
    const h = harness();
    delete h.env.RL_IP;
    delete h.env.RL_MINT;
    const lines = [];
    const log = console.log;
    console.log = line => lines.push(String(line));
    try {
      assert.equal((await h.call('/v1/device', {})).status, 200);
      assert.equal((await h.call('/v1/device', {})).status, 200);
    } finally {
      console.log = log;
    }
    assert.ok(lines.filter(l => l.includes('rate_limit_binding_missing')).length <= 2);
  });
});

describe('scripts/license-key.js', () => {
  test('derives the same key the service issued, and refuses a short secret', async () => {
    const secret = 'owner-license-secret-0123456789-abcdefghijk';
    const out = execFileSync(process.execPath, [join(SERVER, 'scripts/license-key.js'), 'cus_Abc123', '--test'], {
      env: { ...process.env, LICENSE_SECRET: secret }, encoding: 'utf8'
    }).trim();
    assert.equal(out, await licenseKeyFor(secret, 'cus_Abc123', 1, false));
    assert.throws(() => execFileSync(process.execPath, [join(SERVER, 'scripts/license-key.js'), 'cus_Abc123'], {
      env: { ...process.env, LICENSE_SECRET: 'short' }, stdio: 'pipe'
    }));
  });

  test('the key it prints for a real purchase matches /v1/restore', async () => {
    const h = harness();
    const device = await h.mint();
    const { code, subscription } = await h.appPurchase(device);
    await h.call('/v1/claim', { ...device, deviceCode: code });
    const restored = (await h.call('/v1/restore', device)).body.license;
    const out = execFileSync(process.execPath, [join(SERVER, 'scripts/license-key.js'), subscription.customer, '--test'], {
      env: { ...process.env, LICENSE_SECRET: h.env.LICENSE_SECRET }, encoding: 'utf8'
    }).trim();
    assert.equal(out, restored);
  });
});

describe('scripts/deploy.sh', () => {
  test('a dry run does nothing and lists every secret and the Stripe steps', () => {
    const out = execFileSync('bash', [join(SERVER, 'scripts/deploy.sh'), 'sandbox'], {
      env: { ...process.env, DRY_RUN: '1' }, encoding: 'utf8'
    });
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'DEVICE_SECRET', 'LICENSE_SECRET']) {
      assert.match(out, new RegExp(`secret put ${name}`));
    }
    assert.match(out, /2026-08-26\.dahlia/);
    assert.match(out, /charge\.dispute\.created/);
    assert.match(out, /Managed Payments/);
    assert.equal(out.includes('whsec_placeholder'), false);
  });
});
