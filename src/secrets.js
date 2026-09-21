'use strict';
// The API key (and optional Canvas token) live in secrets.bin, encrypted with
// Electron's safeStorage (macOS Keychain-backed, item "Grayout Safe Storage").
// There is deliberately NO plaintext fallback: if encryption is unavailable the
// key can only be held in memory for this session.
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

let cache = null;          // { anthropicApiKey, canvasToken } once decrypted
let sessionKey = null;     // in-memory only, when secure storage is unavailable
let loadFailed = false;

function _setSafeStorage(fake) { safeStorage = fake; cache = null; loadFailed = false; }

function available() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function load() {
  if (cache) return cache;
  if (!available()) { cache = null; return { anthropicApiKey: '', canvasToken: '' }; }
  let buf;
  try { buf = fs.readFileSync(paths.SECRETS_PATH); } catch { cache = { anthropicApiKey: '', canvasToken: '' }; return cache; }
  try {
    const parsed = JSON.parse(safeStorage.decryptString(buf));
    cache = {
      anthropicApiKey: typeof parsed.anthropicApiKey === 'string' ? parsed.anthropicApiKey : '',
      canvasToken: typeof parsed.canvasToken === 'string' ? parsed.canvasToken : ''
    };
  } catch (e) {
    if (!loadFailed) log.warn('secrets', `could not decrypt secrets.bin: ${e.message}`);
    loadFailed = true;
    cache = { anthropicApiKey: '', canvasToken: '' };
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
  maskKey, SecretsUnavailable, _setSafeStorage
};
