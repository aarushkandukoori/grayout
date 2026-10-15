// The owner's scripts: set-secrets.sh (and the Stripe-answer check it uses)
// and deploy.sh's site fill and per-Worker settings. Every outside command
// (npx wrangler, stripe, npm, curl) is a stub in a temporary folder, so
// nothing reaches Cloudflare, Stripe or GitHub.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { readAnswer, hasUrl, webhookSecret } from '../scripts/stripe-answer.js';
import { parseJsonc, workerVars } from '../scripts/wrangler-var.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SERVER, '..');

// Fake values with the right shapes. None is a real key; they are assembled
// at runtime so secret scanners do not mistake them for leaked credentials.
const STRIPE_KEY = ['rk', 'test', '51FakeRestrictedKeyForTests0123456789'].join('_');
const OPENAI_KEY = ['sk', 'fake-openai-key-for-tests-0123456789'].join('-');
const WHSEC = ['whsec', 'FakeSigningSecretForTests0123456789abcdef'].join('_');
const BASE = 'https://grayout-api-sandbox.test-sub.workers.dev';

const hasPython = spawnSync('python3', ['--version']).status === 0;

/** Write an executable stub. */
function stub(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/**
 * A folder of stub commands. Each records its arguments in calls.log;
 * `wrangler secret put NAME` also records NAME=value (from stdin) in store.log.
 */
function stubWorld({ secretsList = '[]', listFails = false, stripeList, stripeCreate, latest = 'v2.0.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grayout-stubs-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'secrets.json'), secretsList);
  writeFileSync(join(dir, 'stripe-list.json'), stripeList ?? '{"object":"list","data":[]}');
  writeFileSync(join(dir, 'stripe-create.json'), stripeCreate ?? JSON.stringify({ id: 'we_test1', secret: WHSEC }));
  stub(bin, 'npx', `
echo "npx $*" >> "${dir}/calls.log"
case "$1 $2 $3" in
  "wrangler secret list") ${listFails ? 'echo "not logged in" >&2; exit 1' : `cat "${dir}/secrets.json"`} ;;
  "wrangler secret put") value=$(cat); printf '%s=%s\\n' "$4" "$value" >> "${dir}/store.log" ;;
  "wrangler d1 list") echo '[{"name":"grayout","uuid":"0f1e2d3c-4b5a-4968-8776-655443322110"}]' ;;
  "wrangler deploy "*|"wrangler deploy") echo "Deployed grayout-api https://grayout-api.test-sub.workers.dev" ;;
esac
exit 0`);
  stub(bin, 'stripe', `
echo "stripe $*" >> "${dir}/calls.log"
case "$2" in
  list) cat "${dir}/stripe-list.json" ;;
  create) cat "${dir}/stripe-create.json" ;;
esac
exit 0`);
  stub(bin, 'npm', `echo "npm $*" >> "${dir}/calls.log"; exit 0`);
  stub(bin, 'curl', `
echo "curl $*" >> "${dir}/calls.log"
case "$*" in
  *api.github.com*) echo '{"tag_name":"${latest}"}' ;;
  *) echo '{"ok":true}' ;;
esac`);
  const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    calls: () => read('calls.log'),
    stored: () => Object.fromEntries(read('store.log').split('\n').filter(Boolean).map(line => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }))
  };
}

// Runs a command on a real pseudo-terminal (what Aarush's Terminal gives the
// script), types all of `input` into it, and returns everything it printed.
const PTY_DRIVER = `
import os, pty, sys
data = sys.stdin.buffer.read()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
os.write(fd, data)
out = b''
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;

function onTerminal(world, args, input) {
  const res = spawnSync('python3', ['-c', PTY_DRIVER, 'bash', join(SERVER, 'scripts/set-secrets.sh'), ...args], {
    env: world.env, input, encoding: 'utf8', timeout: 30000
  });
  return { status: res.status, out: res.stdout.replace(/\r/g, '') };
}

const occurrences = (text, part) => text.split(part).length - 1;

describe('scripts/set-secrets.sh', () => {
  test('refuses to run without a terminal, before touching wrangler or Stripe', () => {
    const world = stubWorld();
    const res = spawnSync('bash', [join(SERVER, 'scripts/set-secrets.sh'), 'sandbox', BASE], {
      env: world.env, input: `${STRIPE_KEY}\n${OPENAI_KEY}\n\n`, encoding: 'utf8'
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /only runs in a Terminal window/);
    assert.match(res.stderr, /Aarush/);
    assert.equal(world.calls(), '', 'no command ran');
    assert.deepEqual(world.stored(), {});
  });

  test('on a terminal: stores all five, the webhook secret from Stripe, and shows LICENSE_SECRET once; no secret on any command line', { skip: !hasPython && 'needs python3 for a pseudo-terminal' }, () => {
    const world = stubWorld();
    const { status, out } = onTerminal(world, ['sandbox', BASE], `${STRIPE_KEY}\n${OPENAI_KEY}\n\n`);
    assert.equal(status, 0, out);
    const stored = world.stored();
    assert.deepEqual(Object.keys(stored).sort(), ['DEVICE_SECRET', 'LICENSE_SECRET', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    assert.equal(stored.STRIPE_SECRET_KEY, STRIPE_KEY);
    assert.equal(stored.OPENAI_API_KEY, OPENAI_KEY);
    assert.equal(stored.STRIPE_WEBHOOK_SECRET, WHSEC);
    for (const name of ['DEVICE_SECRET', 'LICENSE_SECRET']) assert.match(stored[name], /^[A-Za-z0-9+/]{64}$/, `${name}: 48 random bytes, no newline`);
    assert.notEqual(stored.DEVICE_SECRET, stored.LICENSE_SECRET);
    // Shown once for the password manager; the device secret and the webhook secret never.
    assert.equal(occurrences(out, stored.LICENSE_SECRET), 1);
    assert.equal(occurrences(out, stored.DEVICE_SECRET), 0);
    assert.equal(occurrences(out, WHSEC), 0);
    assert.match(out, /Press Return once it is saved/);
    // Every command's arguments were recorded: no secret is among them.
    const calls = world.calls();
    for (const value of Object.values(stored)) assert.equal(calls.includes(value), false);
    assert.match(calls, /stripe webhook_endpoints create .*url=https:\/\/grayout-api-sandbox\.test-sub\.workers\.dev\/v1\/stripe\/webhook/);
    assert.match(calls, /npx wrangler secret put LICENSE_SECRET --env sandbox/);
  });

  test('a Stripe CLI error printed with exit code 0 stops the script; no webhook secret is stored', { skip: !hasPython && 'needs python3 for a pseudo-terminal' }, () => {
    const world = stubWorld({ stripeList: '{"error":{"message":"Permission denied","code":"unauthorized"}}' });
    const { status, out } = onTerminal(world, ['sandbox', BASE], `${STRIPE_KEY}\n${OPENAI_KEY}\n\n`);
    assert.equal(status, 1);
    assert.match(out, /Stripe refused: Permission denied/);
    assert.match(out, /STRIPE_WEBHOOK_SECRET was not stored/);
    assert.match(out, /stripe login/);
    assert.deepEqual(Object.keys(world.stored()).sort(), ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY']);
    assert.equal(world.calls().includes('webhook_endpoints create'), false);
  });

  test('a created webhook whose answer has an empty or malformed secret stores nothing', { skip: !hasPython && 'needs python3 for a pseudo-terminal' }, () => {
    for (const created of [
      { id: 'we_test1', secret: '' },
      { id: 'we_test1' },
      { id: 'we_test1', secret: 'whsec_short' },
      { error: { message: 'Invalid API version' } },
      'not json at all'
    ]) {
      const world = stubWorld({ stripeCreate: typeof created === 'string' ? created : JSON.stringify(created) });
      const { status, out } = onTerminal(world, ['sandbox', BASE], `${STRIPE_KEY}\n${OPENAI_KEY}\n\n`);
      assert.equal(status, 1, JSON.stringify(created));
      assert.equal('STRIPE_WEBHOOK_SECRET' in world.stored(), false, JSON.stringify(created));
      assert.match(out, /STRIPE_WEBHOOK_SECRET was not stored/);
    }
  });

  test('a webhook that already exists is left to the Dashboard, and the rest still runs', { skip: !hasPython && 'needs python3 for a pseudo-terminal' }, () => {
    const world = stubWorld({
      secretsList: JSON.stringify([{ name: 'STRIPE_SECRET_KEY', type: 'secret_text' }, { name: 'OPENAI_API_KEY', type: 'secret_text' }]),
      stripeList: JSON.stringify({ object: 'list', data: [{ id: 'we_old', url: `${BASE}/v1/stripe/webhook` }] })
    });
    const { status, out } = onTerminal(world, ['sandbox', BASE], '\n');
    assert.equal(status, 0, out);
    assert.match(out, /already exists/);
    assert.deepEqual(Object.keys(world.stored()).sort(), ['DEVICE_SECRET', 'LICENSE_SECRET']);
    assert.equal(world.calls().includes('webhook_endpoints create'), false);
  });

  test('a wrong or empty pasted key, or a secret list that fails, stores nothing', { skip: !hasPython && 'needs python3 for a pseudo-terminal' }, () => {
    const liveKey = ['rk', 'live', '51FakeRestrictedKeyForTests0123456789'].join('_');
    const fullKey = ['sk', 'test', '51FakeSecretKeyForTests0123456789'].join('_');
    for (const pasted of ['', liveKey, fullKey]) {
      const world = stubWorld();
      const { status, out } = onTerminal(world, ['sandbox', BASE], `${pasted}\n${OPENAI_KEY}\n\n`);
      assert.equal(status, 1);
      assert.match(out, /not a rk_test_ key/);
      assert.deepEqual(world.stored(), {});
    }
    const world = stubWorld({ listFails: true });
    const { status, out } = onTerminal(world, ['sandbox', BASE], `${STRIPE_KEY}\n${OPENAI_KEY}\n\n`);
    assert.equal(status, 1);
    assert.match(out, /could not list this Worker's secrets/);
    assert.deepEqual(world.stored(), {}, 'a failed listing never leads to a new LICENSE_SECRET');
  });
});

describe('scripts/stripe-answer.js', () => {
  test('an error answer is refused with only its message, whatever the exit code was', () => {
    assert.deepEqual(readAnswer('{"error":{"message":"Permission denied","code":"unauthorized"}}'), { ok: false, reason: 'Stripe refused: Permission denied' });
    assert.equal(readAnswer('').ok, false);
    assert.equal(readAnswer('{"secret": "whsec_').ok, false);
  });

  test('a notice before the JSON is skipped; list and secret are read strictly', () => {
    const answer = readAnswer(`A newer version of the Stripe CLI is available.\n${JSON.stringify({ id: 'we_1', secret: WHSEC })}`);
    assert.equal(answer.ok, true);
    assert.equal(webhookSecret(answer.body), WHSEC);
    assert.equal(webhookSecret({ secret: 'whsec_placeholder_placeholder_placeholder_00' }), null);
    assert.equal(webhookSecret({ secret: '' }), null);
    const list = { data: [{ url: `${BASE}/v1/stripe/webhook` }] };
    assert.equal(hasUrl(list, `${BASE}/v1/stripe/webhook`), true);
    assert.equal(hasUrl(list, `${BASE}/v1/stripe/webhook2`), false);
    assert.equal(hasUrl({}, `${BASE}/v1/stripe/webhook`), false);
  });
});

describe('scripts/wrangler-var.js', () => {
  test("each Worker's own setting: the live one never counts for the sandbox, or the other way round", () => {
    const dir = mkdtempSync(join(tmpdir(), 'grayout-vars-'));
    const file = join(dir, 'wrangler.jsonc');
    writeFileSync(file, `{
      // live
      "vars": { "SUPPORT_EMAIL": "", "SITE_URL": "https://example.test/grayout" },
      "env": { "sandbox": { "vars": { "SUPPORT_EMAIL": "help@example.test" } } }
    }`);
    const get = (target, name) => spawnSync(process.execPath, [join(SERVER, 'scripts/wrangler-var.js'), target, name, file], { encoding: 'utf8' });
    assert.equal(get('live', 'SUPPORT_EMAIL').stdout, '\n');
    assert.equal(get('sandbox', 'SUPPORT_EMAIL').stdout, 'help@example.test\n');
    assert.equal(get('live', 'SITE_URL').stdout, 'https://example.test/grayout\n');
    assert.equal(get('sandbox', 'MISSING').stdout, '\n');
    assert.equal(get('staging', 'SUPPORT_EMAIL').status, 2);
    // The real file parses, and both Workers have their own SUPPORT_EMAIL entry.
    const config = parseJsonc(readFileSync(join(SERVER, 'wrangler.jsonc'), 'utf8'));
    for (const target of ['live', 'sandbox']) assert.ok('SUPPORT_EMAIL' in workerVars(config, target), target);
  });
});

/**
 * A throwaway copy of the parts of the repo deploy.sh touches, so a real
 * (not dry) run can fill files without changing this checkout.
 */
function repoCopy({ wranglerPatch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'grayout-repo-'));
  mkdirSync(join(root, 'server'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  cpSync(join(SERVER, 'scripts'), join(root, 'server/scripts'), { recursive: true });
  cpSync(join(SERVER, 'src'), join(root, 'server/src'), { recursive: true });
  let wrangler = readFileSync(join(SERVER, 'wrangler.jsonc'), 'utf8');
  if (wranglerPatch) wrangler = wranglerPatch(wrangler);
  writeFileSync(join(root, 'server/wrangler.jsonc'), wrangler);
  cpSync(join(REPO, 'src/config.js'), join(root, 'src/config.js'));
  for (const name of readdirSync(join(REPO, 'docs')).filter(f => f === 'config.js' || f.endsWith('.html'))) {
    cpSync(join(REPO, 'docs', name), join(root, 'docs', name));
  }
  return root;
}

function deploy(root, world, args, { dryRun = false } = {}) {
  return spawnSync('bash', [join(root, 'server/scripts/deploy.sh'), ...args], {
    env: { ...world.env, ...(dryRun ? { DRY_RUN: '1' } : { DRY_RUN: '' }) }, encoding: 'utf8', timeout: 60000
  });
}

const PLACEHOLDER = '__GRAYOUT_API_BASE__';
const API = 'https://grayout-api.test-sub.workers.dev';

describe('scripts/deploy.sh: the site gets the address only with --fill-site', () => {
  test('live without --fill-site fills the app (src/config.js) and leaves docs/config.js and the pages alone', () => {
    const root = repoCopy();
    const world = stubWorld();
    const res = deploy(root, world, ['live']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(readFileSync(join(root, 'src/config.js'), 'utf8'), new RegExp(`DEFAULT_API_BASE = '${API}'`));
    assert.match(readFileSync(join(root, 'docs/config.js'), 'utf8'), /window\.GRAYOUT_API_BASE = '__GRAYOUT_API_BASE__';/);
    for (const name of readdirSync(join(root, 'docs'))) {
      assert.equal(readFileSync(join(root, 'docs', name), 'utf8'), readFileSync(join(REPO, 'docs', name), 'utf8'), `${name} unchanged`);
    }
    assert.match(res.stdout, /filled it into: src\/config\.js\n/);
    assert.match(res.stdout, /left docs\/config\.js alone/);
    assert.match(res.stdout, /deploy\.sh live --fill-site/);
    assert.equal(world.calls().includes('api.github.com'), false, 'no release check without --fill-site');
  });

  test('--fill-site stops before deploying anything while the GitHub "latest" release is 1.x', () => {
    const root = repoCopy();
    const world = stubWorld({ latest: 'v1.0.1' });
    const res = deploy(root, world, ['live', '--fill-site']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /STOP: the GitHub "latest" release is 'v1\.0\.1', not 2\.x/);
    assert.equal(world.calls().includes('wrangler deploy'), false);
    assert.match(readFileSync(join(root, 'docs/config.js'), 'utf8'), new RegExp(PLACEHOLDER));
    assert.match(readFileSync(join(root, 'src/config.js'), 'utf8'), new RegExp(PLACEHOLDER));
  });

  test('--fill-site with a 2.x latest release fills docs/config.js too, and checks the pages\' CSP', () => {
    const root = repoCopy();
    const world = stubWorld({ latest: 'v2.0.0' });
    const res = deploy(root, world, ['live', '--fill-site']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(readFileSync(join(root, 'docs/config.js'), 'utf8'), new RegExp(`window\\.GRAYOUT_API_BASE = '${API}';`));
    assert.match(readFileSync(join(root, 'src/config.js'), 'utf8'), new RegExp(`DEFAULT_API_BASE = '${API}'`));
    assert.match(res.stdout, /every page that calls the API allows it/);
    assert.equal(res.stdout.includes('left docs/config.js alone'), false);
  });

  test('a page whose CSP would block the API stops a --fill-site run, and is only a to-do without it', () => {
    const blockPage = root => {
      const page = join(root, 'docs/success.html');
      writeFileSync(page, readFileSync(page, 'utf8').replace('connect-src \'self\' https://*.workers.dev', 'connect-src \'self\' https://api.grayout.app'));
    };
    const world = stubWorld({ latest: 'v2.0.0' });
    const filling = repoCopy();
    blockPage(filling);
    const stopped = deploy(filling, world, ['live', '--fill-site']);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /STOP: the site pages above would block the API/);
    assert.match(stopped.stderr, /success\.html: connect-src names grayout\.app/);

    const appOnly = repoCopy();
    blockPage(appOnly);
    const res = deploy(appOnly, world, ['live']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Fix each site page's connect-src listed above/);
  });

  test('dry runs say what each form would do; --fill-site is refused for the sandbox', () => {
    const world = stubWorld();
    const plain = deploy(REPO, world, ['live'], { dryRun: true });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /\(dry run\) would fill the Worker's address into src\/config\.js/);
    assert.match(plain.stdout, /left docs\/config\.js alone/);
    const fill = deploy(REPO, world, ['live', '--fill-site'], { dryRun: true });
    assert.equal(fill.status, 0, fill.stderr);
    assert.match(fill.stdout, /would also fill it into docs\/config\.js/);
    assert.match(fill.stdout, /would stop here unless the latest release/);
    const sandbox = deploy(REPO, world, ['sandbox', '--fill-site'], { dryRun: true });
    assert.equal(sandbox.status, 2);
    assert.match(sandbox.stderr, /only for live/);
    assert.equal(deploy(REPO, world, ['live', '--fill'], { dryRun: true }).status, 2);
  });

  test("SUPPORT_EMAIL is checked in each Worker's own vars", () => {
    // Only the sandbox has one: the live run must still ask for it.
    const root = repoCopy({
      wranglerPatch: text => text.replace(/("FREE_DAILY_BUDGET": "200",\s*)"SUPPORT_EMAIL": ""/, '$1"SUPPORT_EMAIL": "help@example.test"')
    });
    const config = parseJsonc(readFileSync(join(root, 'server/wrangler.jsonc'), 'utf8'));
    assert.equal(config.env.sandbox.vars.SUPPORT_EMAIL, 'help@example.test');
    assert.equal(config.vars.SUPPORT_EMAIL, '');
    const world = stubWorld();
    const live = deploy(root, world, ['live'], { dryRun: true });
    assert.match(live.stdout, /Put your support email in SUPPORT_EMAIL in the top-level "vars"/);
    const sandbox = deploy(root, world, ['sandbox'], { dryRun: true });
    assert.equal(sandbox.status, 0, sandbox.stderr);
    assert.equal(sandbox.stdout.includes('Put your support email'), false, 'the sandbox has its own SUPPORT_EMAIL');
  });
});
