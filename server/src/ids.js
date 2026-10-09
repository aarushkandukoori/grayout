// Identifiers and the cryptography behind them: device ids and tokens, license
// keys, device codes, hashes, and a constant-time comparison.
//
// Everything here uses Web Crypto (`crypto.subtle`), which Workers and Node
// both have, so scripts/license-key.js can derive keys with this same code.
//
// Crockford base32 is used for anything a person may read or type: no I, L, O
// or U, and the look-alikes people still type (I and L for 1, O for 0) are
// folded back in when a key or code is read.

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const DEVICE_ID_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
export const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const LICENSE_RE = /^gry_(live|test)_[0-9A-HJKMNP-TV-Z]{24}$/;
export const DEVICE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;

const encoder = new TextEncoder();

// 256 is a multiple of 32, so keeping the low 5 bits of a random byte gives
// every symbol exactly the same chance.
function randomSymbols(count) {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/** A new device id: "dev_" + 26 symbols, 130 random bits. */
export function newDeviceId() {
  return 'dev_' + randomSymbols(26);
}

/** A new device code, 8 symbols, stored without the dash. */
export function newDeviceCode() {
  return randomSymbols(8);
}

/** "7KQ2R9XW" → "7KQ2-R9XW", the way a person sees it. */
export function formatDeviceCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function foldCrockford(text) {
  return text.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

// Spaces and every kind of dash a keyboard or a copy-paste can produce.
const SEPARATORS = /[\s\-‐-―]+/g;

/** A typed device code in stored form, or '' when it is not one. */
export function normalizeDeviceCode(input) {
  if (typeof input !== 'string') return '';
  const code = foldCrockford(input.trim().replace(SEPARATORS, ''));
  return DEVICE_CODE_RE.test(code) ? code : '';
}

/** A pasted license key in canonical form, or '' when it is not one. */
export function normalizeLicense(input) {
  if (typeof input !== 'string') return '';
  const s = input.trim().replace(SEPARATORS, '');
  const match = /^gry_(live|test)_(.*)$/i.exec(s);
  if (!match) return '';
  const key = `gry_${match[1].toLowerCase()}_${foldCrockford(match[2])}`;
  return LICENSE_RE.test(key) ? key : '';
}

// ---------------------------------------------------------------- HMAC and hashes

// Importing a key is slow-ish, and the same two secrets are used on every
// request, so each imported key is kept for the life of the isolate.
const keyCache = new Map();

async function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  return key;
}

/** HMAC-SHA256(secret, message) as bytes. */
export async function hmac(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes written as Crockford base32, 5 bits per symbol, most significant first. */
function toCrockford(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** Lowercase hex SHA-256 of a string. How a license key is looked up. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(new Uint8Array(digest));
}

/**
 * The token that proves a device id was minted here. It is never stored: the
 * server recomputes it and compares.
 */
export async function deviceTokenFor(deviceSecret, deviceId) {
  return toBase64Url(await hmac(deviceSecret, deviceId));
}

/**
 * Lowercase hex HMAC-SHA256(secret, text). For values the database must be
 * able to match but never hold (an email, a card fingerprint).
 */
export async function keyedHash(secret, text) {
  return toHex(await hmac(secret, text));
}

/** A keyed hash of the caller's network, so the database never holds an IP. */
export async function ipHashFor(deviceSecret, ipKey) {
  return toHex(await hmac(deviceSecret, ipKey)).slice(0, 32);
}

/**
 * The license key for a Stripe customer. Derived, not random, so two webhook
 * deliveries racing each other always produce the same key, and so the key
 * never has to be stored.
 */
export async function licenseKeyFor(licenseSecret, customerId, generation = 1, livemode = true) {
  const mac = await hmac(licenseSecret, `grayout-license:v1:${customerId}:${generation}`);
  // The first 15 bytes are 120 bits, exactly 24 base32 symbols.
  return `gry_${livemode ? 'live' : 'test'}_${toCrockford(mac.slice(0, 15))}`;
}

/**
 * Compare two secrets in time that does not depend on where they differ, so a
 * guesser learns nothing from how long a refusal took.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || !b.length) return false;
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const width = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < width; i++) {
    diff |= (left[i % left.length]) ^ (right[i % right.length]);
  }
  return diff === 0;
}

/** "cs_test_…a1B2": the only form of a session id that may go in a log. */
export function maskSessionId(id) {
  const s = String(id || '');
  return s.length > 4 ? `…${s.slice(-4)}` : '…';
}
