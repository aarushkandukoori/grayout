'use strict';
// Startup must never wait unbounded on the Screen Recording probe: until the
// macOS prompt is answered (or forever, while the screen is locked) the probe
// does not settle, and onboarding and the dashboard open after it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('the launch-time screen permission probe is raced against a timeout', () => {
  assert.match(MAIN, /await Promise\.race\(\[permissions\.primeScreenPermission\(\), new Promise\(r => setTimeout\(r, PRIME_WAIT_MS\)/);
  assert.doesNotMatch(MAIN, /await permissions\.primeScreenPermission\(\)/);
  const ms = Number((MAIN.match(/const PRIME_WAIT_MS = (\d+)/) || [])[1]);
  assert.ok(ms > 0 && ms <= 15000, `PRIME_WAIT_MS should be a short wait, got ${ms}`);
});
