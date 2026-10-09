'use strict';
// Small app-side checks from the 2026-10-08 cross-team integration pass
// (docs/API-CONTRACT.md v3). The end-to-end version, with the real Worker in
// the same process, is server/test/clients.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

const dir = helpers.freshUserData('contract-clients');
after(() => helpers.cleanup(dir));

const { alreadySubscribedMessage, errorFromBody, MESSAGES } = require('../src/account');
const { fitSize, MAX_WIDTH, MAX_HEIGHT } = require('../src/capture');

describe('409 already_subscribed shows what the service said (contract 6.5)', () => {
  test('a payment that needs fixing is named, and the person hears nothing new was charged', () => {
    const msg = alreadySubscribedMessage('This Grayout subscription is waiting on a payment. Fix it in Manage billing or at link.com instead of buying again.');
    assert.equal(msg, 'This Grayout subscription is waiting on a payment. Fix it in Manage billing or at link.com instead of buying again. Nothing new was charged.');
  });

  test('a payment still processing is named too', () => {
    assert.match(alreadySubscribedMessage('A Grayout payment from this device is still being processed. Wait for it to finish before buying again.'), /still being processed/);
  });

  test('no sentence from the service: our own', () => {
    assert.equal(alreadySubscribedMessage(''), MESSAGES.alreadySubscribed);
    assert.equal(alreadySubscribedMessage(undefined), MESSAGES.alreadySubscribed);
    // errorFromBody fills this in when the body had no message.
    const fallback = errorFromBody({ error: { code: 'already_subscribed' } }, 409).message;
    assert.equal(alreadySubscribedMessage(fallback), MESSAGES.alreadySubscribed);
  });

  test('a sentence that says "subscribe" is never shown to a subscriber (contract 16.1)', () => {
    assert.equal(alreadySubscribedMessage('Subscribe again to continue.'), MESSAGES.alreadySubscribed);
    // "subscription" is fine; only the verb is banned.
    assert.match(alreadySubscribedMessage('You already have a Grayout subscription.'), /subscription\. Nothing new was charged\.$/);
  });
});

describe('screenshots fit the service limits (contract 6.11 step 1)', () => {
  test('limits match the service: 1366 wide, 2732 tall', () => {
    assert.equal(MAX_WIDTH, 1366);
    assert.equal(MAX_HEIGHT, 2732);
  });

  test('small captures are left alone; wide ones shrink to 1366; very tall ones shrink by height', () => {
    assert.equal(fitSize(1366, 768), null);
    assert.equal(fitSize(1280, 2732), null);
    assert.deepEqual(fitSize(2732, 1536), { width: 1366, height: 768 });
    assert.deepEqual(fitSize(1200, 3600), { width: 911, height: 2732 });
    assert.equal(fitSize(0, 100), null, 'an empty image is not resized');
  });

  test('never a pixel over either limit, whatever the shape', () => {
    for (let w = 100; w <= 8000; w += 37) {
      for (const h of [w / 4, w / 2, w, w * 2, w * 3 + 1]) {
        const fit = fitSize(w, Math.round(h));
        const out = fit || { width: w, height: Math.round(h) };
        assert.ok(out.width <= MAX_WIDTH && out.height <= MAX_HEIGHT, `${w}x${Math.round(h)}`);
      }
    }
  });
});
