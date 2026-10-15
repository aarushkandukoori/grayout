#!/usr/bin/env node
// Print one plain setting (a `vars` entry) of one Worker from wrangler.jsonc.
//
//   node scripts/wrangler-var.js live SUPPORT_EMAIL
//   node scripts/wrangler-var.js sandbox SUPPORT_EMAIL [path/to/wrangler.jsonc]
//
// The live Worker's settings are the top-level "vars"; the sandbox Worker's
// are "env.sandbox.vars" (wrangler does not copy vars into an environment).
// Prints the value, or an empty line when it is missing or empty. deploy.sh
// uses this so that one Worker's setting is never mistaken for the other's
// (a grep over the whole file could not tell them apart).
//
// Exit code 0: printed (maybe empty). 2: bad arguments or unreadable file.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Parse wrangler.jsonc: JSON with // comments (but "https://" inside strings is kept). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i]; continue; }
      if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The vars of the live or the sandbox Worker ({} when there are none). */
export function workerVars(config, target) {
  if (target === 'live') return config.vars || {};
  if (target === 'sandbox') return (config.env && config.env.sandbox && config.env.sandbox.vars) || {};
  throw new Error(`unknown Worker "${target}": say live or sandbox`);
}

// Run as a script (not when a test imports it).
// realpath: on macOS the temp folder /var is a link to /private/var, and
// import.meta.url always names the real path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const [target, name, file] = process.argv.slice(2);
  if (!['live', 'sandbox'].includes(target) || !name) {
    console.error('usage: node scripts/wrangler-var.js live|sandbox <NAME> [wrangler.jsonc]');
    process.exit(2);
  }
  const path = file || join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');
  let vars;
  try {
    vars = workerVars(parseJsonc(readFileSync(path, 'utf8')), target);
  } catch (err) {
    console.error(`Could not read ${path}: ${err.message}`);
    process.exit(2);
  }
  const value = vars[name];
  console.log(value === undefined || value === null ? '' : String(value));
}
