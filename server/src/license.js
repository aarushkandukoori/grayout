// License keys: generation, shape, constant-time comparison, masking.
//
// A key is `gry_live_` + 24 characters of Crockford base32 (uppercase, no
// I/L/O/U), which is 120 bits of entropy. Crockford is chosen because a person
// may have to read one off a screen and type it into the app: the ambiguous
// letters are gone, and the ones people still get wrong (I and L for 1, O for
// zero) are folded back in by `normalizeLicense`.
//
// Nothing in this file logs a key. `maskLicense` exists so that logging a key
// is never the convenient option.

export const PREFIX = 'gry_live_';
export const BODY_LENGTH = 24;
export const DEVICE_CODE_LENGTH = 8;

// Crockford base32: the digits, then the alphabet without I, L, O and U.
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// 256 is an exact multiple of 32, so masking a random byte with 31 is uniform
// and needs no rejection sampling.
function randomSymbols(count) {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < count; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

/** A fresh license key. */
export function generateLicense() {
  return PREFIX + randomSymbols(BODY_LENGTH);
}

/**
 * A short code the app creates before it opens the browser, so checkout can
 * hand the license back without anyone copying anything. Shown as XXXX-XXXX.
 */
export function generateDeviceCode() {
  const body = randomSymbols(DEVICE_CODE_LENGTH);
  return `${body.slice(0, 4)}-${body.slice(4)}`;
}

function foldCrockford(text) {
  return text.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

/**
 * Put a pasted or typed key into canonical form: no spaces or dashes, the
 * prefix in lower case, the body upper case with the Crockford look-alikes
 * folded. Returns a string that may still be the wrong shape — check it with
 * `isLicenseShape`.
 */
export function normalizeLicense(input) {
  let s = String(input === null || input === undefined ? '' : input).trim().replace(/[\s\-‐-―]+/g, '');
  if (/^gry_live_/i.test(s)) s = s.slice(PREFIX.length);
  return PREFIX + foldCrockford(s);
}

/** Canonical form of a device code: no dashes, upper case, look-alikes folded. */
export function normalizeDeviceCode(input) {
  return foldCrockford(String(input === null || input === undefined ? '' : input).trim().replace(/[\s\-‐-―]+/g, ''));
}

const LICENSE_RE = new RegExp(`^${PREFIX}[${CROCKFORD}]{${BODY_LENGTH}}$`);
const DEVICE_CODE_RE = new RegExp(`^[${CROCKFORD}]{${DEVICE_CODE_LENGTH}}$`);

export function isLicenseShape(value) {
  return typeof value === 'string' && LICENSE_RE.test(value);
}

export function isDeviceCodeShape(value) {
  return typeof value === 'string' && DEVICE_CODE_RE.test(value);
}

const encoder = new TextEncoder();

/**
 * Compare two secrets without leaking, through timing, how much of the first
 * one a guess got right.
 *
 * Both inputs are compared over the same number of iterations whatever their
 * lengths, and the length difference is folded into the same accumulator, so
 * the only thing the running time depends on is how long the inputs are —
 * which an attacker already knows, because the shape is public.
 */
export function constantTimeEqual(a, b) {
  // Two absent secrets are not a match. Refusing them here leaks nothing about
  // either value, and it stops a pair of nulls from comparing equal.
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || !b.length) return false;
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const width = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let i = 0; i < width; i++) {
    // Reading modulo the length keeps every iteration a real comparison even
    // when the two inputs are different sizes.
    const l = left.length ? left[i % left.length] : 0;
    const r = right.length ? right[i % right.length] : 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

/** `gry_live_…CB6D` — safe to put in a log line or an error message. */
export function maskLicense(value) {
  const s = String(value === null || value === undefined ? '' : value);
  if (!s) return '';
  const body = s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
  if (body.length <= 4) return `${PREFIX}…${body}`;
  return `${PREFIX}…${body.slice(-4)}`;
}
