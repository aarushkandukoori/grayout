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
