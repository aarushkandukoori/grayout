#!/usr/bin/env node
// Check one Stripe CLI answer (JSON on stdin) for set-secrets.sh.
//
//   stripe webhook_endpoints list …   | node scripts/stripe-answer.js has-url <url>
//       prints "yes" when an endpoint with exactly that URL exists, else "no"
//   stripe webhook_endpoints create … | node scripts/stripe-answer.js secret
//       prints the new endpoint's whsec_ signing secret and nothing else
//
// The Stripe CLI prints an API error as JSON and still exits 0 (seen with an
// expired login: {"error":{"message":"Permission denied","code":"unauthorized"}}),
// so its exit code proves nothing. Every answer is checked here instead.
// On a problem this prints a short reason to stderr (Stripe's own error
// message at most, never the answer itself, which can hold a secret) and
// exits 1, so the script stores nothing.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webhookSecretOk } from '../src/config.js';

/**
 * Read the CLI's output: { ok: true, body } or { ok: false, reason }.
 * Anything printed before the JSON (a notice from the CLI) is skipped.
 */
export function readAnswer(text) {
  const start = String(text || '').indexOf('{');
  if (start < 0) return { ok: false, reason: 'the Stripe CLI printed no JSON answer' };
  let body;
  try {
    body = JSON.parse(text.slice(start));
  } catch {
    return { ok: false, reason: 'the Stripe CLI answer was not valid JSON' };
  }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'the Stripe CLI answer was empty' };
  if (body.error) {
    const message = typeof body.error.message === 'string' ? body.error.message.slice(0, 200) : 'no message';
    return { ok: false, reason: `Stripe refused: ${message}` };
  }
  return { ok: true, body };
}

/** True when a webhook_endpoints list holds an endpoint with exactly this URL. */
export function hasUrl(body, url) {
  return Array.isArray(body.data) && body.data.some(endpoint => endpoint && endpoint.url === url);
}

/** The whsec_ secret of a newly created endpoint, or null if it is missing or malformed. */
export function webhookSecret(body) {
  return webhookSecretOk(body.secret) ? body.secret : null;
}

function stop(reason) {
  console.error(`    ${reason}`);
  process.exit(1);
}

// Run as a script (not when a test imports it).
// realpath: on macOS the temp folder /var is a link to /private/var, and
// import.meta.url always names the real path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const [mode, url] = process.argv.slice(2);
  if (!(mode === 'secret' || (mode === 'has-url' && url))) {
    console.error('usage: node scripts/stripe-answer.js has-url <url> | secret   (the answer on stdin)');
    process.exit(2);
  }
  let text = '';
  process.stdin.on('data', chunk => { text += chunk; }).on('end', () => {
    const answer = readAnswer(text);
    if (!answer.ok) stop(answer.reason);
    if (mode === 'has-url') {
      if (!Array.isArray(answer.body.data)) stop('the Stripe CLI answer had no list of webhook endpoints');
      console.log(hasUrl(answer.body, url) ? 'yes' : 'no');
      return;
    }
    const secret = webhookSecret(answer.body);
    if (!secret) stop('Stripe made the webhook but its answer had no valid whsec_ signing secret');
    process.stdout.write(secret);
  });
}
