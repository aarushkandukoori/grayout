#!/usr/bin/env node
// Check that every page of the site lets the browser talk to the API.
//
//   node scripts/check-csp.js <docs folder> <API address>
//   node scripts/check-csp.js ../docs https://grayout-api.example.workers.dev
//
// Each page has a Content-Security-Policy line whose `connect-src` lists the
// addresses the page may call. If the API address is not on that list, the
// browser blocks the call: success.html could never show a buyer their key,
// and nothing tells you. deploy.sh runs this after filling in the address and
// stops the deploy if any page would block it.
//
// Only pages that load config.js or app.js are checked: the others never
// call the API.
//
// A page passes when its connect-src has the exact origin, or a wildcard that
// covers it (https://*.workers.dev covers https://grayout-api.x.workers.dev).
// A page fails if it still names the unowned api.grayout.app, or still has
// the unfilled __GRAYOUT_API_BASE__ placeholder.
//
// Exit code 0: every page is fine. 1: at least one page would block the API.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The connect-src sources in one HTML page, or null if it has no CSP. */
export function connectSources(html) {
  const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html);
  if (!meta) return null;
  // The value is in double quotes and holds single-quoted words ('self'), so
  // match up to the same quote that opened it.
  const content = /content=(["'])(.*?)\1/i.exec(meta[0]);
  if (!content) return null;
  const directive = content[2].split(';').map(d => d.trim()).find(d => d.startsWith('connect-src'));
  return directive ? directive.split(/\s+/).slice(1) : [];
}

/** True when one CSP source allows the API origin. */
function allows(source, apiOrigin) {
  if (source === apiOrigin) return true;
  // "https://*.workers.dev" allows any https host ending in ".workers.dev".
  const wildcard = /^(https?):\/\/\*\.(.+)$/.exec(source);
  if (!wildcard) return false;
  const api = new URL(apiOrigin);
  return api.protocol === `${wildcard[1]}:` && api.hostname.endsWith(`.${wildcard[2]}`);
}

/** A list of problems ("page.html: why"), empty when every page is fine. */
export function cspProblems(docsDir, apiBase) {
  const apiOrigin = new URL(apiBase).origin;
  const problems = [];
  let pagesWithCsp = 0;
  for (const name of readdirSync(docsDir).filter(f => f.endsWith('.html')).sort()) {
    const html = readFileSync(join(docsDir, name), 'utf8');
    // Only pages that load the site's API code (config.js / app.js) call the
    // API. A page that only redirects (install.html) needs no connect-src.
    if (!/src=["'][^"']*\b(config|app)\.js["']/.test(html)) continue;
    const sources = connectSources(html);
    if (sources === null) continue; // a page with no CSP blocks nothing
    pagesWithCsp += 1;
    if (sources.some(s => s.includes('__GRAYOUT_API_BASE__'))) {
      problems.push(`${name}: connect-src still has the __GRAYOUT_API_BASE__ placeholder`);
    } else if (sources.some(s => s.includes('grayout.app'))) {
      problems.push(`${name}: connect-src names grayout.app, which this project does not own`);
    } else if (!sources.some(s => allows(s, apiOrigin))) {
      problems.push(`${name}: connect-src does not allow ${apiOrigin}`);
    }
  }
  if (!pagesWithCsp) problems.push('no page that calls the API has a Content-Security-Policy line');
  return problems;
}

// Run as a script (not when a test imports it).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [docsDir, apiBase] = process.argv.slice(2);
  if (!docsDir || !apiBase) {
    console.error('usage: node scripts/check-csp.js <docs folder> <API address>');
    process.exit(2);
  }
  const problems = cspProblems(docsDir, apiBase);
  for (const p of problems) console.error(`    CSP problem: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
