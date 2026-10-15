'use strict';
// System-wide grayscale, the consequence when you are off task.
//
// Two backends with the same contract (set, reassert, forceOffSync, usable,
// available, readActual, readStatusSync, status):
//   colorFilters  direct download: the macOS Color Filters switch, via
//                 helper/grayscale (src/grayscale-colorfilters.js)
//   blend         Mac App Store: a click-through overlay window owned by
//                 helper/grayout-overlay (src/grayscale-blend.js)
//
// The backend is chosen on every call from channel.features().grayscaleBackend,
// never cached, so tests can flip the channel. For development only, an
// unpackaged run can force one with GRAYOUT_GRAYSCALE_BACKEND=blend|colorFilters.
const channel = require('./channel');
const paths = require('./paths');
const colorFilters = require('./grayscale-colorfilters');
const blend = require('./grayscale-blend');

const BACKENDS = { colorFilters, blend };

function backendName() {
  // The Mac App Store build never touches the private Color Filters API.
  if (process.mas === true) return 'blend';
  if (!paths.isPackaged()) {
    const o = String(process.env.GRAYOUT_GRAYSCALE_BACKEND || '').trim().toLowerCase();
    if (o === 'blend') return 'blend';
    if (o === 'colorfilters') return 'colorFilters';
  }
  return channel.features().grayscaleBackend === 'blend' ? 'blend' : 'colorFilters';
}

const active = () => BACKENDS[backendName()];

const available = () => active().available();
const usable = () => active().usable();
const set = on => active().set(on);
const reassert = () => active().reassert();
const readActual = () => active().readActual();
const readStatusSync = () => active().readStatusSync();

function forceOffSync() {
  const name = backendName();
  const ok = BACKENDS[name].forceOffSync();
  // Belt and braces for a backend switch mid-run (tests, the dev override): an
  // overlay helper still running would keep its gray. Killing it is free. The
  // reverse is deliberately not done: the Color Filters switch may belong to
  // the user, and the blend backend must never touch it.
  if (name !== 'blend') blend.forceOffSync();
  return ok;
}

function status() {
  const name = backendName();
  return { ...BACKENDS[name].status(), backend: name };
}

function _reset() {
  colorFilters._reset();
  blend._reset();
}

module.exports = { available, usable, set, reassert, forceOffSync, readActual, readStatusSync, status, _reset };
