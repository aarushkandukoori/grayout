'use strict';
// Which distribution this build is, and what that build may do.
//
// Grayout ships two ways from one codebase:
//   direct: the DMG / Homebrew download from GitHub (worldwide)
//   mas:    the Mac App Store edition (United States storefront only)
//
// The Mac App Store edition runs inside Apple's App Sandbox and has to follow
// App Review rules, so some features are off there: no private grayscale API,
// no self-update check, no own-API-key or Claude CLI engine, no LaunchAgent.
//
// Packaged builds: Electron sets process.mas === true in Mac App Store builds,
// and nothing else (no env var, no config.json) can change the answer.
// Unpackaged (npm start, tests): GRAYOUT_CHANNEL=mas, or _setForTests().
//
// Call features() when you need it, not at require time, so tests can flip
// the channel.

let forced = null;

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

function features() {
  const mas = isMAS();
  return Object.freeze({
    updates: !mas,             // GitHub release check (2.4.5(vii): MAS updates come from the store)
    selfHosting: !mas,         // own Anthropic/OpenAI key (hosted service only on MAS)
    cliEngine: !mas,           // Claude CLI engine spawns outside binaries (2.5.2)
    apiBaseOverride: !mas,     // config.json apiBase / GRAYOUT_API_BASE
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

module.exports = { name, isMAS, features, _setForTests };
