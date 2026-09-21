'use strict';
// Rotating app log. Never receives prompt text, images, task titles, the work
// description, or the API key: callers pass short status strings only, and a
// redaction guard catches a key that slips through anyway.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;
// Anthropic keys start with sk-ant-, OpenAI keys with sk-proj-/sk-; redact both.
const KEY_RE = /sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_\-]{16,}/g;

function redact(s) {
  return String(s).replace(KEY_RE, '[redacted]');
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
