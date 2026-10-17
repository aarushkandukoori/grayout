import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  STRIPE_API_VERSION, INTEGRATION_IDENTIFIER, configuredFlags, freeDailyBudget, longSecretOk,
  modelKeyOk, priceFor, stripeKeyOk, webhookSecretOk
} from '../src/config.js';
import { ApiVersion } from '../node_modules/stripe/esm/apiVersion.js';
import { parseJsonc } from './helpers.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(SERVER, path), 'utf8');
// Fake keys are joined at runtime: secret scanners flag key-shaped literals, even fake ones.
const fakeKey = (...parts) => parts.join('_');

describe('secret checks fail closed', () => {
  test('the webhook secret must be a real whsec_ of 32+ characters with no placeholder words', () => {
    assert.equal(webhookSecretOk('whsec_' + 'a1B2'.repeat(10)), true);
    // A real secret can hold three x's in a row by chance; it is still real.
    assert.equal(webhookSecretOk(fakeKey('whsec', 'XXX0123456789abcdefghijklmnopqrstuvwxyz')), true);
    for (const bad of [
      undefined, '', 'whsec_placeholder', 'whsec_test', 'whsec_replace_me',
      fakeKey('whsec', 'PLACEHOLDER0123456789abcdefghijklmnopqrstu'), fakeKey('whsec', 'example0123456789abcdefghijklmnopqrstu'),
      fakeKey('whsec', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), fakeKey('whsec', 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'),
      'whsec_xxx_paste_the_signing_secret_here_0123', 'whsec_' + '0'.repeat(40),
      'sk_live_' + 'a'.repeat(40)
    ]) {
      assert.equal(webhookSecretOk(bad), false, `${bad} must be refused`);
    }
  });

  test('the Stripe key is rk_ or sk_ and not a placeholder', () => {
    assert.equal(stripeKeyOk(fakeKey('rk', 'live', '51AbCdEf0123456789')), true);
    assert.equal(stripeKeyOk(fakeKey('sk', 'test', '51AbCdEf0123456789')), true);
    for (const bad of [undefined, '', 'rk_test_replace_me', 'pk_live_123', fakeKey('sk', 'live', 'placeholder'), fakeKey('rk', 'test', 'EXAMPLE123')]) {
      assert.equal(stripeKeyOk(bad), false, `${bad} must be refused`);
    }
  });

  test('device and license secrets need 32+ characters; the model key just has to be real', () => {
    assert.equal(longSecretOk('a'.repeat(32)), true);
    assert.equal(longSecretOk('a'.repeat(31)), false);
    assert.equal(longSecretOk('replace-me-with-openssl-rand-base64-48'), false);
    assert.equal(modelKeyOk('sk-proj-abc'), true);
    assert.equal(modelKeyOk('replace-me'), false);
    assert.equal(modelKeyOk(''), false);
  });

  test('health flags reflect each secret and the database binding', () => {
    assert.deepEqual(configuredFlags({}), { stripe: false, webhook: false, model: false, device: false, license: false, db: false, keyMode: false });
  });

  test('settings: budget parsing and price ids', () => {
    assert.equal(freeDailyBudget({}), 3000);
    assert.equal(freeDailyBudget({ FREE_DAILY_BUDGET: '0' }), 0);
    assert.equal(freeDailyBudget({ FREE_DAILY_BUDGET: 'lots' }), 3000);
    assert.equal(priceFor({ STRIPE_PRICE_YEARLY: 'price_y' }, 'yearly'), 'price_y');
    assert.equal(priceFor({ STRIPE_PRICE_MONTHLY: 'oops' }, 'monthly'), '');
  });
});

describe('Stripe version pins', () => {
  test('the API version is dahlia and equals the one the installed stripe-node pins', () => {
    assert.equal(STRIPE_API_VERSION, '2026-08-26.dahlia');
    assert.equal(ApiVersion, STRIPE_API_VERSION);
  });

  test('package.json asks for stripe ^22.6.0 and the installed one is 22.6 or newer', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.dependencies.stripe, '^22.6.0');
    const installed = JSON.parse(read('node_modules/stripe/package.json')).version.split('.').map(Number);
    assert.equal(installed[0], 22);
    assert.ok(installed[1] >= 6);
  });

  test('the integration identifier is grayout_pro_ plus 8 letters', () => {
    assert.match(INTEGRATION_IDENTIFIER, /^grayout_pro_[a-z]{8}$/);
  });
});

describe('wrangler.jsonc', () => {
  const config = parseJsonc(read('wrangler.jsonc'));

  const sandbox = config.env.sandbox;

  test('D1 is bound as DB, with a placeholder id the deploy script fills; live and sandbox never share one', () => {
    for (const [worker, name, placeholder] of [
      [config, 'grayout', '__GRAYOUT_D1_DATABASE_ID__'],
      [sandbox, 'grayout-sandbox', '__GRAYOUT_SANDBOX_D1_DATABASE_ID__']
    ]) {
      assert.equal(worker.d1_databases.length, 1);
      assert.equal(worker.d1_databases[0].binding, 'DB');
      assert.equal(worker.d1_databases[0].database_name, name);
      // Before deploy.sh runs it is the placeholder; after, a real D1 database id.
      const id = worker.d1_databases[0].database_id;
      assert.ok(id === placeholder || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id), `${name}: ${id}`);
      assert.equal(worker.d1_databases[0].migrations_dir, 'migrations');
    }
    assert.notEqual(config.d1_databases[0].database_id, sandbox.d1_databases[0].database_id, 'live and sandbox never share a database');
    assert.equal(sandbox.name, 'grayout-api-sandbox');
    assert.equal(config.kv_namespaces, undefined, 'KV is gone');
  });

  test('the seven rate limiters from contract section 11, with separate namespaces for the sandbox', () => {
    const limits = { RL_MINT: 3, RL_IP: 120, RL_STRIPE_IP: 10, RL_FREE_IP: 4, RL_DEVICE: 40, RL_LICENSE: 20, RL_CHECK_IP: 60 };
    const namespaces = { RL_MINT: '01', RL_IP: '02', RL_STRIPE_IP: '03', RL_FREE_IP: '04', RL_DEVICE: '05', RL_LICENSE: '06', RL_CHECK_IP: '07' };
    for (const [worker, prefix] of [[config, '10'], [sandbox, '20']]) {
      const byName = Object.fromEntries(worker.ratelimits.map(r => [r.name, r]));
      assert.deepEqual(Object.keys(byName).sort(), Object.keys(limits).sort());
      for (const [name, limit] of Object.entries(limits)) {
        assert.equal(byName[name].namespace_id, prefix + namespaces[name]);
        assert.deepEqual(byName[name].simple, { limit, period: 60 });
      }
    }
  });

  test('vars: the live Worker sells nothing until its live ids are filled in; the sandbox has the sandbox ids', () => {
    const live = config.vars;
    assert.equal(live.SITE_URL, 'https://aarushkandukoori.github.io/grayout');
    assert.equal(live.SITE_ORIGINS, 'https://aarushkandukoori.github.io');
    assert.equal(live.STRIPE_PRODUCT, '');
    assert.equal(live.STRIPE_PRICE_MONTHLY, '');
    assert.equal(live.STRIPE_PRICE_YEARLY, '');
    assert.equal(live.ALLOW_TEST_LICENSES, undefined, 'the live Worker never serves test licenses');
    assert.equal(live.FREE_DAILY_BUDGET, '3000');

    const test = sandbox.vars;
    assert.equal(test.STRIPE_PRODUCT, 'prod_VOwDoJ9qK3jgr2');
    assert.equal(test.STRIPE_PRICE_MONTHLY, 'price_1UO8KkPV4dR0vRRs2iGyzRYY');
    assert.equal(test.STRIPE_PRICE_YEARLY, 'price_1UO8KmPV4dR0vRRs5AshLGsJ');
    assert.equal(test.ALLOW_TEST_LICENSES, '1');
    assert.deepEqual(Object.keys(test).sort(), [...Object.keys(live), 'ALLOW_TEST_LICENSES'].sort(), 'the sandbox sets every var the live Worker does');
    assert.equal(JSON.stringify(config).includes('grayout.app'), false);
  });

  test('the daily cleanup cron is scheduled', () => {
    assert.deepEqual(config.triggers.crons, ['17 4 * * *']);
  });

  test('logs keep our own lines but no per-request invocation logs or traces (they hold the client IP)', () => {
    assert.equal(config.observability.enabled, true);
    assert.deepEqual(config.observability.logs, { enabled: true, invocation_logs: false });
    assert.deepEqual(config.observability.traces, { enabled: false });
    // wrangler copies the top-level block into an environment that sets none.
    assert.equal(sandbox.observability, undefined, 'the sandbox inherits the same settings');
    // The installed wrangler knows the key (a typo would be silently ignored).
    const schema = JSON.parse(read('node_modules/wrangler/config-schema.json'));
    assert.ok(schema.definitions.Observability.properties.logs.properties.invocation_logs);
  });

  test('the go-live step that wrangler.jsonc points at is the README\'s go-live step', () => {
    const text = read('wrangler.jsonc');
    const steps = [...text.matchAll(/README step\s+(\d+)/g)].map(m => m[1]);
    assert.ok(steps.length > 0);
    for (const n of steps) assert.match(read('README.md'), new RegExp(`^${n}\\. \\*\\*Go live\\.\\*\\*`, 'm'));
  });
});

describe('the runbook and example settings', () => {
  const readme = read('README.md');
  const devVars = read('.dev.vars.example');

  test('no publicly known webhook secret is ever suggested', () => {
    assert.equal(readme.includes('whsec_placeholder'), false);
    assert.equal(/STRIPE_WEBHOOK_SECRET=whsec_[A-Za-z0-9]{32,}/.test(devVars), false);
    assert.equal(webhookSecretOk(/STRIPE_WEBHOOK_SECRET=(\S+)/.exec(devVars)[1]), false);
  });

  test('restricted keys and sandboxes, not sk_ keys and shared test mode', () => {
    assert.match(readme, /restricted key/i);
    assert.match(readme, /rk_test_/);
    assert.equal(/secret put STRIPE_SECRET_KEY\s+#\s*sk_/.test(readme), false);
    assert.match(devVars, /STRIPE_SECRET_KEY=rk_test_/);
    assert.match(readme, /sandbox/i);
  });

  test('the webhook step pins dahlia and lists exactly the 12 events', () => {
    assert.match(readme, /API version: `2026-08-26\.dahlia`/);
    const events = [
      'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
      'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
      'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.paid', 'invoice.payment_failed',
      'charge.refunded', 'charge.dispute.created'
    ];
    for (const e of events) assert.ok(readme.includes(`\`${e}\``), `${e} is listed`);
  });

  test('the portal step turns on plan switching and end-of-period cancellation', () => {
    assert.match(readme, /switch\s+plans/i);
    assert.match(readme, /at the end of\s+the billing period/i);
    assert.match(readme, /Cancel the subscription/);
    assert.match(readme, /Managed Payments/);
  });
});
