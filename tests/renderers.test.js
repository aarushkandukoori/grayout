'use strict';
// The renderers (ui/*.js) run in a sandboxed window and have no module system,
// so nothing else in this suite loads them. That is exactly how v2 shipped an
// onboarding window whose key step called four preload methods that no longer
// existed: every unit test passed and the first screen a person saw threw.
//
// These are static checks over the real files. They cannot prove the windows
// look right, but they do prove the two joins that silently broke:
//   1. every window.grayout.* a renderer calls exists on its preload bridge;
//   2. every getElementById a renderer reaches for exists in its HTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The names exposed on the contextBridge object, in source order. */
function exposedNames(preloadSrc) {
  const start = preloadSrc.indexOf('exposeInMainWorld');
  assert.notEqual(start, -1, 'the preload must expose a bridge');
  return new Set([...preloadSrc.slice(start).matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map(m => m[1]));
}

/** Every `api.<name>(` the renderer calls. */
function calledNames(rendererSrc) {
  return new Set([...rendererSrc.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]));
}

/** Every id="…" in the document. */
function documentIds(htmlSrc) {
  return new Set([...htmlSrc.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
}

/** Every `$('…')` the renderer looks up. */
function lookedUpIds(rendererSrc) {
  return new Set([...rendererSrc.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
}

const WINDOWS = [
  { name: 'onboarding', html: 'ui/onboarding.html', js: 'ui/onboarding.js', preload: 'ui/preload/onboarding.js' },
  { name: 'dashboard', html: 'ui/dashboard.html', js: 'ui/dashboard.js', preload: 'ui/preload/dashboard.js' }
];

for (const w of WINDOWS) {
  test.describe(`${w.name} window`, () => {
    const html = read(w.html);
    const js = read(w.js);
    const preload = read(w.preload);

    test('every bridge method it calls is exposed by its preload', () => {
      const exposed = exposedNames(preload);
      const missing = [...calledNames(js)].filter(n => !exposed.has(n)).sort();
      assert.deepEqual(missing, [], `${w.js} calls api.${missing.join(', api.')} — not on ${w.preload}`);
    });

    test('every element it reaches for exists in its HTML', () => {
      const ids = documentIds(html);
      const missing = [...lookedUpIds(js)].filter(id => !ids.has(id)).sort();
      assert.deepEqual(missing, [], `${w.js} looks up ${missing.join(', ')} — no such id in ${w.html}`);
    });

    test('every #id selector it queries exists in its HTML', () => {
      const ids = documentIds(html);
      const missing = [...js.matchAll(/querySelector(?:All)?\('#([\w-]+)'\)/g)]
        .map(m => m[1]).filter(id => !ids.has(id)).sort();
      assert.deepEqual(missing, [], `${w.js} queries #${missing.join(', #')} — no such id in ${w.html}`);
    });

    test('it loads no script but its own, and no remote subresource', () => {
      const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
      assert.deepEqual(srcs, [path.basename(w.js)], 'one local script, nothing else');
      assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, 'no inline <script>');
      assert.equal(/(?:src|href)="https?:\/\//.test(html), false, 'no remote subresource');
    });
  });
}

test('every ipc channel a preload invokes has a handler', () => {
  // A preload is the whole contract between a window and the app. An invoke on
  // a channel nobody registered rejects at runtime with "No handler registered",
  // which the renderers swallow into a shrug of a message.
  const ipc = read('src/ipc.js');
  const registered = new Set([
    ...[...ipc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]),
    ...[...ipc.matchAll(/ipcMain\.on\('([^']+)'/g)].map(m => m[1]),
    // Registered for the lifetime of one capture in src/camera.js, not here.
    'frame-response'
  ]);

  const unhandled = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'ui', 'preload'))) {
    const src = read(path.join('ui', 'preload', f));
    for (const [, ch] of src.matchAll(/(?:invoke|ipcRenderer\.send)\('([^']+)'/g)) {
      if (!registered.has(ch)) unhandled.push(`ui/preload/${f} -> ${ch}`);
    }
  }
  assert.deepEqual([...new Set(unhandled)].sort(), []);
});

test.describe('product surfaces do not lead with an API key', () => {
  // v2 sells a subscription. Self-hosting is documented in the README and on
  // the site's self-hosting page; it is never what a first run talks about.
  const surfaces = ['ui/onboarding.html', 'ui/onboarding.js'];
  for (const f of surfaces) {
    test(`${f} names no model provider and no key guide`, () => {
      const src = read(f);
      assert.equal(/api-key\.html/.test(src), false, 'no link to the key guide');
      assert.equal(/\bAnthropic\b|\bOpenAI\b/.test(src), false, 'no model provider named');
      assert.equal(/sk-ant-|sk-proj-/.test(src), false, 'no model key shape shown');
    });
  }

  test('the onboarding preload offers the subscription flow and no key methods', () => {
    const exposed = exposedNames(read('ui/preload/onboarding.js'));
    for (const n of ['startCheckout', 'pollClaim', 'cancelClaim', 'activateLicense', 'startFree']) {
      assert.equal(exposed.has(n), true, `the welcome window needs ${n}`);
    }
    for (const n of ['testApiKey', 'saveApiKey', 'useKeyForSession', 'skipKey']) {
      assert.equal(exposed.has(n), false, `${n} is a v1 method and must not come back`);
    }
  });
});

test.describe('prices are read, never written, by the windows', () => {
  // A hard-coded price in a renderer is how "$9.99" survives a price change.
  // Both windows print PLANS from src/pricing.js instead.
  for (const f of ['ui/onboarding.js', 'ui/dashboard.js']) {
    test(`${f} hard-codes no price`, () => {
      const src = read(f);
      const hits = [...src.matchAll(/\$\d+(?:\.\d\d)?\s+(?:a|per)\s+(?:month|year)/g)].map(m => m[0]);
      assert.deepEqual(hits, [], `${f} writes ${hits.join(', ')} by hand`);
    });
  }

  test('the placeholder prices in onboarding.html match src/pricing.js', () => {
    // The HTML carries a first-paint value for each price; renderScreen3
    // overwrites it from the account payload. A stale placeholder would flash
    // the wrong number, so it is pinned to the same source here.
    const { PLANS } = require('../src/pricing');
    const html = read('ui/onboarding.html');
    assert.match(html, new RegExp(`id="price-monthly">\\${PLANS.monthly.priceLabel} ${PLANS.monthly.periodLabel}<`));
    assert.match(html, new RegExp(`id="price-yearly">\\${PLANS.yearly.priceLabel} ${PLANS.yearly.periodLabel}<`));
    assert.match(html, new RegExp(`${PLANS.monthly.trialDays}-day free trial`));
    assert.match(html, new RegExp(`\\${PLANS.yearly.perMonthLabel} a month, billed yearly`));
  });
});

test.describe('billing copy follows the v3 contract (Managed Payments)', () => {
  // docs/API-CONTRACT.md section 10: Stripe, selling through Link, is the
  // seller. Every price says "plus tax where it applies", the checkout copy
  // says LINK.COM*, and every "Manage" route also names link.com.
  const PAGES = [
    { name: 'onboarding', html: read('ui/onboarding.html'), js: read('ui/onboarding.js') },
    { name: 'dashboard', html: read('ui/dashboard.html'), js: read('ui/dashboard.js') }
  ];

  for (const p of PAGES) {
    test(`${p.name}: sold through Link, LINK.COM*, link.com and tax are all stated`, () => {
      const all = p.html + p.js;
      assert.match(all, /sold through Link/i);
      assert.match(all, /LINK\.COM\*/);
      assert.match(all, /link\.com/);
      assert.match(all, /plus tax where it applies/);
      assert.equal(/Billing goes through Stripe\.|Payment goes through Stripe in your browser\./.test(all), false, 'the v2 "goes through Stripe" copy is gone');
    });

    test(`${p.name}: every v3 failure it can see is handled by name`, () => {
      for (const kind of ['already_subscribed', 'device_unverified', 'not_connected', 'license_revoked', 'license_invalid', 'payment_failed', 'code_expired']) {
        assert.ok(p.js.includes(`'${kind}'`), `${p.name} never mentions ${kind}`);
      }
      assert.equal(p.js.includes("'claim_expired'"), false, 'claim_expired is a v2 kind; the account client says code_expired');
      // key_rejected now means a self-hosted MODEL key was refused. Only the
      // dashboard's model-key panel may still talk about it; the plan never does.
      const plan = p.name === 'dashboard' ? p.js.slice(p.js.indexOf('/* ---------------- the plan')) : p.js;
      const planOnly = p.name === 'dashboard' ? plan.slice(0, plan.indexOf('function wireKey()')) : plan;
      assert.equal(planOnly.includes("'key_rejected'"), false, 'a license problem is license_invalid / license_revoked now');
    });

    test(`${p.name}: a build with no service address says so`, () => {
      assert.match(p.html + p.js, /not connected to the Grayout service yet/);
    });

    test(`${p.name}: "already subscribed" never tells the person to subscribe`, () => {
      const m = /function alreadySubscribedMessage\(r\) \{[\s\S]*?\n {2}\}/.exec(p.js);
      assert.ok(m, 'alreadySubscribedMessage exists');
      assert.equal(/subscribe\b/i.test(m[0]), false);
      assert.match(m[0], /nothing new was charged/);
    });
  }

  test('no window names the unowned grayout.app domain', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'ui')).filter(n => /\.(html|js)$/.test(n))) {
      assert.equal(/grayout\.app/.test(read(path.join('ui', f))), false, f);
    }
  });

  test('the dashboard offers "Restore my key" and opens link.com through the allowlist', () => {
    const js = read('ui/dashboard.js');
    assert.match(read('ui/dashboard.html'), /id="btn-restore-key"[^>]*>Restore my key</);
    assert.match(js, /api\.restoreLicense\(\)/);
    assert.match(js, /api\.openExternal\('https:\/\/link\.com'\)/);
  });
});

test.describe('ids are unique, so $() reaches the element it means', () => {
  // Regression: the plan panel's "Restore my key" reused id="btn-restore",
  // which already belonged to the header's "Restore color". getElementById
  // returns the first one, so the license-restore handler landed on "Restore
  // color", the panel hid and disabled "Restore color" for every subscriber,
  // and "Restore my key" did nothing at all.
  const htmlFiles = fs.readdirSync(path.join(ROOT, 'ui')).filter(n => n.endsWith('.html'));

  for (const f of htmlFiles) {
    test(`ui/${f} has no duplicate id`, () => {
      const all = [...read(path.join('ui', f)).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
      const dupes = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
      assert.deepEqual(dupes, [], `ui/${f} repeats id ${dupes.join(', ')}`);
    });
  }

  test('"Restore color" is wired only to restoreColor; "Restore my key" only to restoreLicense', () => {
    const html = read('ui/dashboard.html');
    const js = read('ui/dashboard.js');
    assert.match(html, /id="btn-restore"[^>]*>Restore color</);
    assert.match(html, /id="btn-restore-key"[^>]*>Restore my key</);
    // Every line that touches #btn-restore only ever restores the color.
    const colorLines = js.split('\n').filter(l => l.includes("$('btn-restore')"));
    assert.equal(colorLines.length, 1, 'one place touches the header button');
    assert.match(colorLines[0], /api\.restoreColor\(\)/);
    // The plan panel never hides or disables the escape hatch.
    const plan = js.slice(js.indexOf('/* ---------------- the plan'), js.indexOf('function wireKey()'));
    assert.equal(plan.includes("$('btn-restore')"), false);
    const keyHandler = plan.slice(plan.indexOf("$('btn-restore-key').addEventListener"));
    assert.match(keyHandler.slice(0, 600), /api\.restoreLicense\(\)/);
  });
});

test.describe('the dashboard plan panel', () => {
  const html = read('ui/dashboard.html');
  const js = read('ui/dashboard.js');

  test('both plans can be bought from Settings, and Subscribe buys the one chosen', () => {
    // Regression: Subscribe was hard-wired to monthly, so a lapsed yearly
    // subscriber could only go to the website, which reuses no customer.
    assert.match(html, /name="dash-plan" value="monthly"/);
    assert.match(html, /name="dash-plan" value="yearly"/);
    assert.match(js, /\$\('btn-subscribe'\)\.addEventListener\('click', \(\) => startCheckout\(chosenPlan\(\)\)\)/);
    assert.equal(/startCheckout\('monthly'\)/.test(js), false, 'no hard-wired plan');
  });

  test('"See plans" (the website) is only offered to a Mac with no key and nothing on file', () => {
    assert.match(js, /show\(\$\('btn-plans'\), canSubscribe && !a\.hasLicense\)/);
  });

  test('a website buyer is told to paste the key rather than subscribe again', () => {
    assert.match(html, /id="buy-note"[^>]*>Bought Grayout on the website\? Paste the key/);
    assert.match(read('ui/onboarding.html'), /Bought Grayout on the website/);
  });

  test('a missing key on file (no_license) or a revoked one never offers Subscribe', () => {
    assert.match(js, /const keyMissing = !a\.hasLicense && a\.problem === 'no_license';/);
    assert.match(js, /const canSubscribe = connected && !serving && !pastDue && !revoked && !keyMissing && !a\.secretsLocked;/);
    const sentence = js.slice(js.indexOf('function accountSentence'), js.indexOf('function renderAccount'));
    const noKey = /a\.problem === 'no_license'\) \{\s*return '([^']+)'/.exec(sentence);
    assert.ok(noKey, 'a sentence for a key on file that is not on this Mac');
    assert.equal(/subscribe/i.test(noKey[1]), false, 'never "subscribe" to somebody who paid');
    assert.match(noKey[1], /Restore my key/);
    assert.match(sentence, /!a\.hasLicense && a\.problem === 'license_revoked'/);
  });

  for (const f of ['ui/dashboard.js', 'ui/onboarding.js']) {
    test(`${f}: after the wait ends, the copy never invites a second payable checkout`, () => {
      const src = read(f);
      const timeout = /kind === 'timeout'\) return '([^']+)'/.exec(src);
      assert.ok(timeout);
      assert.match(timeout[1], /close that checkout tab first/);
      assert.match(src, /Stopped waiting\. The checkout page is still open in your browser/);
      assert.match(src, /r\.reused/);
      assert.match(src, /This checkout has no free trial/);
    });
  }
});
