'use strict';
// Which distribution this build is, and what that build may do.
//
// Grayout ships two ways from one codebase:
//   direct: the DMG / Homebrew download from GitHub (worldwide)
//   mas:    the Mac App Store edition (United States storefront only)
//
// Both public editions are pay-only: every check goes through the hosted
// Grayout service (free checks, trial, subscription). Neither offers an own
// API key, the Claude CLI engine or, once packaged, a different service
// address (config.json apiBase).
//
// The Mac App Store edition runs inside Apple's App Sandbox and has to follow
// App Review rules, so more is off there: no private grayscale API, no
// self-update check, no LaunchAgent, no task file.
//
// The personal build: a direct build made on purpose with
//   npm run pack:personal   or   npm run dist:personal
// which passes -c.extraMetadata.grayoutPersonal=true to electron-builder, so
// the packaged app.asar/package.json carries "grayoutPersonal": true. Only that
// build gets the own-key mode and the Claude CLI engine back (personal()), and
// it has no GitHub update check, since every public release is pay-only. The
// plain dist / pack scripts and the release workflow never pass the flag. The
// Mac App Store edition never gets them, flag or not.
//
// Packaged builds: Electron sets process.mas === true in Mac App Store builds,
// and personal() reads only the packaged package.json. Nothing else (no env
// var, no config.json) can change either answer.
// Unpackaged (npm start, tests): GRAYOUT_CHANNEL=mas and GRAYOUT_PERSONAL=1, or
// _setForTests() and _setPersonalForTests().
//
// Call features() when you need it, not at require time, so tests can flip
// the channel.

let forced = null;
let forcedPersonal = null;
let metadataForTests = null;

function isPackaged() {
  try { return !!require('electron').app.isPackaged; } catch { return false; }
}

function name() {
  if (forced) return forced;
  if (process.mas === true) return 'mas';
  if (!isPackaged() && process.env.GRAYOUT_CHANNEL === 'mas') return 'mas';
  return 'direct';
}

const isMAS = () => name() === 'mas';

// The app's own package.json: inside app.asar in a packaged build, where
// electron-builder has merged extraMetadata into it.
function packagedMetadata() {
  if (metadataForTests) return metadataForTests;
  try { return require('../package.json'); } catch { return null; }
}

/**
 * True only in a build made deliberately as the personal copy. Packaged: the
 * boolean "grayoutPersonal": true in the bundled package.json, nothing else.
 * Unpackaged: GRAYOUT_PERSONAL=1. The repository's package.json never has the
 * field (tests/build-config.test.js), so a plain build is always public.
 */
function personal() {
  if (forcedPersonal !== null) return forcedPersonal;
  if (isPackaged()) {
    const meta = packagedMetadata();
    return !!meta && meta.grayoutPersonal === true;
  }
  return process.env.GRAYOUT_PERSONAL === '1';
}

function features() {
  const mas = isMAS();
  // The own-key mode and the CLI engine: the personal direct build only.
  const own = !mas && personal();
  return Object.freeze({
    // GitHub release check. MAS: updates come from the store (2.4.5(vii)).
    // Personal build: every public release is pay-only, so "Update available"
    // would offer to replace the owner's copy with one; he rebuilds instead.
    updates: !mas && !personal(),
    selfHosting: own,          // own Anthropic/OpenAI key: personal direct build only (public builds are pay-only)
    cliEngine: own,            // Claude CLI engine: personal direct build only (MAS: spawns outside binaries, 2.5.2)
    // config.json apiBase / GRAYOUT_API_BASE. A public packaged build talks to
    // the address built in and nothing else, so it cannot be pointed at a copy
    // of server/ someone runs themselves to skip the plan. Running from source
    // (unpackaged) and the personal build still can.
    apiBaseOverride: !mas && (own || !isPackaged()),
    loginItemFallback: !mas,   // ~/Library/LaunchAgents fallback (sandbox denies it)
    moveToApplications: !mas,  // the store installs the app itself
    tccResetHint: !mas,        // "run tccutil" help; store signing keeps grants stable
    sponsorLink: !mas,         // tips would need in-app purchase (3.1.1)
    tasksFile: !mas,           // arbitrary file path is outside the sandbox
    canvas: !mas,              // Canvas to-dos: config-only, not disclosed in-app yet
    grayscaleBackend: mas ? 'blend' : 'colorFilters',
    frontmostBackend: mas ? 'helper' : 'lsappinfo',
    externalPurchase: true,    // MAS listing is US storefront only (3.1.1(a) US exception)
    manualLicenseEntry: true,  // MAS: Settings only, never onboarding; flip off if App Review objects
    licenseInOnboarding: !mas, // the "paste your key" box on the plan step
    aiConsentRequired: true    // 5.1.2(i): ask before anything goes to a third-party AI (both builds)
  });
}

function _setForTests(n) { forced = n || null; }
/** true / false forces personal(); null goes back to the real answer. */
function _setPersonalForTests(on) { forcedPersonal = on === null || on === undefined ? null : !!on; }
/** Stands in for the packaged package.json; null reads the real one again. */
function _setMetadataForTests(meta) { metadataForTests = meta || null; }

module.exports = { name, isMAS, personal, features, _setForTests, _setPersonalForTests, _setMetadataForTests };
