'use strict';
// The Grayout license key and this Mac's device token — plus, for
// self-hosters, a model API key and an optional Canvas token — live in
// secrets.bin, encrypted with Electron's safeStorage (macOS Keychain-backed,
// item "Grayout Safe Storage").
// There is deliberately NO plaintext fallback: if encryption is unavailable a
// credential can only be held in memory for this session.
const fs = require('fs');
const paths = require('./paths');
const log = require('./log');
const channel = require('./channel');

let safeStorage = null;
if (paths.IN_ELECTRON) {
  try { ({ safeStorage } = require('electron')); } catch { safeStorage = null; }
}

class SecretsUnavailable extends Error {
  constructor(msg) { super(msg || 'secure storage is not available on this Mac'); this.name = 'SecretsUnavailable'; }
}

// A model API key in a build without self-hosting (the Mac App Store edition).
class SelfHostingUnavailable extends Error {
  constructor() { super('your own API key is not available in the Mac App Store edition'); this.name = 'SelfHostingUnavailable'; this.kind = 'unavailable'; }
}
const selfHosting = () => channel.features().selfHosting;

let cache = null;          // { anthropicApiKey, canvasToken, grayoutLicense, grayoutDeviceToken } once decrypted
let sessionKey = null;     // in-memory only, when secure storage is unavailable
let sessionLicense = null; // ditto, for the license key
let sessionDeviceToken = null; // ditto, for the device token
let loadFailed = false;
// True while secrets.bin exists but could not be decrypted (the macOS
// Keychain refused, or its key is gone). Different from "no secrets.bin":
// the file may still hold this Mac's license and device token, so nothing
// may quietly write an empty store over it.
let unreadable = false;

const EMPTY = { anthropicApiKey: '', canvasToken: '', grayoutLicense: '', grayoutDeviceToken: '' };

// gry_live_ (real money) or gry_test_ (a Stripe sandbox purchase) + 24
// Crockford base32 characters (uppercase, no I/L/O/U). docs/API-CONTRACT.md 4.2.
const LICENSE_RE = /^gry_(live|test)_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/;
const LICENSE_PREFIX = 'gry_live_';
const LICENSE_PREFIX_RE = /^gry_(live|test)_/i;

// The device token the service minted for this Mac: base64url of an
// HMAC-SHA256, 43 characters (docs/API-CONTRACT.md 4.1).
const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function _setSafeStorage(fake) { safeStorage = fake; cache = null; loadFailed = false; unreadable = false; }

/**
 * Drop every credential held in memory (the decrypted store and the session
 * fallbacks). "Erase this Mac's Grayout data" calls it right after deleting
 * secrets.bin, so nothing in this process can write the old keys back.
 */
function forget() {
  cache = null;
  sessionKey = null;
  sessionLicense = null;
  sessionDeviceToken = null;
  loadFailed = false;
  unreadable = false;
}

function available() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function load() {
  if (cache) return cache;
  if (!available()) { cache = null; return { ...EMPTY }; }
  let buf;
  try { buf = fs.readFileSync(paths.SECRETS_PATH); } catch { cache = { ...EMPTY }; return cache; }
  try {
    const parsed = JSON.parse(safeStorage.decryptString(buf));
    cache = {
      anthropicApiKey: typeof parsed.anthropicApiKey === 'string' ? parsed.anthropicApiKey : '',
      canvasToken: typeof parsed.canvasToken === 'string' ? parsed.canvasToken : '',
      grayoutLicense: typeof parsed.grayoutLicense === 'string' ? parsed.grayoutLicense : '',
      grayoutDeviceToken: typeof parsed.grayoutDeviceToken === 'string' ? parsed.grayoutDeviceToken : ''
    };
  } catch (e) {
    if (!loadFailed) log.warn('secrets', `could not decrypt secrets.bin: ${e.message}`);
    loadFailed = true;
    unreadable = true;
    cache = { ...EMPTY };
  }
  return cache;
}

/** True when secrets.bin exists but this session could not unlock it. */
function isUnreadable() {
  load();
  return unreadable;
}

/**
 * Put an unreadable secrets.bin aside as secrets.bin.unreadable, so the next
 * write starts a fresh store instead of destroying the old one. If the
 * Keychain comes back, renaming the file back recovers everything in it.
 */
function setAsideUnreadable() {
  if (!unreadable) return;
  try { fs.renameSync(paths.SECRETS_PATH, paths.SECRETS_PATH + '.unreadable'); } catch {}
  log.warn('secrets', 'secrets.bin could not be unlocked; kept it as secrets.bin.unreadable and started a new one');
  unreadable = false;
  cache = { ...EMPTY };
}

function persist(next) {
  if (!available()) throw new SecretsUnavailable();
  // Writing now would replace a store we could not read with one that lacks
  // its license and device token. Keep the old file instead of losing it.
  setAsideUnreadable();
  const enc = safeStorage.encryptString(JSON.stringify(next));
  const tmp = paths.SECRETS_PATH + '.tmp';
  fs.writeFileSync(tmp, enc, { mode: 0o600 });
  fs.renameSync(tmp, paths.SECRETS_PATH);
  try { fs.chmodSync(paths.SECRETS_PATH, 0o600); } catch {}
  cache = next;
}

function normalizeKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.length > 400 || /\s/.test(k)) throw new Error('that does not look like an API key');
  return k;
}

// Without self-hosting there is no model key at all: not a stored one, not a
// session one, not one from the environment.
function getApiKey() {
  if (!selfHosting()) return null;
  if (sessionKey) return sessionKey;
  // A developer running from source may use the environment; a packaged app never does.
  if (!isPackaged()) {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  }
  return load().anthropicApiKey || null;
}

function setApiKey(key) {
  if (!selfHosting()) throw new SelfHostingUnavailable();
  const k = normalizeKey(key);
  persist({ ...load(), anthropicApiKey: k });
  sessionKey = null;
}

function clearApiKey() {
  sessionKey = null;
  // Nothing to clear in a store we cannot read, and writing would replace it.
  if (!available() || isUnreadable()) return;
  try { persist({ ...load(), anthropicApiKey: '' }); } catch {}
}

function useSessionKey(key) {
  if (!selfHosting()) throw new SelfHostingUnavailable();
  sessionKey = normalizeKey(key) || null;
}

/* ---------------- Grayout license ----------------
   The subscription credential. It is not a model key: it identifies a
   subscription to the Grayout service, which holds the model key itself. */

function normalizeLicense(license) {
  let raw = String(license || '').trim();
  if (!raw) return '';
  // Forgiving in the same way the service is, so the app never refuses a key
  // the service would have accepted. Dashes and spaces come from a key that
  // was wrapped in an email or read aloud; I, L and O are not in Crockford
  // base32, so anyone typing them meant 1, 1 and 0 — fold them rather than
  // reject the key. U stays invalid.
  raw = raw.replace(/[\s\-\u2010-\u2015]+/g, '');
  // The prefix says live or test (a Stripe sandbox purchase) and is kept as
  // given. A bare 24-character body is assumed to be a live key.
  const m = LICENSE_PREFIX_RE.exec(raw);
  const prefix = m ? `gry_${m[1].toLowerCase()}_` : LICENSE_PREFIX;
  const body = (m ? raw.slice(m[0].length) : raw)
    .toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  const k = prefix + body;
  if (!LICENSE_RE.test(k)) throw new Error('that does not look like a Grayout license key');
  return k;
}

function getLicense() {
  if (sessionLicense) return sessionLicense;
  // A developer running from source may point the app at a test license; a
  // packaged app never reads the environment.
  if (!isPackaged() && process.env.GRAYOUT_LICENSE) return process.env.GRAYOUT_LICENSE;
  return load().grayoutLicense || null;
}

function setLicense(license) {
  const k = normalizeLicense(license);
  persist({ ...load(), grayoutLicense: k });
  sessionLicense = null;
}

function clearLicense() {
  sessionLicense = null;
  // Nothing to clear in a store we cannot read, and writing would replace it.
  if (!available() || isUnreadable()) return;
  try { persist({ ...load(), grayoutLicense: '' }); } catch {}
}

function useSessionLicense(license) { sessionLicense = normalizeLicense(license) || null; }

/** gry_live_…CB6D — enough to recognize a key, never enough to use one. */
function maskLicense(license) {
  if (!license) return '';
  const k = String(license);
  // Both prefixes (gry_live_, gry_test_) are 9 characters long.
  const prefix = LICENSE_PREFIX_RE.test(k) ? k.slice(0, LICENSE_PREFIX.length) : LICENSE_PREFIX;
  return k.length <= LICENSE_PREFIX.length + 4 ? `${prefix}…` : `${prefix}…${k.slice(-4)}`;
}

/* ---------------- Device token ----------------
   The service mints this Mac an identity: a deviceId (kept in state.json, it
   is not secret) and a deviceToken (kept here). The token can get a lost
   license key back from the service, so it gets the same protection as the
   license itself. */

function normalizeDeviceToken(token) {
  const t = String(token || '').trim();
  if (!DEVICE_TOKEN_RE.test(t)) throw new Error('that does not look like a Grayout device token');
  return t;
}

function getDeviceToken() {
  if (sessionDeviceToken) return sessionDeviceToken;
  return load().grayoutDeviceToken || null;
}

/** Throws SecretsUnavailable without a keychain; the caller then uses useSessionDeviceToken. */
function setDeviceToken(token) {
  const t = normalizeDeviceToken(token);
  persist({ ...load(), grayoutDeviceToken: t });
  sessionDeviceToken = null;
}

function clearDeviceToken() {
  sessionDeviceToken = null;
  // Nothing to clear in a store we cannot read, and writing would replace it.
  if (!available() || isUnreadable()) return;
  try { persist({ ...load(), grayoutDeviceToken: '' }); } catch {}
}

function useSessionDeviceToken(token) { sessionDeviceToken = token ? normalizeDeviceToken(token) : null; }

function isLicense(license) {
  try { return !!normalizeLicense(license); } catch { return false; }
}

function getCanvasToken() { return load().canvasToken || ''; }
function setCanvasToken(t) { persist({ ...load(), canvasToken: String(t || '').trim() }); }

function isPackaged() {
  if (!paths.IN_ELECTRON) return false;
  try { return !!require('electron').app.isPackaged; } catch { return false; }
}

function maskKey(key) {
  if (!key) return '';
  const k = String(key);
  return k.length <= 12 ? 'sk-ant-…' : `${k.slice(0, 7)}…${k.slice(-4)}`;
}

module.exports = {
  available, unreadable: isUnreadable, setAsideUnreadable, getApiKey, setApiKey, clearApiKey, useSessionKey, getCanvasToken, setCanvasToken,
  getLicense, setLicense, clearLicense, useSessionLicense, normalizeLicense, maskLicense, isLicense,
  getDeviceToken, setDeviceToken, clearDeviceToken, useSessionDeviceToken,
  maskKey, forget, SecretsUnavailable, SelfHostingUnavailable, LICENSE_RE, DEVICE_TOKEN_RE, _setSafeStorage
};
