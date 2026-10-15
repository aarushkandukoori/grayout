'use strict';
// The Mac App Store edition on the public site (docs/) and the listing package
// (store/mac-app-store/). docs/app.js runs here in a vm with a tiny stand-in
// DOM, so the masUrl rules and the cancelled-checkout note are tested for
// real; the rest are static checks on the pages, in the style of site.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const STORE = path.join(ROOT, 'store', 'mac-app-store');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGES = fs.readdirSync(DOCS).filter(f => f.endsWith('.html'));
const APP_JS = read('docs/app.js');

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function el(extra) {
  const attrs = {};
  return Object.assign({
    hidden: false,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    attrs
  }, extra);
}

/**
 * Runs docs/app.js against a stand-in page. `nodes` maps a selector to the
 * elements document.querySelectorAll should return for it.
 */
function runApp({ config = {}, search = '', nodes = {}, boot = false } = {}) {
  const root = el({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } });
  const errors = [];
  const replaced = [];
  const document = {
    documentElement: root,
    readyState: boot ? 'complete' : 'loading',
    addEventListener() {},
    querySelector(sel) { return (nodes[sel] || [])[0] || null; },
    querySelectorAll(sel) { return nodes[sel] || []; }
  };
  const win = {
    GRAYOUT_CONFIG: config,
    GRAYOUT_API_BASE: '__GRAYOUT_API_BASE__',
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}
  };
  const ctx = {
    window: win, document,
    location: { search, pathname: '/grayout/pricing.html', hash: '' },
    history: { replaceState(_s, _t, url) { replaced.push(url); } },
    navigator: { userAgent: '', platform: 'MacIntel', maxTouchPoints: 0 },
    URL, URLSearchParams, setTimeout, clearTimeout,
    requestAnimationFrame: fn => fn(),
    console: { warn() {}, log() {}, error: (...a) => errors.push(a.join(' ')) }
  };
  vm.createContext(ctx);
  vm.runInContext(APP_JS, ctx);
  return { attrs: root.attrs, G: win.Grayout, errors, replaced };
}

test.describe('masUrl in docs/config.js', () => {
  const LISTING = 'https://apps.apple.com/us/app/grayout-back-to-work/id1234567890?mt=12';

  test('empty means no App Store links anywhere (data-mas="off")', () => {
    const { attrs, G } = runApp({ config: { masUrl: '' } });
    assert.equal(attrs['data-mas'], 'off');
    assert.equal(G.cfg.masUrl, '');
  });

  test('a real apps.apple.com product page turns the links on', () => {
    for (const url of [LISTING, 'https://apps.apple.com/app/id1234567890', 'https://apps.apple.com/us/app/id123456']) {
      const { attrs, G } = runApp({ config: { masUrl: url } });
      assert.equal(attrs['data-mas'], 'on', url);
      assert.equal(G.cfg.masUrl, new URL(url).href);
    }
  });

  test('anything else is ignored, so a bad edit can never send people elsewhere', () => {
    const bad = [
      'http://apps.apple.com/us/app/grayout-back-to-work/id1234567890',
      'https://apps.apple.com.evil.example/us/app/x/id1234567890',
      'https://evil.example/us/app/x/id1234567890',
      'https://apps.apple.com/us/app/x/id12345',          // id too short
      'https://apps.apple.com/us/search?term=grayout',    // not a product page
      'https://apps.apple.com/us/app/x/id1234567890#top',
      'https://user:pw@apps.apple.com/us/app/x/id1234567890',
      'javascript:alert(1)', 'apps.apple.com/us/app/x/id1234567890', 42, null
    ];
    for (const url of bad) {
      const { attrs, G } = runApp({ config: { masUrl: url } });
      assert.equal(attrs['data-mas'], 'off', String(url));
      assert.equal(G.cfg.masUrl, '', String(url));
    }
  });

  test('the shipped config is empty or a valid listing (never a placeholder link)', () => {
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(read('docs/config.js'), ctx);
    const raw = ctx.window.GRAYOUT_CONFIG.masUrl;
    assert.equal(typeof raw, 'string');
    if (raw) assert.equal(runApp({ config: { masUrl: raw } }).attrs['data-mas'], 'on', 'masUrl is set but not a valid listing URL');
  });

  test('initMas points every [data-mas-link] at the listing', () => {
    const links = [el(), el()];
    const { errors } = runApp({ config: { masUrl: LISTING }, nodes: { '[data-mas-link]': links }, boot: true });
    assert.deepEqual(errors, []);
    for (const a of links) assert.equal(a.getAttribute('href'), LISTING);
  });

  test('style.css hides the App Store pieces until data-mas is on', () => {
    const css = read('docs/style.css');
    assert.match(css, /html:not\(\[data-mas="on"\]\) \[data-when="mas"\]/);
    assert.match(css, /html\[data-mas="on"\] \[data-when="nomas"\]/);
  });
});

test.describe('App Store links on the pages', () => {
  for (const f of PAGES) {
    test(`docs/${f}: at most one, always inside data-when="mas", never Apple artwork`, () => {
      const html = read(`docs/${f}`);
      const lines = html.split('\n').filter(l => l.includes('data-mas-link'));
      assert.ok(lines.length <= 1, `${lines.length} App Store links on one page`);
      for (const l of lines) {
        assert.match(l, /data-when="mas"/, 'the link must sit in a data-when="mas" element on the same line');
        assert.match(l, /United States only|United States/, 'say it is United States only');
        assert.match(l, /Grayout: Back to Work/, 'name the listing');
      }
      assert.equal(/mac-app-store-badge|apple\.com\/[^"']*\.(?:svg|png)/.test(html), false, 'no badge artwork until Aarush downloads the official one');
    });
  }

  test('download.html has a #mac-app-store section in its table of contents, true before the listing exists', () => {
    const html = read('docs/download.html');
    assert.match(html, /<h2 id="mac-app-store">/);
    assert.match(html, /<li><a href="#mac-app-store">/);
    assert.match(html, /<p data-when="nomas">[^<]*not listed yet/);
  });

  test('every page with a footer credits Apple, shown only with data-mas', () => {
    for (const f of PAGES.filter(p => p !== 'install.html')) {
      const html = read(`docs/${f}`);
      const credits = html.split('\n').filter(l => l.includes('are trademarks of Apple Inc.'));
      assert.equal(credits.length, 1, `docs/${f}`);
      assert.match(credits[0], /class="ftr__credit" data-when="mas"/, `docs/${f}`);
    }
  });
});

test.describe('the support page (the App Store Support URL)', () => {
  const html = read('docs/support.html');
  const text = visibleText(html);

  test('is in the sitemap and in every footer', () => {
    assert.match(read('docs/sitemap.xml'), /grayout\/support\.html<\/loc>/);
    for (const f of PAGES.filter(p => p !== 'install.html' && p !== 'support.html')) {
      const href = f === '404.html' ? '/grayout/support.html' : 'support.html';
      assert.ok(read(`docs/${f}`).includes(`<li><a href="${href}">Support</a></li>`), `docs/${f} footer`);
    }
  });

  test('shows the support email when configured, and a GitHub route when not', () => {
    assert.match(html, /<p data-when="support">Email <a href="#" data-support-email><\/a>/);
    assert.match(html, /<p data-when="nosupport">[^\n]*github\.com\/aarushkandukoori\/grayout\/issues/);
  });

  test('covers a stuck gray screen in both editions', () => {
    for (const s of ['Restore color now', 'I&rsquo;m working', 'Quit Grayout', 'Mac App Store edition', 'Color Filters', 'force quit']) {
      assert.ok(html.includes(s), s);
    }
  });

  test('force quit help works for a menu bar app: Activity Monitor or killall -9, never the Option-Command-Esc window', () => {
    // LSUIElement apps are not in the Force Quit window, and main.js handles
    // SIGTERM in JavaScript, so a hung Grayout ignores a plain killall.
    for (const f of ['docs/support.html', 'docs/download.html', 'README.md']) {
      const t = read(f).replace(/&rsquo;/g, "'");
      assert.match(t, /Activity Monitor, select Grayout, click Stop \(the X button\), then Force Quit/, f);
      assert.match(t, /killall -9 Grayout/, f);
      for (const sentence of t.split(/(?<=\.)\s/).filter(x => x.includes('Option-Command-Esc'))) {
        assert.match(sentence, /isn't listed/, `${f}: ${sentence}`);
      }
    }
    // The direct download's Color Filters gray outlives the process, so its
    // escape hatch stays next to the force quit help.
    assert.match(html, /Color Filters setting, which outlives a force quit/);
    assert.match(read('docs/download.html'), /Color Filters setting, which outlives a force quit/);
  });

  test('links cancelling, refunds, the account page and privacy', () => {
    for (const href of ['account.html', 'refunds.html', 'privacy.html', 'privacy.html#deletion', 'terms.html']) {
      assert.ok(html.includes(`href="${href}"`), href);
    }
  });

  test('has no em or en dashes', () => {
    assert.equal(/[\u2013\u2014]|&mdash;|&ndash;/.test(html), false);
    assert.ok(text.length > 1000);
  });
});

test.describe('privacy, terms and the purchase pages', () => {
  test('privacy.html and PRIVACY.md match: same date, same sections', () => {
    const html = read('docs/privacy.html');
    const md = read('PRIVACY.md');
    const date = html.match(/Effective (\d{4}-\d{2}-\d{2})/)[1];
    assert.equal(date, '2026-10-15');
    assert.match(md, new RegExp(`^Effective ${date}\\.`, 'm'));
    const h2html = [...html.matchAll(/<h2 id="[^"]+"><span class="grad">([^<]+)<\/span><\/h2>/g)].map(m => m[1].replace(/&rsquo;/g, "'"));
    const h2md = [...md.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    assert.deepEqual(h2md, h2html);
  });

  test('privacy covers the App Store edition, consent, retention, children and the processor commitment', () => {
    for (const doc of [read('docs/privacy.html'), read('PRIVACY.md')]) {
      const t = doc.replace(/&rsquo;/g, "'");
      assert.match(t, /If you got Grayout from the Mac App Store/);
      assert.match(t, /Allow and continue/);
      assert.match(t, /Send screenshots for checks/);
      assert.match(t, /up to 30 days/);
      assert.match(t, /same or equal protection/);
      assert.match(t, /not directed at children under 13/);
      assert.match(t, /System Settings &gt; Privacy &amp; Security &gt; Camera|System Settings > Privacy & Security > Camera/);
      assert.match(t, /~\/Library\/Containers\/com\.aarushkandukoori\.grayout/);
      assert.equal(/can't make promises on their behalf/.test(t), false, 'guideline 5.1.1(i) needs the processor commitment instead');
    }
  });

  test('terms set a minimum age and say Apple is not a party', () => {
    const t = read('docs/terms.html');
    assert.match(t, /<h2 id="age">/);
    assert.match(t, /at least 13 years old/);
    assert.match(t, /parent or guardian/);
    assert.match(t, /<h2 id="app-store">/);
    assert.match(t, /not Apple/);
    assert.match(t, /Cancelling is never done through Apple/);
    assert.match(t, /Effective 2026-10-15/);
  });

  test('a cancelled checkout from the app says nothing was charged and to go back to Grayout', () => {
    const html = read('docs/pricing.html');
    assert.match(html, /<p data-canceled-app hidden>Nothing was charged\. You can close this tab and go back to Grayout\.<\/p>/);

    const make = () => {
      const web = el({ hidden: false }), app = el({ hidden: true });
      const note = el({ hidden: true, querySelectorAll(sel) { return sel === '[data-canceled-web]' ? [web] : sel === '[data-canceled-app]' ? [app] : []; } });
      return { web, app, note };
    };
    let n = make();
    let r = runApp({ search: '?canceled=1&from=app', nodes: { '[data-canceled]': [n.note] }, boot: true });
    assert.deepEqual(r.errors, []);
    assert.equal(n.note.hidden, false);
    assert.equal(n.app.hidden, false);
    assert.equal(n.web.hidden, true);
    assert.deepEqual(r.replaced, ['/grayout/pricing.html'], 'both parameters leave the address bar');

    n = make();
    r = runApp({ search: '?canceled=1&plan=yearly', nodes: { '[data-canceled]': [n.note] }, boot: true });
    assert.equal(n.note.hidden, false);
    assert.equal(n.app.hidden, true);
    assert.equal(n.web.hidden, false);
    assert.deepEqual(r.replaced, ['/grayout/pricing.html?plan=yearly']);
  });

  test('after a purchase started in the app, success.html leads with "close this tab"', () => {
    const html = read('docs/success.html');
    assert.match(html, /<p class="app-done" data-from-app hidden><strong>You can close this tab\. Grayout in your menu bar is already unlocked\.<\/strong><\/p>/);
    assert.match(html, /<span data-from-app hidden>Key for another Mac<\/span>/);
    const claim = read('docs/claim.js');
    assert.match(claim, /\[data-from-web\]'\)\.forEach\(function \(n\) \{ n\.hidden = fromApp; \}\)/);
  });
});

test.describe('honesty', () => {
  const files = [
    ...PAGES.map(f => `docs/${f}`), 'README.md', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/BUILD-SPEC.md',
    ...fs.readdirSync(STORE).map(f => `store/mac-app-store/${f}`)
  ];

  test('the gray is never described as Core Image or CISaturationBlendMode', () => {
    for (const f of files) {
      if (f.endsWith('check-lengths.js')) continue;
      assert.equal(/CISaturationBlendMode|Core Image|CoreImage/.test(read(f)), false, f);
    }
  });

  test('nothing claims the app is on the App Store yet', () => {
    const readme = read('README.md');
    assert.match(readme, /### Mac App Store \(United States, coming soon\)\n\n\*\*Not listed yet\.\*\*/);
    for (const f of files) {
      assert.equal(/now (?:available )?on the (?:Mac )?App Store|available on the Mac App Store today/i.test(read(f)), false, f);
    }
  });
});

test('the App Store listing copy fits Apple\'s limits', () => {
  const { checkAll } = require('../store/mac-app-store/check-lengths');
  const results = checkAll();
  for (const name of ['name', 'subtitle', 'promotional', 'keywords', 'description', 'review-notes']) {
    assert.ok(results.some(r => r.field === name), `${name} is missing`);
  }
  for (const r of results) assert.ok(r.ok, `${r.field}: ${r.length} / ${r.max} ${r.unit}`);
  const notes = fs.readFileSync(path.join(STORE, 'review-notes.txt'), 'utf8');
  assert.equal(/gry_(?:live|test)_[0-9A-Z]{24}/.test(notes), false, 'never commit a real review key');
  assert.match(fs.readFileSync(path.join(STORE, 'listing.md'), 'utf8'), /Grayout: Back to Work/);
});
