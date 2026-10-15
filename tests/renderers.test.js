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

// Contract item 4: bridges the consent branch adds to the preloads. Until that
// branch merges, a renderer may call them only behind a
// `typeof api.<name> === 'function'` guard. Once a preload exposes a name, it
// is no longer exempt and the ordinary check below covers it.
const PENDING_BRIDGE = {
  onboarding: ['grantConsent'],
  dashboard: ['grantConsent', 'revokeConsent', 'eraseData']
};

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
      const pending = new Set(PENDING_BRIDGE[w.name].filter(n => !exposed.has(n)));
      const missing = [...calledNames(js)].filter(n => !exposed.has(n) && !pending.has(n)).sort();
      assert.deepEqual(missing, [], `${w.js} calls api.${missing.join(', api.')} — not on ${w.preload}`);
    });

    test('it wires the consent bridges, each behind a typeof guard', () => {
      const called = calledNames(js);
      for (const n of PENDING_BRIDGE[w.name]) {
        assert.equal(called.has(n), true, `${w.js} never calls api.${n}`);
        assert.match(js, new RegExp(`typeof api\\.${n} [!=]== 'function'`), `${w.js} calls api.${n} without checking it exists`);
      }
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
  // The one provider the welcome window does name is OpenAI, and only in the
  // third-party AI consent (App Review 5.1.2(i) wants it named). Any other
  // provider name reaches it only from the payload's consent.processor.
  const surfaces = ['ui/onboarding.html', 'ui/onboarding.js'];
  for (const f of surfaces) {
    test(`${f} names no key guide, no key shape, and OpenAI only in the consent copy`, () => {
      const src = read(f);
      assert.equal(/api-key\.html/.test(src), false, 'no link to the key guide');
      assert.equal(/\bAnthropic\b/.test(src), false, 'Anthropic is never written into the window');
      assert.equal(/sk-ant-|sk-proj-/.test(src), false, 'no model key shape shown');
      const stray = src.split('\n').filter(l => /\bOpenAI\b/.test(l) && !/^\s*(\/\/|\*|<!--)/.test(l))
        .filter(l => !/HOSTED|third-party AI provider|train its models|name === 'OpenAI'/.test(l));
      assert.deepEqual(stray, [], 'OpenAI appears outside the consent disclosure');
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

test.describe('the CLI engine in the windows', () => {
  const dash = read('ui/dashboard.js');
  const onb = read('ui/onboarding.js');

  test('the dashboard names a logged-out or missing CLI, never as an API-key problem', () => {
    assert.match(dash, /live\.errorKind === 'cli_auth'\) return \{ cls: 'pill-warn', text: 'CLI logged out' \}/);
    assert.match(dash, /live\.errorKind === 'cli_missing'\) return \{ cls: 'pill-bad', text: 'CLI not found' \}/);
    const banner = dash.slice(dash.indexOf("live.errorKind === 'cli_auth' && !live.needsScreenPermission"), dash.indexOf("live.errorKind === 'cli_missing' && !live.needsScreenPermission"));
    assert.match(banner, /api\.copyText\(login\.command\)/);
    assert.equal(/goToSettings|API key|model key/.test(banner), false, 'the fix is the CLI login, not a key');
  });

  test('on the CLI engine the windows quote no price and need no plan to finish setup', () => {
    assert.match(dash, /const est = cli\s+\? 'no per-check charge'/);
    assert.match(onb, /setText\(\$\(`est-\$\{sec\}`\), 'no per-check charge'\)/);
    assert.match(onb, /show\(\$\('btn-3-continue'\), cli \|\| has \|\| !connected\(\)\)/);
  });
});

/* ------------------------------------------------------------------------
   The windows, run. A small fake DOM (just what ui/onboarding.js and
   ui/dashboard.js touch) built from the real HTML, so the consent flow and
   the Mac App Store gating are exercised end to end in plain Node, including
   a payload from a main process that sends no channel and no consent.
   ------------------------------------------------------------------------ */

const vm = require('node:vm');

const VOID_TAGS = new Set(['META', 'LINK', 'INPUT', 'BR', 'IMG', 'HR', 'SOURCE']);

class FakeEl {
  constructor(doc, tag, attrs = {}) {
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.tagName = tag;
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {};
    this.id = attrs.id || '';
    this.hidden = 'hidden' in attrs;
    this.disabled = 'disabled' in attrs;
    this.checked = 'checked' in attrs;
    this.value = attrs.value || '';
    this.type = attrs.type || '';
    this.name = attrs.name || '';
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    }
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this._classes = classes;
    this.classList = {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      }
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => this._classes.add(c)); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get options() { return this.descendants().filter(n => n.tagName === 'OPTION'); }
  get clientWidth() { return 800; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.appendChild({ nodeType: 3, textContent: String(v) }); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.push(n); n.parentNode = this; return n;
  }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? { nodeType: 3, textContent: n } : n); }
  replaceChildren(...ns) { this.childNodes = []; this.append(...ns); }
  removeChild(n) { this.childNodes = this.childNodes.filter(x => x !== n); n.parentNode = null; return n; }
  before(n) {
    const p = this.parentNode;
    if (n.parentNode) n.parentNode.removeChild(n);
    p.childNodes.splice(p.childNodes.indexOf(this), 0, n); n.parentNode = p;
  }
  contains(n) { return n === this || this.descendants().includes(n); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = v;
    if (k === 'id' || k === 'type' || k === 'name') this[k] = String(v);
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, extra = {}) {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, ...extra };
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  querySelectorAll(sel) { return this.descendants().filter(e => matchesSelector(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function matchesSelector(e, sel) {
  const m = /^([a-z]*)(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?(:checked)?$/.exec(sel);
  if (!m) throw new Error(`the fake DOM cannot match ${sel}`);
  const [, tag, id, cls, attr, val, checked] = m;
  if (tag && e.tagName !== tag.toUpperCase()) return false;
  if (id && e.id !== id) return false;
  if (cls && !e.classList.contains(cls)) return false;
  if (attr) {
    const v = attr === 'name' ? e.name : e.attrs[attr];
    if (v === undefined || (attr === 'name' && !v)) return false;
    if (val !== undefined && v !== val) return false;
  }
  if (checked && !e.checked) return false;
  return true;
}

function fakeDocument(html) {
  const doc = { activeElement: null, readyState: 'complete', listeners: {} };
  const root = new FakeEl(doc, '#ROOT');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { top.appendChild({ nodeType: 3, textContent: m[4] }); continue; }
    if (m[1]) {
      const i = stack.map(e => e.tagName).lastIndexOf(m[1].toUpperCase());
      if (i > 0) stack.length = i;
      continue;
    }
    if (!m[2]) continue;
    const attrs = {};
    for (const a of (m[3] || '').matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    const el = new FakeEl(doc, m[2].toUpperCase(), attrs);
    top.appendChild(el);
    if (!VOID_TAGS.has(el.tagName)) stack.push(el);
  }
  doc.root = root;
  doc.getElementById = id => root.descendants().find(e => e.id === id) || null;
  doc.createElement = tag => new FakeEl(doc, String(tag).toUpperCase());
  doc.createTextNode = t => ({ nodeType: 3, textContent: String(t) });
  doc.querySelectorAll = sel => root.querySelectorAll(sel);
  doc.querySelector = sel => root.querySelector(sel);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  doc.dispatch = (type, extra) => { for (const fn of doc.listeners[type] || []) fn({ type, preventDefault() {}, ...extra }); };
  return doc;
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

/** Runs a renderer against its real HTML and a fake bridge. Timers never fire. */
async function runWindow(name, api) {
  const doc = fakeDocument(read(`ui/${name}.html`));
  const errors = [];
  const sandbox = {
    window: { grayout: api, addEventListener() {}, scrollTo() {} },
    document: doc,
    location: { hash: '' },
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}
  };
  vm.runInNewContext(read(`ui/${name}.js`), sandbox, { filename: `ui/${name}.js` });
  await settle();
  const $ = id => {
    const el = doc.getElementById(id);
    assert.ok(el, `no #${id}`);
    return el;
  };
  return { doc, $, errors };
}

/** A bridge with every method the preload exposes, recording calls. */
function fakeBridge(preloadFile, impl = {}, { omit = [] } = {}) {
  const calls = [];
  const api = {};
  for (const n of exposedNames(read(preloadFile))) {
    api[n] = (...args) => { calls.push([n, ...args]); return Promise.resolve(impl[n] ? impl[n](...args) : undefined); };
  }
  for (const n of Object.keys(impl)) {
    if (!api[n]) api[n] = (...args) => { calls.push([n, ...args]); return Promise.resolve(impl[n](...args)); };
  }
  for (const n of omit) delete api[n];
  return { api, calls, called: n => calls.filter(c => c[0] === n) };
}

const channel = require('../src/channel');
function channelPayload(n) {
  channel._setForTests(n);
  try { return { name: channel.name(), isMAS: channel.isMAS(), features: { ...channel.features() } }; }
  finally { channel._setForTests(null); }
}

const pricing = require('../src/pricing');
const HOSTED_PROCESSOR = { name: 'OpenAI', via: 'the Grayout service' };

function onbState(over = {}) {
  return {
    step: 1, completed: false, engine: 'api', inApplications: true, screen: 'granted', cameraStatus: 'not-determined',
    account: { ok: true, configured: true, hasLicense: false, usage: { checksUsed: 0, checksIncluded: pricing.FREE_CHECKS } },
    plans: pricing.PLANS, freeChecks: pricing.FREE_CHECKS, includedChecks: pricing.INCLUDED_CHECKS,
    selfHosted: false, secureStorage: true, loginItem: { status: 'not-registered', inApplications: true },
    config: { workDescription: '', checkIntervalSec: 45, camera: false, startAtLogin: false },
    estimates: { byInterval: {} }, version: '2.0.0', isPackaged: true, grayscaleAvailable: true,
    tccResetCmd: 'tccutil reset ScreenCapture com.aarushkandukoori.grayout',
    ...over
  };
}

const stepOn = doc => {
  const on = doc.querySelectorAll('.screen').filter(s => s.classList.contains('on'));
  assert.equal(on.length, 1, 'exactly one screen shows');
  return Number(on[0].dataset.step);
};

test.describe('the welcome window, run', () => {
  const PRELOAD = 'ui/preload/onboarding.js';

  test('a payload with no channel and no consent: the consent card comes first, naming OpenAI', async () => {
    // A v2 main process resuming on the plan step. The consent step still wins.
    const b = fakeBridge(PRELOAD, { getState: () => onbState({ step: 3 }) }, { omit: ['grantConsent'] });
    const { doc, $, errors } = await runWindow('onboarding', b.api);
    assert.deepEqual(errors, []);
    assert.equal(stepOn(doc), 1);
    assert.equal($('progress').textContent, '1 of 5');
    assert.match($('consent-who').textContent, /sends them to OpenAI, a third-party AI provider/);
    assert.match($('consent-who').textContent, /keeps none of them/);
    assert.match($('consent-who').textContent, /does not use them to train its models and may keep them for up to 30 days/);
    assert.equal($('btn-consent-allow').hidden, false);
    assert.equal($('btn-consent-later').hidden, false);
    assert.equal($('btn-1-continue').hidden, true);
    assert.equal($('license-block').hidden, false, 'the direct build keeps the license box');
  });

  test('"Not now" captures nothing and setup stays on the consent card', async () => {
    const b = fakeBridge(PRELOAD, { getState: () => onbState(), grantConsent: () => ({ ok: true }) });
    const { doc, $ } = await runWindow('onboarding', b.api);
    $('btn-consent-later').click();
    await settle();
    assert.equal(stepOn(doc), 1);
    assert.equal(b.called('grantConsent').length, 0);
    assert.match($('consent-status').textContent, /Nothing is captured or sent/);
    // Return on the card never stands in for the click.
    doc.dispatch('keydown', { key: 'Enter', target: $('screens') });
    await settle();
    assert.equal(stepOn(doc), 1);
    assert.equal(b.called('grantConsent').length, 0);
    assert.equal(b.called('setStep').length, 0);
  });

  test('"Allow and continue" records consent through the bridge, then opens Screen Recording', async () => {
    let granted = false;
    const b = fakeBridge(PRELOAD, {
      getState: () => onbState({ consent: { granted, at: granted ? '2026-10-15T12:00:00Z' : null, version: granted ? 1 : null, processor: HOSTED_PROCESSOR } }),
      grantConsent: () => { granted = true; return { ok: true }; }
    });
    const { doc, $ } = await runWindow('onboarding', b.api);
    assert.equal(stepOn(doc), 1);
    $('btn-consent-allow').click();
    await settle();
    assert.equal(b.called('grantConsent').length, 1);
    assert.equal(stepOn(doc), 2);
    assert.deepEqual(b.called('setStep').map(c => c[1]), [2]);
    // Back on the first screen, consent shows as given and Continue replaces the buttons.
    $('btn-2-back').click();
    await settle();
    assert.equal($('btn-consent-allow').hidden, true);
    assert.equal($('btn-1-continue').hidden, false);
    assert.match($('consent-granted').textContent, /You allowed this on .*2026/);
  });

  test('a grant the main process did not record keeps setup on the card', async () => {
    const b = fakeBridge(PRELOAD, {
      getState: () => onbState({ consent: { granted: false, at: null, version: null, processor: HOSTED_PROCESSOR } }),
      grantConsent: () => ({ ok: true })
    });
    const { doc, $ } = await runWindow('onboarding', b.api);
    $('btn-consent-allow').click();
    await settle();
    assert.equal(stepOn(doc), 1);
    assert.match($('consent-status').textContent, /could not save your choice/);
  });

  test('a main process with no consent bridge at all still lets setup go on', async () => {
    const b = fakeBridge(PRELOAD, { getState: () => onbState() }, { omit: ['grantConsent'] });
    const { doc, $, errors } = await runWindow('onboarding', b.api);
    $('btn-consent-allow').click();
    await settle();
    assert.equal(stepOn(doc), 2);
    assert.deepEqual(errors, []);
  });

  test('setup done but consent missing: the window is only the consent card', async () => {
    let granted = false;
    const b = fakeBridge(PRELOAD, {
      getState: () => onbState({ completed: true, step: 5, consent: { granted, at: null, version: null, processor: HOSTED_PROCESSOR } }),
      grantConsent: () => { granted = true; return { ok: true }; }
    });
    const { doc, $ } = await runWindow('onboarding', b.api);
    assert.equal(stepOn(doc), 1);
    assert.equal($('h1-1').textContent, 'Before Grayout keeps watching');
    assert.equal($('intro').hidden, true);
    assert.equal($('consent-only-lede').hidden, false);
    assert.equal($('progress').textContent, '');
    assert.equal($('move-bar').hidden, true);
    $('btn-consent-allow').click();
    await settle();
    assert.equal(b.called('grantConsent').length, 1);
    assert.equal(stepOn(doc), 1, 'the main process closes the window; it never walks back into setup');
    assert.equal(b.called('setStep').length, 0);
    assert.match($('consent-status').textContent, /watching again/);
  });

  test('own key or the Claude CLI: the card names that provider and its terms, not the hosted ones', async () => {
    for (const [processor, re] of [
      [{ name: 'Anthropic', via: 'your own API key' }, /straight to Anthropic[\s\S]*your own API key[\s\S]*Anthropic's terms/],
      [{ name: 'Anthropic', via: 'your Claude CLI login' }, /Claude CLI[\s\S]*sends them to Anthropic/],
      [{ name: 'OpenAI', via: 'your own API key' }, /straight to OpenAI[\s\S]*your own API key/]
    ]) {
      const b = fakeBridge(PRELOAD, { getState: () => onbState({ consent: { granted: false, at: null, version: null, processor } }) });
      const { $ } = await runWindow('onboarding', b.api);
      const text = `${$('consent-lede').textContent} ${$('consent-who').textContent}`;
      assert.match(text, re);
      assert.equal(/30 days|keeps none of them/.test(text), false, `${processor.via}: the hosted terms do not apply`);
    }
  });

  test('Mac App Store: no move bar, no Terminal fix, free checks lead, no license box', async () => {
    const b = fakeBridge(PRELOAD, {
      getState: () => onbState({
        step: 3, isPackaged: true, inApplications: false, screen: 'stale', tccResetCmd: null,
        channel: channelPayload('mas'),
        consent: { granted: true, at: '2026-10-15T12:00:00Z', version: 1, processor: HOSTED_PROCESSOR }
      })
    });
    const { doc, $, errors } = await runWindow('onboarding', b.api);
    assert.deepEqual(errors, []);
    assert.equal(stepOn(doc), 3);
    assert.equal($('btn-free').classList.contains('btn-primary'), true);
    assert.equal($('btn-subscribe').classList.contains('btn-primary'), false);
    assert.equal($('license-block').hidden, true);
    const kids = $('plan-group').parentNode.children;
    assert.ok(kids.indexOf($('free-card')) < kids.indexOf($('plan-group')), 'the free card comes first');
    assert.match($('pay-note').textContent, /LINK\.COM\*/, 'the US listing keeps the Stripe copy');
    $('btn-3-back').click();
    await settle();
    assert.equal(stepOn(doc), 2);
    assert.equal($('stale-box').hidden, false);
    assert.equal($('tcc-row').hidden, true);
    assert.equal($('tcc-end').hidden, false);
    $('btn-2-back').click();
    await settle();
    assert.equal($('move-bar').hidden, true, 'the App Store installs the app itself');
  });

  test('the direct build keeps Subscribe as the primary and its license box', async () => {
    const b = fakeBridge(PRELOAD, {
      getState: () => onbState({ step: 3, channel: channelPayload('direct'), consent: { granted: true, at: null, version: 1, processor: HOSTED_PROCESSOR } })
    });
    const { doc, $ } = await runWindow('onboarding', b.api);
    assert.equal(stepOn(doc), 3);
    assert.equal($('btn-subscribe').classList.contains('btn-primary'), true);
    assert.equal($('btn-free').classList.contains('btn-primary'), false);
    assert.equal($('license-block').hidden, false);
  });
});

function dashData(over = {}) {
  return {
    stats: {}, live: {}, config: { checkIntervalSec: 45, strikes: 2, engine: 'api', provider: 'grayout', providerLabel: 'Grayout', model: '' },
    version: '2.0.0',
    account: { ok: true, configured: true, hasLicense: false, usage: { checksUsed: 3, checksIncluded: pricing.FREE_CHECKS } },
    plans: pricing.PLANS, freeChecks: pricing.FREE_CHECKS, includedChecks: pricing.INCLUDED_CHECKS,
    selfHosted: false, hasKey: false, keyMasked: '', update: null, dataDir: '/tmp/grayout-test',
    ...over
  };
}
function dashSettings(over = {}) {
  return {
    config: { checkIntervalSec: 45, strikes: 2, workDescription: '', grayscale: true, redFlash: true, camera: false, startAtLogin: false, checkForUpdates: true, pauseWhenLocked: true, alwaysAllowedApps: [], neverCaptureApps: [] },
    account: dashData().account, plans: pricing.PLANS, freeChecks: pricing.FREE_CHECKS, includedChecks: pricing.INCLUDED_CHECKS,
    selfHosted: false, keyMasked: '', hasKey: false, secureStorage: true,
    loginItem: { status: 'not-registered', inApplications: true }, estimates: { byInterval: {} },
    permissions: { screen: 'granted', camera: 'not-determined' }, paths: {},
    tccResetCmd: 'tccutil reset ScreenCapture com.aarushkandukoori.grayout', version: '2.0.0', isPackaged: true,
    ...over
  };
}

test.describe('the dashboard, run', () => {
  const PRELOAD = 'ui/preload/dashboard.js';
  const hidden = el => el.classList.contains('hidden');

  test('a payload with no channel and no consent renders the direct build without throwing', async () => {
    const b = fakeBridge(PRELOAD, { get: () => dashData(), getSettings: () => dashSettings() }, { omit: ['grantConsent', 'revokeConsent', 'eraseData'] });
    const { $, errors } = await runWindow('dashboard', b.api);
    assert.deepEqual(errors, []);
    assert.equal($('f-consent').checked, false);
    assert.equal($('banner-slot').children.length, 0, 'no consent banner without a consent record');
    assert.equal(hidden($('row-updates')), false);
    assert.equal(hidden($('tcc-row')), false);
    assert.equal(hidden($('connect-block')), true);
    assert.equal(hidden($('license-row')), false);
    assert.equal(hidden($('buy-note')), false);
    assert.match($('camera-hint').textContent, /to the Grayout service in the same check/);
    assert.equal(/under your key/.test($('camera-hint').textContent), false, 'the v1 "under your key" copy is gone on the hosted plan');
    assert.match($('consent-note').textContent, /OpenAI, a third-party AI provider/);
    // Without the bridges the switch and the erase button say so instead of throwing.
    $('f-consent').checked = true;
    $('f-consent').dispatch('change');
    await settle();
    assert.equal($('f-consent').checked, false);
    $('btn-erase').click();
    await settle();
    assert.match($('erase-status').textContent, /cannot erase/);
    assert.deepEqual(errors, []);
  });

  test('consent off: a banner says nothing is checked, and the switch grants and withdraws', async () => {
    let granted = false;
    const consent = () => ({ granted, at: null, version: granted ? 1 : null, processor: HOSTED_PROCESSOR });
    const b = fakeBridge(PRELOAD, {
      get: () => dashData({ consent: consent() }),
      getSettings: () => dashSettings({ consent: consent() }),
      grantConsent: () => { granted = true; return { ok: true }; },
      revokeConsent: () => { granted = false; return { ok: true }; }
    });
    const { $, errors } = await runWindow('dashboard', b.api);
    assert.match($('banner-slot').textContent, /not sending screenshots, so nothing is being checked/);
    assert.match($('headline').textContent, /screenshots are off/);
    assert.equal($('f-consent').checked, false);
    $('f-consent').checked = true;
    $('f-consent').dispatch('change');
    await settle();
    assert.equal(b.called('grantConsent').length, 1);
    assert.equal($('f-consent').checked, true);
    assert.equal(/not sending screenshots/.test($('banner-slot').textContent), false);
    $('f-consent').checked = false;
    $('f-consent').dispatch('change');
    await settle();
    assert.equal(b.called('revokeConsent').length, 1);
    assert.equal($('f-consent').checked, false);
    assert.match($('consent-msg').textContent, /Nothing is captured or sent/);
    assert.deepEqual(errors, []);
  });

  test('erase goes through the main process, which asks first', async () => {
    const b = fakeBridge(PRELOAD, { get: () => dashData(), getSettings: () => dashSettings(), eraseData: () => ({ ok: false, cancelled: true }) });
    const { $ } = await runWindow('dashboard', b.api);
    assert.equal($('btn-erase').textContent, "Erase this Mac's Grayout data");
    $('btn-erase').click();
    await settle();
    assert.equal(b.called('eraseData').length, 1);
    assert.equal($('erase-status').textContent, 'Nothing was erased.');
  });

  test('Mac App Store: no update toggle or banner, no key panel, no Terminal fix, license under "Connect an existing subscription"', async () => {
    const ch = channelPayload('mas');
    const consent = { granted: true, at: '2026-10-15T12:00:00Z', version: 1, processor: HOSTED_PROCESSOR };
    const b = fakeBridge(PRELOAD, {
      get: () => dashData({ channel: ch, consent, update: { url: 'https://github.com/x', version: '9.9.9' }, selfHosted: false }),
      getSettings: () => dashSettings({ channel: ch, consent, tccResetCmd: null })
    });
    const { $, errors } = await runWindow('dashboard', b.api);
    assert.deepEqual(errors, []);
    assert.equal(/is available/.test($('banner-slot').textContent), false, 'no update banner');
    assert.equal(hidden($('row-updates')), true);
    assert.ok($('f-checkForUpdates'), 'hidden, never deleted');
    assert.equal(hidden($('key-panel')), true);
    assert.equal(hidden($('tcc-row')), true);
    assert.equal(hidden($('buy-note')), true);
    assert.equal(hidden($('connect-block')), false);
    assert.equal(hidden($('license-row')), true, 'collapsed until asked for');
    $('btn-connect-sub').click();
    assert.equal(hidden($('license-row')), false);
    assert.equal($('btn-connect-sub').getAttribute('aria-expanded'), 'true');
    assert.equal(/Canvas|tasks file/.test($('adv-note').textContent), false);
    assert.equal($('f-consent').checked, true);
    assert.match($('billing-note').textContent, /LINK\.COM\*/, 'the US listing keeps the Stripe copy');
  });

  test('Mac App Store with manual license entry switched off: no license field at all', async () => {
    const ch = channelPayload('mas');
    ch.features.manualLicenseEntry = false;
    const b = fakeBridge(PRELOAD, { get: () => dashData({ channel: ch }), getSettings: () => dashSettings({ channel: ch }) });
    const { $ } = await runWindow('dashboard', b.api);
    assert.equal(hidden($('connect-block')), true);
    assert.equal(hidden($('license-row')), true);
  });
});
