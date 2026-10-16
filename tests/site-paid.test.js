'use strict';
// Pay-only public builds (owner decision, 2026-10-15). From 2.0, every release
// build runs on the Grayout service: the free checks, the trial or Grayout Pro.
// Own-key mode and the Claude CLI engine are not offered by any public build.
//
// The site has to stay true in both eras. While the service is off (today: the
// only release, 1.0.1, runs on your own key), the own-key guide stays visible.
// Once the service is on ("service", "soon", "live"), no page may offer an own
// key. app.js sets html[data-service] and style.css hides [data-when="noservice"]
// when it is on, so every own-key mention must sit inside a data-when="noservice"
// block, or say in the same sentence block that it is about Grayout 1.x.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const PAGES = fs.readdirSync(DOCS).filter(f => f.endsWith('.html'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------------------------------------------------------------- */
/* A small HTML tree, enough for these hand-written pages                  */
/* ---------------------------------------------------------------------- */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', mdash: '-', ndash: '-', copy: '(c)' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Elements: { tag, attrs, children, parent }. Text: { text, parent }. */
function parse(html) {
  const doc = { tag: '#document', attrs: {}, children: [], parent: null };
  const stack = [doc];
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<!doctype[^>]*>|<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
  for (const m of src.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1]) { top.children.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2]), children: [], parent: top }); continue; }
    if (m[6] !== undefined) { top.children.push({ text: decode(m[6]), parent: top }); continue; }
    if (!m[4]) continue; // doctype
    const tag = m[4].toLowerCase();
    if (m[3]) { // closing tag: pop back to the matching element, ignore a stray one
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[5].replace(/\/\s*$/, '')), children: [], parent: top };
    top.children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[5])) stack.push(node);
  }
  return doc;
}

function* walk(node) {
  yield node;
  for (const c of node.children || []) yield* walk(c);
}

function textOf(node) {
  if (node.text !== undefined) return node.text;
  if (node.tag === 'script' || node.tag === 'style') return '';
  return (node.children || []).map(textOf).join('');
}

function ancestors(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.push(n);
  return out;
}

/* ---------------------------------------------------------------------- */
/* What counts as an own-key mention, and what counts as scoped            */
/* ---------------------------------------------------------------------- */

// Own-key mode, its providers, its guide, self-hosting and the CLI engine.
// "No API key", "Grayout's API key" (the service's) and "your own Mac" are not.
const MENTION = new RegExp([
  String.raw`\bown[\s-]+(?:API[\s-]+)?keys?\b`,
  String.raw`\bown\s+(?:OpenAI|Anthropic)\b`,
  String.raw`\byour\s+(?:OpenAI\s+or\s+Anthropic|OpenAI|Anthropic)(?:\s+API)?\s+key`,
  String.raw`\byour\s+API\s+key`,
  String.raw`\bAnthropic\b`,
  String.raw`api-key\.html`,
  String.raw`\bBYOK\b`,
  String.raw`bring\s+your\s+own`,
  String.raw`\bClaude\s+CLI\b`,
  String.raw`\bengine:?\s*"?cli\b`,
  String.raw`self-host`,
  String.raw`\byour\s+provider\b`
].join('|'), 'i');

// "1.x", "1.0", "1.0.1", "1.0.x" as a version, not "21.0" or "v1.0.1".
const SCOPE_1X = /(?<![\w.])1\.(?:x|0(?:\.[0-9x])?)\b/;

const BLOCKS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'caption', 'title', 'blockquote', 'summary', 'label', 'button', 'option']);
const CHECKED_ATTRS = ['href', 'alt', 'title', 'aria-label', 'content', 'data-copy', 'placeholder', 'value'];

const inNoService = node => ancestors(node).some(n => n.attrs && n.attrs['data-when'] === 'noservice');

/** A changelog release section whose version heading is 1.x (changelog.html). */
function inOldRelease(node, byId) {
  return ancestors(node).some(n => {
    if (!n.attrs || !/\brelease\b/.test(n.attrs.class || '')) return false;
    const label = byId.get(n.attrs['aria-labelledby']);
    return !!label && /^\s*1\./.test(textOf(label));
  });
}

function nearestBlock(node) {
  return ancestors(node).find(n => n.tag && BLOCKS.has(n.tag)) || null;
}

/** Every own-key mention on a page that would still show with the service on. */
function unscopedMentions(html) {
  const doc = parse(html);
  const byId = new Map();
  for (const n of walk(doc)) if (n.attrs && n.attrs.id) byId.set(n.attrs.id, n);
  const bad = [];
  const judge = (node, snippet, ownText) => {
    if (inNoService(node) || inOldRelease(node, byId)) return;
    const block = nearestBlock(node);
    const scopeText = (block ? textOf(block) : '') + ' ' + (ownText || '');
    if (SCOPE_1X.test(scopeText)) return;
    bad.push(snippet.replace(/\s+/g, ' ').trim().slice(0, 140));
  };
  for (const n of walk(doc)) {
    if (n.text !== undefined) {
      if (MENTION.test(n.text)) judge(n.parent, n.text);
      continue;
    }
    if (!n.attrs) continue;
    // A page's own address (<link rel="canonical">, og:url) is not an offer.
    const selfRef = n.tag === 'link' || (n.tag === 'meta' && n.attrs.property === 'og:url');
    for (const a of CHECKED_ATTRS) {
      if (selfRef) break;
      const v = n.attrs[a];
      // An attribute on a void element (a <meta> description, an <img> alt)
      // is its own block: it must name 1.x itself.
      if (v && MENTION.test(v)) judge(n, `${n.tag}[${a}]: ${v}`, VOID.has(n.tag) ? v : '');
    }
  }
  return bad;
}

/** Visible text of every data-when="service" block on a page (the 2.0 era). */
function serviceCopy(html) {
  const doc = parse(html);
  return [...walk(doc)].filter(n => n.attrs && n.attrs['data-when'] === 'service').map(n => textOf(n).replace(/\s+/g, ' '));
}

/* ---------------------------------------------------------------------- */
/* Tests                                                                   */
/* ---------------------------------------------------------------------- */

test.describe('the checker itself', () => {
  test('flags an own-key offer and accepts the two ways of scoping it', () => {
    assert.equal(unscopedMentions('<p>Run it on your own API key.</p>').length, 1);
    assert.equal(unscopedMentions('<p><a href="api-key.html">Guide</a></p>').length, 1);
    assert.equal(unscopedMentions('<meta name="description" content="Or run it free on your own API key.">').length, 1);
    assert.equal(unscopedMentions('<ul><li>Screenshots go straight to your provider</li></ul>').length, 1);
    assert.equal(unscopedMentions('<p>Claude CLI engine</p>').length, 1);
    assert.equal(unscopedMentions('<div data-when="noservice"><p>Run it on your own key.</p></div>').length, 0);
    assert.equal(unscopedMentions('<p>Grayout 1.x runs on your own API key.</p>').length, 0);
    assert.equal(unscopedMentions('<p>Grayout 1.0.1 runs on <span>your own key</span>.</p>').length, 0);
    assert.equal(unscopedMentions('<meta name="description" content="Grayout 1.x runs on your own key.">').length, 0);
    assert.equal(unscopedMentions('<p>No API key to get, and Grayout&rsquo;s API key stays on the service.</p>').length, 0);
    assert.equal(unscopedMentions('<p>Use it on your own Mac.</p>').length, 0);
    // A 1.x mention elsewhere on the page does not scope this sentence.
    assert.equal(unscopedMentions('<p>Grayout 1.0.1 shipped.</p><p>Use your own key.</p>').length, 1);
    // A 1.x release section of the changelog scopes its own list.
    const rel = '<section class="release" aria-labelledby="v100"><p class="v" id="v100">1.0.0</p><ul><li>Anthropic keys</li></ul></section>';
    assert.equal(unscopedMentions(rel).length, 0);
    assert.equal(unscopedMentions(rel.replace(/1\.0\.0/, '2.0')).length, 1);
  });

  test('the mechanism it relies on: data-service follows apiBase, and noservice hides when it is on', () => {
    const css = read('docs/style.css');
    assert.match(css, /html\[data-service="on"\] \[data-when="noservice"\]/);
    assert.match(css, /html:not\(\[data-service="on"\]\) \[data-when="service"\]/);
    assert.match(read('docs/app.js'), /root\.setAttribute\('data-service', CFG\.apiBase \? 'on' : 'off'\)/);
  });
});

test.describe('with the service on, no page offers an own key or the Claude CLI', () => {
  for (const f of PAGES) {
    test(`docs/${f}: every own-key mention is in data-when="noservice" or scoped to 1.x`, () => {
      assert.deepEqual(unscopedMentions(read(`docs/${f}`)), []);
    });
  }

  test('links to the own-key guide only exist while the service is off', () => {
    for (const f of PAGES) {
      const doc = parse(read(`docs/${f}`));
      const open = [...walk(doc)].filter(n => n.tag === 'a' && /(?:^|\/)api-key\.html(?:#|$)/.test(n.attrs.href || '') && !inNoService(n));
      assert.deepEqual(open.map(n => textOf(n).trim()), [], `docs/${f}`);
    }
  });

  test('the "Your own key" plan card and comparison column hide with the service on', () => {
    for (const f of ['index.html', 'pricing.html']) {
      const html = read(`docs/${f}`);
      assert.match(html, /<article class="plan plan--own[^"]*"[^>]*data-when="noservice"/, f);
    }
    const pricing = read('docs/pricing.html');
    assert.match(pricing, /<th scope="col" data-when="noservice"><span class="t">Your own key<\/span>/);
    const css = read('docs/style.css');
    assert.match(css, /html\[data-service="on"\] \.plans\{grid-template-columns:repeat\(2,/, 'two plans share the row once the own-key card hides');
  });
});

test.describe('with the service on, the site says plainly what Grayout needs', () => {
  for (const f of ['index.html', 'pricing.html', 'download.html', 'api-key.html']) {
    test(`docs/${f}`, () => {
      const copy = serviceCopy(read(`docs/${f}`));
      assert.ok(copy.some(t => /Grayout service/.test(t) && /Grayout Pro/.test(t) && /100 free checks/.test(t)),
        'a data-when="service" block names the Grayout service, the free checks and Grayout Pro');
    });
  }

  test('api-key.html says own keys were a 1.x feature and keeps the 1.x guide for the service-off state', () => {
    const html = read('docs/api-key.html');
    assert.ok(serviceCopy(html).some(t => /The own-key mode of Grayout 1\.x is not in it/.test(t)));
    assert.match(html, /<title>[^<]*Grayout 1\.x[^<]*<\/title>/);
    assert.match(html, /<div class="prose" data-when="noservice">\s*<p class="small">Your own key works in Grayout 1\.0\.1/);
  });
});

test.describe('nothing says a 1.x key carries over into 2.0', () => {
  const files = ['docs/changelog.html', 'docs/download.html', 'docs/api-key.html', 'README.md', 'CHANGELOG.md'];

  test('no "updating changes nothing" or "keeps using that key" promise', () => {
    for (const f of files) {
      const t = read(f).replace(/&rsquo;/g, "'");
      assert.equal(/Updating changes nothing|keeps using (?:that|the|its|a saved) key|key is still there and still used|stays supported in the direct download/i.test(t), false, f);
    }
  });

  test('the 2.0 changelog entry says own-key mode and the Claude CLI engine are not in the download', () => {
    const html = read('docs/changelog.html');
    const v2 = html.slice(html.indexOf('aria-labelledby="v2"'), html.indexOf('aria-labelledby="v101"'));
    assert.match(v2, /own-key mode of Grayout 1\.x and the Claude CLI engine are not in the 2\.0 download/);
    assert.match(v2, /100 free checks/);
    assert.match(v2, /7-day trial or Grayout Pro/);
  });
});

test.describe('the repository docs describe pay-only release builds', () => {
  test('README: no instructions for turning on own-key mode, self-hosting or the CLI engine', () => {
    const readme = read('README.md');
    assert.equal(/^## Self-hosting/m.test(readme), false);
    assert.equal(/(?:OPENAI|ANTHROPIC)_API_KEY|"provider":\s*"(?:openai|anthropic)"|"engine":\s*"cli"|`engine`\s*\||`cliPath`|`provider`\s*\|/.test(readme), false);
    assert.match(readme, /^## Pay-only release builds$/m);
    assert.match(readme, /Every 2\.0 release build runs only on the Grayout service/);
    assert.match(readme, /Neither has an own-key mode or a Claude CLI engine/);
  });

  test('README edition table: "Runs on" is labelled 2.0, since today\'s download is 1.0.1 on your own key', () => {
    const readme = read('README.md');
    assert.match(readme, /^\| Available \| Yes \(1\.0\.1 today, which runs on your own API key\) \|/m);
    assert.match(readme, /^\| Runs on \(2\.0\) \| The Grayout service/m);
  });

  test('contributor docs, GitHub templates and owner runbooks make no self-hosting promise', () => {
    assert.equal(fs.existsSync(path.join(ROOT, '.github/DISCUSSION_TEMPLATE/hosted-waitlist.yml')), false, 'the waitlist template is gone (CHANGELOG)');
    const promises = /#self-hosting|will not be removed|self-hosting harder|Are you self-hosting|Run Grayout on your own API key|still works and bypasses|Self-hosting still works|README's Self-hosting section|point `apiBase` at an unreachable host/;
    for (const f of ['CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/install-problem.yml', 'server/README.md', 'server/scripts/deploy.sh', 'docs/API-CONTRACT.md', 'scripts/stranger-test.md']) {
      assert.equal(promises.test(read(f)), false, f);
    }
    const contributing = read('CONTRIBUTING.md');
    assert.match(contributing, /From 2\.0, release builds are pay-only/);
    assert.match(contributing, /only together with it does `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` supply a key/);
    // Testing the sandbox Worker: a public packaged build ignores apiBase.
    for (const f of ['server/README.md', 'server/scripts/deploy.sh']) {
      assert.match(read(f).replace(/\s+/g, ' '), /GRAYOUT_API_BASE=<sandbox url> npm start/, f);
      assert.match(read(f).replace(/\s+/g, ' '), /a public packaged build ignores `?apiBase/, f);
    }
  });

  test('SECURITY.md and the privacy policy offer no self-hosting way out and no CLI engine', () => {
    for (const f of ['SECURITY.md', 'PRIVACY.md', 'docs/privacy.html']) {
      const t = read(f);
      assert.equal(/self-host|`provider` set to|engine: "cli"|Claude CLI engine,|run on your own key or the Claude CLI/i.test(t), false, f);
    }
    for (const f of ['PRIVACY.md', 'docs/privacy.html']) {
      const t = read(f).replace(/<[^>]+>/g, '').replace(/\*\*/g, '');
      assert.match(t, /On your own key \(Grayout 1\.x only; 2\.0 and later have no own-key mode\)/, f);
      assert.match(t, /who receives it: OpenAI, through the Grayout service;/, f);
    }
  });

  test('no em dashes in the pay-only copy this change added', () => {
    for (const f of ['docs/api-key.html', 'docs/changelog.html', 'docs/download.html', 'docs/terms.html']) {
      assert.equal(/—|&mdash;/.test(read(f)), false, f);
    }
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Pay-only release builds'), readme.indexOf('## Settings and advanced config'));
    assert.equal(/—/.test(section), false);
  });
});
