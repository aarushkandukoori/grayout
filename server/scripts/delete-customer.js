#!/usr/bin/env node
// Delete everything this service stores about one Stripe customer, for a
// data deletion request (Stripe emails the owner about those). Contract 14.6.
//
// Usage, run by the owner on their own machine:
//   node server/scripts/delete-customer.js cus_123             (live database)
//   node server/scripts/delete-customer.js cus_123 --sandbox   (sandbox database)
// It prints ONE wrangler command. Read it, then paste it into the terminal.
// The script itself changes nothing.
//
// What the command does, in an order where no step ever breaks a foreign key
// (D1 enforces them, so a DELETE of a license that a row still points at fails):
//   1. devices that USE the license:           license_id        -> NULL
//   2. devices that BOUGHT it:                 bought_license_id -> NULL
//   3. checkout sessions that issued it:       license_id        -> NULL
//   4. its monthly check counts:               deleted
//   5. its trial marks (hashes of email/card): deleted
//   6. the license row itself:                 deleted
// Steps 1 to 5 only clear what points at the license, so if the command stops
// half-way, running it again finishes the job.
//
// test/third-pass.test.js runs this SQL against the real schema after a
// purchase, and checks that every column that points at `licenses` (or holds
// a customer id) is covered here, so a later schema change cannot break it
// without a failing test.

import { pathToFileURL } from 'node:url';

/** A Stripe customer id. Nothing else (no quote, no space) can get into the SQL. */
export const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]{1,64}$/;

/**
 * The SQL statements for one customer, in order. The customer id is checked
 * against CUSTOMER_ID_RE first, because `wrangler d1 execute --command` cannot
 * bind values: the id has to be written into the SQL text.
 */
export function deleteCustomerStatements(customerId) {
  if (typeof customerId !== 'string' || !CUSTOMER_ID_RE.test(customerId)) {
    throw new Error('That is not a Stripe customer id (cus_ followed by letters and digits).');
  }
  const license = `(SELECT id FROM licenses WHERE customer_id = '${customerId}')`;
  return [
    `UPDATE devices SET license_id = NULL WHERE license_id IN ${license}`,
    `UPDATE devices SET bought_license_id = NULL WHERE bought_license_id IN ${license}`,
    `UPDATE checkout_sessions SET license_id = NULL WHERE license_id IN ${license}`,
    `DELETE FROM usage WHERE license_id IN ${license}`,
    `DELETE FROM trial_marks WHERE customer_id = '${customerId}'`,
    `DELETE FROM licenses WHERE customer_id = '${customerId}'`
  ];
}

/** The same statements as one string, ready for --command. */
export function deleteCustomerSql(customerId) {
  return deleteCustomerStatements(customerId).join('; ') + ';';
}

/** The full wrangler command line the owner runs. */
export function deleteCustomerCommand(customerId, { sandbox = false } = {}) {
  const target = sandbox ? 'grayout-sandbox --remote --env sandbox' : 'grayout --remote';
  return `npx wrangler d1 execute ${target} --command "${deleteCustomerSql(customerId)}"`;
}

// Run from the command line (not when a test imports this file).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const customerId = args.find(a => !a.startsWith('--'));
  try {
    console.log(deleteCustomerCommand(customerId, { sandbox: args.includes('--sandbox') }));
  } catch (err) {
    console.error(err.message);
    console.error('Usage: node server/scripts/delete-customer.js cus_… [--sandbox]');
    process.exit(1);
  }
}
