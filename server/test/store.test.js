import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_TTL_SECONDS, keys, kvStore, memoryStore } from '../src/store.js';
import { clock } from './helpers.js';

/** The smallest thing that behaves like a KV namespace binding. */
function fakeKv() {
  const map = new Map();
  const puts = [];
  return {
    map,
    puts,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value, options) { puts.push({ key, value, options }); map.set(key, value); },
    async delete(key) { map.delete(key); }
  };
}

describe('kvStore', () => {
  test('round-trips objects and numbers as JSON', async () => {
    const kv = fakeKv();
    const store = kvStore(kv);
    await store.put('a', { plan: 'monthly', n: 3 });
    await store.put('b', 7);
    assert.deepEqual(await store.get('a'), { plan: 'monthly', n: 3 });
    assert.equal(await store.get('b'), 7);
    assert.equal(kv.map.get('b'), '7', 'values are stored as JSON text');
  });

  test('a missing key reads as null', async () => {
    assert.equal(await kvStore(fakeKv()).get('nope'), null);
  });

  test('a value that is not JSON reads as null instead of throwing', async () => {
    const kv = fakeKv();
    kv.map.set('junk', 'not json {');
    assert.equal(await kvStore(kv).get('junk'), null);
  });

  test('delete removes the key', async () => {
    const kv = fakeKv();
    const store = kvStore(kv);
    await store.put('a', 1);
    await store.delete('a');
    assert.equal(await store.get('a'), null);
  });

  test('incr starts at zero and accumulates', async () => {
    const store = kvStore(fakeKv());
    assert.equal(await store.incr('c'), 1);
    assert.equal(await store.incr('c'), 2);
    assert.equal(await store.incr('c', 5), 7);
  });

  test('incr treats a non-numeric value as zero', async () => {
    const kv = fakeKv();
    kv.map.set('c', '"twelve"');
    assert.equal(await kvStore(kv).incr('c'), 1);
  });

  test('a TTL below the KV floor is raised, not sent through', async () => {
    const kv = fakeKv();
    const store = kvStore(kv);
    await store.put('a', 1, { expirationTtl: 5 });
    await store.incr('b', 1, { expirationTtl: 5 });
    assert.equal(kv.puts[0].options.expirationTtl, MIN_TTL_SECONDS);
    assert.equal(kv.puts[1].options.expirationTtl, MIN_TTL_SECONDS);
  });

  test('a TTL above the floor is passed through, rounded up', async () => {
    const kv = fakeKv();
    await kvStore(kv).put('a', 1, { expirationTtl: 900.2 });
    assert.equal(kv.puts[0].options.expirationTtl, 901);
  });

  test('no TTL means no expiration option', async () => {
    const kv = fakeKv();
    await kvStore(kv).put('a', 1);
    assert.equal(kv.puts[0].options, undefined);
  });

  test('refuses to be built without a binding', () => {
    assert.throws(() => kvStore(undefined), /KV namespace binding/);
  });
});

describe('memoryStore', () => {
  test('has the same surface as kvStore', async () => {
    const store = memoryStore();
    await store.put('a', { x: 1 });
    assert.deepEqual(await store.get('a'), { x: 1 });
    assert.equal(await store.incr('n', 2), 2);
    await store.delete('a');
    assert.equal(await store.get('a'), null);
  });

  test('honors a TTL against a clock the test moves', async () => {
    const c = clock();
    const store = memoryStore({ now: c.now });
    await store.put('code:ABCD', { deviceId: 'd' }, { expirationTtl: 900 });
    c.advance(899 * 1000);
    assert.deepEqual(await store.get('code:ABCD'), { deviceId: 'd' });
    c.advance(2 * 1000);
    assert.equal(await store.get('code:ABCD'), null, 'the claim code should have expired');
  });
});

describe('key names', () => {
  test('match the table in the contract', () => {
    assert.equal(keys.license('gry_live_X'), 'lic:gry_live_X');
    assert.equal(keys.device('dev1'), 'dev:dev1');
    assert.equal(keys.code('ABCDEFGH'), 'code:ABCDEFGH');
    assert.equal(keys.usage('gry_live_X', '2026-09'), 'use:gry_live_X:2026-09');
    assert.equal(keys.customer('cus_1'), 'cus:cus_1');
  });
});
