'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  // 'api' is the product. 'cli' is honored only when running unpackaged with
  // GRAYOUT_DEV_ENGINE=cli (maintainer use), see analyzer.resolveEngine.
  engine: 'api',
  // 'auto' detects Anthropic vs OpenAI from the key; or force 'anthropic' | 'openai'.
  provider: 'auto',
  // Used only if it belongs to the active provider's family; otherwise the
  // provider default applies (claude-haiku-4-5 / gpt-5-mini). See providers.js.
  model: 'claude-haiku-4-5',
  checkIntervalSec: 45,
  // Consecutive clearly-off-task verdicts required before the screen reacts.
  strikes: 2,
  // Stop spending model calls after this long with no keyboard/mouse input.
  // An existing alert is HELD, not cleared — passive video watching produces
  // no input, and clearing here would let it flap gray/color during exactly
  // the behaviour this is meant to catch.
  idleSkipSec: 600,
  // ...but while idle AND alerting, still run one check this often, so a wrong
  // gray self-corrects even if the person never touches the keyboard.
  heldAlertRecheckSec: 300,
  // Watchdog: color always comes back after this long, no matter what.
  maxAlertMinutes: 20,
  // "I'm working": clear the alert and never fire for this many minutes.
  disputeGraceMin: 10,
  // After unlock/wake, wait this long before the first check.
  wakeGraceSec: 45,
  // Hard ceiling on checks per local day (~$3.50 on Haiku). Pauses until tomorrow.
  dailyCheckCap: 1200,
  camera: false,
  grayscale: true,
  redFlash: true,
  pauseWhenLocked: true,
  // Frontmost app names that never trigger, matched case-insensitively as substrings.
  alwaysAllowedApps: ['zoom.us', 'FaceTime', 'Microsoft Teams', 'Webex', 'Google Meet', 'Discord'],
  // Frontmost app names that are never even captured (checked BEFORE screencapture).
  neverCaptureApps: ['1Password', 'Bitwarden', 'Passwords', 'Keychain Access'],
  // Optional one-liner telling the model what your work looks like (≤ 500 chars).
  workDescription: '',
  canvas: { baseUrl: 'https://canvas.cmu.edu', token: '' },
  tasksFile: '',
  logVerdicts: true,
  startAtLogin: false,
  checkForUpdates: true,
  // verdicts.jsonl is pruned to this many days at launch and once a day.
  historyDays: 30
};

// Bounds keep a hand-edited typo from doing damage — an unvalidated
// checkIntervalSec of "30" (string) or 0 would make setInterval fire ~1000x/sec.
const NUMERIC_BOUNDS = {
  schemaVersion: { min: 1, max: 1 },
  checkIntervalSec: { min: 10, max: 3600 },
  strikes: { min: 1, max: 20 },
  idleSkipSec: { min: 30, max: 86400 },
  heldAlertRecheckSec: { min: 60, max: 3600 },
  maxAlertMinutes: { min: 1, max: 240 },
  disputeGraceMin: { min: 1, max: 120 },
  wakeGraceSec: { min: 0, max: 600 },
  dailyCheckCap: { min: 50, max: 20000 },
  historyDays: { min: 1, max: 365 }
};

const MAX_WORK_DESCRIPTION = 500;

function coerce(cfg) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (cfg[key] === undefined) continue;
    const def = DEFAULT_CONFIG[key];
    const val = cfg[key];

    if (typeof def === 'boolean') {
      if (typeof val === 'boolean') out[key] = val;
    } else if (typeof def === 'number') {
      // Number(null) / Number('') / Number(true) are finite; a hand-edited
      // "checkIntervalSec": null must keep the default, not clamp to the minimum.
      if (val === null || typeof val === 'boolean' || Array.isArray(val) || (typeof val === 'string' && !val.trim())) continue;
      const n = Number(val);
      if (Number.isFinite(n)) {
        const b = NUMERIC_BOUNDS[key];
        out[key] = b ? Math.min(b.max, Math.max(b.min, Math.round(n))) : n;
      }
    } else if (Array.isArray(def)) {
      if (Array.isArray(val)) out[key] = val.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean).slice(0, 100);
    } else if (typeof def === 'string') {
      if (typeof val === 'string') out[key] = val;
    }
  }

  if (out.engine !== 'api' && out.engine !== 'cli' && out.engine !== 'auto') out.engine = 'api';
  if (!['auto', 'anthropic', 'openai'].includes(out.provider)) out.provider = 'auto';
  if (!/^(claude-|gpt-|o\d)[a-z0-9.\-]+$/i.test(out.model)) out.model = DEFAULT_CONFIG.model;
  out.workDescription = out.workDescription.slice(0, MAX_WORK_DESCRIPTION);

  const c = cfg.canvas && typeof cfg.canvas === 'object' ? cfg.canvas : {};
  out.canvas = {
    baseUrl: typeof c.baseUrl === 'string' && /^https?:\/\//.test(c.baseUrl.trim()) ? c.baseUrl.trim() : DEFAULT_CONFIG.canvas.baseUrl,
    // Accepted for backward compatibility; loadConfig moves it into secrets.
    token: typeof c.token === 'string' ? c.token : ''
  };

  return out;
}

function writeConfig(cfg) {
  const tmp = paths.CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, paths.CONFIG_PATH);
}

/**
 * Load config. A malformed file is preserved (backed up) rather than
 * overwritten — silently replacing it with defaults would destroy settings
 * over a single misplaced comma.
 *
 * `onCanvasToken(token)` is called (once) when a legacy plaintext Canvas token
 * is found in config.json, so the caller can move it into the secret store.
 */
function loadConfig({ onCanvasToken } = {}) {
  fs.mkdirSync(paths.USER_DATA, { recursive: true, mode: 0o700 });

  let raw = null;
  try {
    raw = fs.readFileSync(paths.CONFIG_PATH, 'utf8');
  } catch {
    const fresh = coerce({});
    try { writeConfig(fresh); } catch {}
    return fresh;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  } catch (e) {
    const backup = paths.CONFIG_PATH + '.invalid';
    try { fs.writeFileSync(backup, raw, { mode: 0o600 }); } catch {}
    console.error(`[config] ${paths.CONFIG_PATH} is not valid JSON (${e.message}). ` +
                  `Your file was copied to ${backup}; running on defaults until you fix it.`);
    return { ...coerce({}), _invalid: true };
  }

  const merged = coerce(parsed);

  // One-time migration: the Canvas token used to live in plaintext here.
  if (merged.canvas.token) {
    let moved = false;
    if (typeof onCanvasToken === 'function') {
      try { onCanvasToken(merged.canvas.token); moved = true; } catch {}
    }
    if (moved) merged.canvas.token = '';
  }

  // Only rewrite when normalization actually changed something, so a valid file
  // the user is editing isn't churned on every load.
  const next = JSON.stringify(merged, null, 2) + '\n';
  if (next !== raw && next.trim() !== raw.trim()) {
    try { writeConfig(merged); } catch {}
  }
  return merged;
}

/** Merge `partial` into the on-disk config, validate, write, return the new config. */
function saveConfig(partial) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(paths.CONFIG_PATH, 'utf8')); } catch {}
  if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  const merged = coerce({ ...current, ...partial, canvas: { ...(current.canvas || {}), ...((partial && partial.canvas) || {}) } });
  writeConfig(merged);
  return merged;
}

module.exports = { DEFAULT_CONFIG, NUMERIC_BOUNDS, MAX_WORK_DESCRIPTION, coerce, loadConfig, saveConfig, writeConfig };
