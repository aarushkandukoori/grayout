'use strict';
// Small persisted app state (not user settings): onboarding progress, the
// daily check counter, update-check bookkeeping.
const fs = require('fs');
const paths = require('./paths');

const DEFAULT_STATE = {
  onboarding: { completed: false, step: 1 },
  firstRunAt: null,
  lastUpdateCheck: 0,
  dismissedVersion: '',
  dayCounter: { day: '', checks: 0 },
  lastPrune: 0,
  // True while this app has the system Color Filters switch turned on, so a
  // crash can be told apart from a switch the user set themselves.
  grayscaleOwned: false
};

let state = null;

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load() {
  if (state) return state;
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(paths.STATE_PATH, 'utf8')); } catch {}
  if (!parsed || typeof parsed !== 'object') parsed = {};
  state = {
    ...DEFAULT_STATE,
    ...parsed,
    onboarding: { ...DEFAULT_STATE.onboarding, ...(parsed.onboarding || {}) },
    dayCounter: { ...DEFAULT_STATE.dayCounter, ...(parsed.dayCounter || {}) }
  };
  if (!state.firstRunAt) { state.firstRunAt = Date.now(); save(); }
  return state;
}

function save() {
  if (!state) return;
  try {
    fs.mkdirSync(paths.USER_DATA, { recursive: true, mode: 0o700 });
    const tmp = paths.STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, paths.STATE_PATH);
  } catch {}
}

function get() { return load(); }
function update(fn) { fn(load()); save(); return state; }

function checksToday() {
  const s = load();
  return s.dayCounter.day === localDay() ? s.dayCounter.checks : 0;
}

function bumpChecks() {
  update(s => {
    const day = localDay();
    if (s.dayCounter.day !== day) s.dayCounter = { day, checks: 0 };
    s.dayCounter.checks++;
  });
  return checksToday();
}

function _reset() { state = null; }

module.exports = { get, update, save, checksToday, bumpChecks, localDay, _reset, DEFAULT_STATE };
