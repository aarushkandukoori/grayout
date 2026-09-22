'use strict';
// The Grayout license key — plus, for self-hosters, a model API key and an
// optional Canvas token — live in secrets.bin, encrypted with Electron's
// safeStorage (macOS Keychain-backed, item "Grayout Safe Storage").
// There is deliberately NO plaintext fallback: if encryption is unavailable a
// credential can only be held in memory for this session.
const fs = require('fs');
const paths = require('./paths');
const log = require('./log');

let safeStorage = null;
if (paths.IN_ELECTRON) {
  try { ({ safeStorage } = require('electron')); } catch { safeStorage = null; }
}

class SecretsUnavailable extends Error {
  constructor(msg) { super(msg || 'secure storage is not available on this Mac'); this.name = 'SecretsUnavailable'; }
}

let cache = null;          // { anthropicApiKey, canvasToken, grayoutLicense } once decrypted
let sessionKey = null;     // in-memory only, when secure storage is unavailable
let sessionLicense = null; // ditto, for the license key
let loadFailed = false;

const EMPTY = { anthropicApiKey: '', canvasToken: '', grayoutLicense: '' };

// gry_live_ + 24 Crockford base32 characters (uppercase, no I/L/O/U).
const LICENSE_RE = /^gry_live_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/;
const LICENSE_PREFIX = 'gry_live_';

function _setSafeStorage(fake) { safeStorage = fake; cache = null; loadFailed = false; }

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
      grayoutLicense: typeof parsed.grayoutLicense === 'string' ? parsed.grayoutLicense : ''
    };
  } catch (e) {
    if (!loadFailed) log.warn('secrets', `could not decrypt secrets.bin: ${e.message}`);
    loadFailed = true;
    cache = { ...EMPTY };
  }
  return cache;
}

function persist(next) {
  if (!available()) throw new SecretsUnavailable();
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

function getApiKey() {
  if (sessionKey) return sessionKey;
  // A developer running from source may use the environment; a packaged app never does.
  if (!isPackaged()) {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  }
  return load().anthropicApiKey || null;
}

function setApiKey(key) {
  const k = normalizeKey(key);
  persist({ ...load(), anthropicApiKey: k });
  sessionKey = null;
}

function clearApiKey() {
  sessionKey = null;
  if (!available()) return;
  try { persist({ ...load(), anthropicApiKey: '' }); } catch {}
}

function useSessionKey(key) { sessionKey = normalizeKey(key) || null; }

/* ---------------- Grayout license ----------------
   The v2 credential. It is not a model key: it identifies a subscription to
   the Grayout service, which holds the model key itself. */

function normalizeLicense(license) {
  let raw = String(license || '').trim();
  if (!raw) return '';
  // Exactly what the service does (server/src/license.js normalizeLicense), so
  // the app never refuses a key the service would have accepted. Dashes and
  // spaces come from a key that was wrapped in an email or read aloud; I, L, O
  // and U are not in Crockford base32, so anyone typing them meant 1, 1, 0 and
  // V-adjacent nonsense — fold the first three rather than reject the key.
  raw = raw.replace(/[\s\-\u2010-\u2015]+/g, '');
  const body = (/^gry_live_/i.test(raw) ? raw.slice(LICENSE_PREFIX.length) : raw)
    .toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  const k = LICENSE_PREFIX + body;
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
  if (!available()) return;
  try { persist({ ...load(), grayoutLicense: '' }); } catch {}
}

function useSessionLicense(license) { sessionLicense = normalizeLicense(license) || null; }

/** gry_live_…CB6D — enough to recognize a key, never enough to use one. */
function maskLicense(license) {
  if (!license) return '';
  const k = String(license);
  return k.length <= LICENSE_PREFIX.length + 4 ? `${LICENSE_PREFIX}…` : `${k.slice(0, LICENSE_PREFIX.length)}…${k.slice(-4)}`;
}

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
  available, getApiKey, setApiKey, clearApiKey, useSessionKey, getCanvasToken, setCanvasToken,
  getLicense, setLicense, clearLicense, useSessionLicense, normalizeLicense, maskLicense, isLicense,
  maskKey, SecretsUnavailable, LICENSE_RE, _setSafeStorage
};
