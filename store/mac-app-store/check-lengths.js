#!/usr/bin/env node
'use strict';
// Checks the paste-ready App Store Connect copy against Apple's limits.
//
//   node store/mac-app-store/check-lengths.js
//
// listing.md marks each field like this, and the fenced block right after the
// marker is the exact text to paste:
//
//   <!-- field: subtitle, max: 30, unit: chars -->
//   ```text
//   Your Mac goes gray off task
//   ```
//
// review-notes.txt is checked as a whole (4,000 bytes), with the
// <REVIEWER_LICENSE_KEY> placeholder replaced by a real-length key
// (gry_live_ plus 24 characters), since that is what gets pasted.
// Every file in this folder is also checked for em and en dashes.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const KEY_PLACEHOLDER = '<REVIEWER_LICENSE_KEY>';
const SAMPLE_KEY = 'gry_live_' + '0'.repeat(24);

const measure = (text, unit) => (unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : [...text].length);

function listingFields(md) {
  const re = /<!--\s*field:\s*([\w-]+),\s*max:\s*(\d+),\s*unit:\s*(chars|bytes)\s*-->\s*\n```text\n([\s\S]*?)\n```/g;
  return [...md.matchAll(re)].map(([, field, max, unit, text]) => ({ field, max: Number(max), unit, text }));
}

function checkAll(dir = DIR) {
  const results = [];
  for (const f of listingFields(fs.readFileSync(path.join(dir, 'listing.md'), 'utf8'))) {
    const length = measure(f.text, f.unit);
    results.push({ field: f.field, length, max: f.max, unit: f.unit, ok: length > 0 && length <= f.max });
  }
  const notes = fs.readFileSync(path.join(dir, 'review-notes.txt'), 'utf8');
  const pasted = notes.replace(KEY_PLACEHOLDER, SAMPLE_KEY).trimEnd();
  const length = measure(pasted, 'bytes');
  results.push({
    field: 'review-notes', length, max: 4000, unit: 'bytes',
    ok: length <= 4000 && notes.includes(KEY_PLACEHOLDER)
  });
  const dashes = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(md|txt)$/.test(name)) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (/[\u2013\u2014]/.test(text)) dashes.push(name);
  }
  results.push({ field: 'no em or en dashes', length: dashes.length, max: 0, unit: 'files', ok: dashes.length === 0, detail: dashes });
  return results;
}

module.exports = { checkAll, listingFields, measure, SAMPLE_KEY };

if (require.main === module) {
  const results = checkAll();
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.field.padEnd(20)} ${String(r.length).padStart(5)} / ${r.max} ${r.unit}${r.detail && r.detail.length ? '  ' + r.detail.join(', ') : ''}`);
  }
  const need = ['name', 'subtitle', 'promotional', 'keywords', 'description'];
  const missing = need.filter(n => !results.some(r => r.field === n));
  if (missing.length) console.log(`FAIL  missing fields: ${missing.join(', ')}`);
  process.exit(results.every(r => r.ok) && !missing.length ? 0 : 1);
}
