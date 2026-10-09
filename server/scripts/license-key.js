#!/usr/bin/env node
// Print the license key for a Stripe customer, so a buyer who lost it can be
// sent it again. Keys are never stored (only their hash is), but they can be
// derived again from LICENSE_SECRET and the customer id.
//
// Usage, run by the owner on their own machine:
//   LICENSE_SECRET=… node server/scripts/license-key.js cus_123          (live key)
//   LICENSE_SECRET=… node server/scripts/license-key.js cus_123 --test   (sandbox key)
//
// Whether the customer is live or test is the `livemode` column of their row:
//   npx wrangler d1 execute grayout --remote --command "SELECT livemode, generation FROM licenses WHERE customer_id = 'cus_123'"
// If generation is not 1, pass --generation=N.
//
// The key is a credential. Send it to the buyer and nowhere else.

import { licenseKeyFor } from '../src/ids.js';

const args = process.argv.slice(2);
const customerId = args.find(a => !a.startsWith('--'));
const test = args.includes('--test');
const generationArg = args.find(a => a.startsWith('--generation='));
const generation = generationArg ? Number(generationArg.split('=')[1]) : 1;
const secret = process.env.LICENSE_SECRET || '';

if (!customerId || !/^cus_[A-Za-z0-9]+$/.test(customerId)) {
  console.error('Usage: LICENSE_SECRET=… node server/scripts/license-key.js cus_… [--test] [--generation=N]');
  process.exit(1);
}
if (secret.length < 32) {
  console.error('Set LICENSE_SECRET to the same value the Worker uses (at least 32 characters).');
  process.exit(1);
}
if (!Number.isInteger(generation) || generation < 1) {
  console.error('--generation must be a whole number, 1 or more.');
  process.exit(1);
}

console.log(await licenseKeyFor(secret, customerId, generation, !test));
