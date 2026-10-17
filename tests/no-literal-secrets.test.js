'use strict';
// No file in the repository may hold a literal shaped like a provider secret,
// not even an obviously fake one in a test. GitHub's secret scanning cannot
// tell a fake from a leak, so a fake webhook secret in a test fixture once
// raised nine "possible valid secret" alerts. Build fakes at runtime instead:
//   ['whsec', 'TestOnly0123456789abcdefghij'].join('_')
// The four patterns are the key formats this repo's providers use; GitHub
// alerts on all of them. "Not right after a letter or digit" (rather than \b)
// so that a prefix glued on with an underscore, like FAKE_whsec_..., still counts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');

const PATTERNS = [
  ['Stripe webhook secret', /(?<![A-Za-z0-9])whsec_[A-Za-z0-9+/=]{24,}/],
  ['Stripe secret or restricted key', /(?<![A-Za-z0-9])(sk|rk)_(test|live|prod)_[A-Za-z0-9]{10,}/],
  ['OpenAI key', /(?<![A-Za-z0-9])sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/],
  ['Anthropic key', /(?<![A-Za-z0-9])sk-ant-(api|admin|oat|ort)[0-9]{2}-[A-Za-z0-9_-]{20,}/]
];

/** The line number and pattern name of every secret-shaped literal in `text`. */
function findLiterals(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, regex] of PATTERNS) {
      if (regex.test(line)) hits.push({ line: i + 1, name });
    }
  });
  return hits;
}

/** Every file git tracks, plus new files that are not ignored yet. */
function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

test('the matcher flags one sample of each pattern, and not a bare prefix', () => {
  const samples = [
    ['whsec', 'TestOnly0123456789abcdefghij'].join('_'),
    ['rk', 'live', 'TestOnly0123456789'].join('_'),
    ['sk', 'proj', 'TestOnly0123456789abcdefghij'].join('-'),
    ['sk', 'ant', 'api03', 'TestOnly0123456789abcdefghij'].join('-')
  ];
  assert.deepEqual(samples.map(s => findLiterals(`key = '${s}'`).map(h => h.name)), PATTERNS.map(([name]) => [name]));
  assert.deepEqual(findLiterals('FAKE_' + samples[0]).map(h => h.name), ['Stripe webhook secret']);
  assert.deepEqual(findLiterals('Anthropic keys start with sk-ant-, webhook secrets with whsec_.'), []);
});

test('no file in the repository holds a secret-shaped literal', () => {
  const files = repoFiles();
  assert.ok(files.includes('tests/no-literal-secrets.test.js'), 'git listed the repository files');
  const problems = [];
  for (const file of files) {
    const stat = fs.lstatSync(path.join(REPO, file), { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) continue; // deleted from disk, or a symlink
    const bytes = fs.readFileSync(path.join(REPO, file));
    if (bytes.includes(0)) continue; // binary: images, icons
    for (const hit of findLiterals(bytes.toString('utf8'))) {
      problems.push(`${file}:${hit.line} (${hit.name})`);
    }
  }
  assert.equal(problems.length, 0,
    `Secret-shaped literals (build fakes at runtime instead, see CONTRIBUTING.md):\n  ${problems.join('\n  ')}`);
});
