'use strict';
// Rotating app log. Never receives prompt text, images, task titles, the work
// description, an API key, a license key or the device token: callers pass
// short status strings only, and a redaction guard catches a credential that
// slips through anyway (an error message or a stack trace, for example).
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;
// Anthropic keys start with sk-ant-, OpenAI keys with sk-proj-/sk-, Grayout
// license keys with gry_live_ (real money) or gry_test_ (a Stripe sandbox
// purchase). A test key unlocks the same paid service in a sandbox, so it is
// hidden just like a live one.
const KEY_RE = /sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_\-]{16,}|gry_(?:live|test)_[A-Za-z0-9]{8,}/gi;
// The device token can get a lost license back from the service, so it is as
// secret as the license. It has no prefix to spot, so two nets catch it:
//   1. the JSON field it travels in ("deviceToken":"…"), whatever its length;
//   2. any standalone run of exactly 43 base64url characters, which is the
//      token's shape (docs/API-CONTRACT.md 4.1). Hiding an innocent 43-letter
//      word in a log line costs nothing; printing a token would.
const DEVICE_TOKEN_FIELD_RE = /("deviceToken"\s*:\s*")[^"]*(")/g;
const DEVICE_TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

function redact(s) {
  return String(s)
    .replace(KEY_RE, '[redacted]')
    .replace(DEVICE_TOKEN_FIELD_RE, '$1[redacted]$2')
    .replace(DEVICE_TOKEN_RE, '[redacted]');
}

function rotateIfNeeded() {
  let size = 0;
  try { size = fs.statSync(paths.LOG_PATH).size; } catch { return; }
  if (size < MAX_BYTES) return;
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${paths.LOG_PATH}.${i}`;
    const to = `${paths.LOG_PATH}.${i + 1}`;
    try { fs.renameSync(from, to); } catch {}
  }
  try { fs.renameSync(paths.LOG_PATH, `${paths.LOG_PATH}.1`); } catch {}
}

function write(level, tag, msg) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${tag}] ${redact(msg)}\n`;
  try {
    fs.mkdirSync(paths.LOG_DIR, { recursive: true, mode: 0o700 });
    rotateIfNeeded();
    fs.appendFileSync(paths.LOG_PATH, line, { mode: 0o600 });
  } catch {}
  if (level === 'error' || process.env.GRAYOUT_DEBUG) {
    (level === 'error' ? console.error : console.log)(line.trimEnd());
  }
}

module.exports = {
  info: (tag, msg) => write('info', tag, msg),
  warn: (tag, msg) => write('warn', tag, msg),
  error: (tag, msg) => write('error', tag, msg),
  redact
};
