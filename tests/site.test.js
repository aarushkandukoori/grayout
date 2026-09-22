'use strict';
// Static checks over docs/ — the public site. It has no build step and no test
// runner of its own, so the things that quietly rot (a price that no longer
// matches src/pricing.js, a link to a page that was renamed, a remote font
// added "just for this one page") are checked here instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PLANS, FREE_CHECKS, INCLUDED_CHECKS } = require('../src/pricing');

const DOCS = path.join(__dirname, '..', 'docs');
const PAGES = fs.readdirSync(DOCS).filter(f => f.endsWith('.html'));
const read = f => fs.readFileSync(path.join(DOCS, f), 'utf8');

/** Visible copy: comments, scripts, styles and tags removed. */
function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

test('the site ships at least the landing, pricing and privacy pages', () => {
  for (const f of ['index.html', 'pricing.html', 'privacy.html', 'install.html', 'success.html']) {
    assert.equal(PAGES.includes(f), true, `docs/${f} is missing`);
  }
});

test.describe('prices on the site match src/pricing.js', () => {
  const pricing = read('pricing.html');
  const index = read('index.html');

  test('the monthly plan', () => {
    for (const page of [pricing, index]) {
      assert.match(page, new RegExp(`\\${PLANS.monthly.priceLabel}\\b`));
    }
    assert.match(visibleText(pricing), new RegExp(`${PLANS.monthly.trialDays}[\\s\\u00a0-]day`, 'i'));
  });

  test('the yearly plan, its per-month figure and its savings', () => {
    assert.match(pricing, new RegExp(`\\${PLANS.yearly.priceLabel}\\b`));
    assert.match(pricing, new RegExp(`\\${PLANS.yearly.perMonthLabel}\\b`),
      'the "$X a month, billed yearly" figure must be the computed one');
    assert.match(pricing, new RegExp(`${PLANS.yearly.savingsPercent}\\s*%`),
      'the savings percentage must be the computed one');
  });

  test('the free taste and the included allowance', () => {
    assert.match(visibleText(pricing), new RegExp(`${FREE_CHECKS}\\s+checks`));
    assert.match(pricing, new RegExp(INCLUDED_CHECKS.toLocaleString('en-US')));
  });

  test('the selling pages quote no price the pricing module does not know', () => {
    // Only the pages that sell. install.html quotes Apple's $99 developer fee
    // and api-key.html quotes per-check provider prices; neither is a plan.
    const known = new Set([PLANS.monthly.priceLabel, PLANS.yearly.priceLabel, PLANS.yearly.perMonthLabel, '$0']);
    for (const f of ['index.html', 'pricing.html', 'success.html']) {
      const quoted = [...visibleText(read(f)).matchAll(/\$\d+(?:\.\d{2})?/g)].map(m => m[0]);
      const unknown = [...new Set(quoted)].filter(p => !known.has(p));
      assert.deepEqual(unknown, [], `docs/${f} quotes ${unknown.join(', ')}`);
    }
  });
});

test.describe('the site asks the network for nothing', () => {
  for (const f of PAGES) {
    test(`docs/${f}`, () => {
      const html = read(f);
      assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, 'no inline <script>');
      // Subresources only: a <link rel="canonical">, an <a href> and an
      // og:image URL are all references, not fetches the page makes.
      const remote = [
        ...[...html.matchAll(/<(?:script|img|iframe|source|video|audio)\b[^>]*\bsrc="(https?:\/\/[^"]+)"/gi)].map(m => m[1]),
        ...[...html.matchAll(/<link\b[^>]*>/gi)]
          .filter(tag => /\brel="(?:stylesheet|preload|prefetch|preconnect|dns-prefetch|icon|apple-touch-icon|manifest|modulepreload)"/i.test(tag[0]))
          .map(tag => (tag[0].match(/\bhref="(https?:\/\/[^"]+)"/i) || [])[1])
          .filter(Boolean)
      ];
      assert.deepEqual(remote, [], `remote subresource: ${remote.join(', ')}`);
      assert.equal(/\sstyle="/.test(html), false, 'no inline style attributes');
    });
  }

  test('the stylesheet pulls in nothing either', () => {
    const css = fs.readFileSync(path.join(DOCS, 'style.css'), 'utf8');
    assert.equal(/@import/.test(css), false);
    assert.equal(/url\(\s*['"]?(?:https?:)?\/\//.test(css), false);
  });
});

test.describe('every internal link resolves', () => {
  const ids = Object.fromEntries(PAGES.map(f => [f, new Set([...read(f).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))]));

  for (const f of PAGES) {
    test(`docs/${f}`, () => {
      const html = read(f);
      const broken = [];
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (/^(?:https?:|data:|mailto:)/.test(href)) continue;
        const [page, frag] = href.split('#');
        const target = page || f;
        if (!PAGES.includes(target)) {
          if (!fs.existsSync(path.join(DOCS, target))) broken.push(`${href} (no such file)`);
          continue;
        }
        if (frag && !ids[target].has(frag)) broken.push(`${href} (no such anchor)`);
      }
      for (const [, src] of html.matchAll(/src="([^"]+)"/g)) {
        if (/^(?:https?:|data:)/.test(src)) continue;
        if (!fs.existsSync(path.join(DOCS, src))) broken.push(`${src} (no such asset)`);
      }
      assert.deepEqual(broken, []);
    });
  }
});

test.describe('house style', () => {
  for (const f of PAGES) {
    test(`docs/${f} spells it gray and does not shout`, () => {
      const text = visibleText(read(f));
      assert.equal(/\bgrey\b/i.test(text), false, 'it is spelled gray');
      const shouts = [...text.matchAll(/\w!/g)].map(m => text.slice(Math.max(0, m.index - 40), m.index + 2).trim());
      assert.deepEqual(shouts, [], 'no exclamation marks in product copy');
    });
  }

  test('no page invents a user count, a testimonial or an accuracy figure', () => {
    for (const f of PAGES) {
      const text = visibleText(read(f));
      assert.equal(/\b\d[\d,]*\s+(?:happy\s+)?(?:users|customers|developers|teams)\b/i.test(text), false,
        `docs/${f} claims a user count`);
      assert.equal(/\b\d{2}(?:\.\d+)?%\s+(?:accurate|accuracy)\b/i.test(text), false,
        `docs/${f} claims an accuracy figure`);
    }
  });
});

test('the app never points at a site page that does not exist', () => {
  const SITE = 'https://aarushkandukoori.github.io/grayout/';
  const roots = ['ui', 'src', path.join('ui', 'preload')];
  const broken = [];
  for (const dir of roots) {
    const abs = path.join(__dirname, '..', dir);
    for (const f of fs.readdirSync(abs)) {
      if (!/\.(js|html)$/.test(f)) continue;
      const src = fs.readFileSync(path.join(abs, f), 'utf8');
      for (const [, page] of src.matchAll(new RegExp(`${SITE}([\\w.-]+\\.html)`, 'g'))) {
        if (!PAGES.includes(page)) broken.push(`${dir}/${f} -> ${page}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
