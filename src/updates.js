'use strict';
// Update check against GitHub Releases. No electron-updater: Squirrel.Mac
// rejects unsigned/ad-hoc apps. Nothing identifying is sent — the request is
// an anonymous GET with a User-Agent of "Grayout/<version>".
//
// The Mac App Store edition gets its updates from the store only (App Review
// 2.4.5(vii)), so there createUpdater hands back a stub that never touches the
// network, and fetchLatest refuses too. The personal build gets the same stub:
// every public release is pay-only, and the owner rebuilds his copy from the
// new tag instead (docs/BUILD-SPEC.md section 27).
const channel = require('./channel');
const updatesAllowed = () => channel.features().updates;

const RELEASES_URL = 'https://api.github.com/repos/aarushkandukoori/grayout/releases/latest';
const DOWNLOAD_PAGE = 'https://github.com/aarushkandukoori/grayout/releases/latest';
const CHECK_EVERY_MS = 24 * 3600 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// The only release pages the tray may open. html_url comes from the network,
// and the tray hands it to shell.openExternal, which opens any scheme (file:,
// custom app links). So anything that is not an https page of this repo's
// releases is replaced by the fixed download page.
const RELEASES_PATH_PREFIX = '/aarushkandukoori/grayout/releases/';

/** html_url if it is an https github.com page of this repo's releases, else DOWNLOAD_PAGE. */
function safeReleaseUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return DOWNLOAD_PAGE;
  let u;
  try { u = new URL(value); } catch { return DOWNLOAD_PAGE; }
  const ok = u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password &&
    u.port === '' && u.pathname.startsWith(RELEASES_PATH_PREFIX);
  return ok ? u.toString() : DOWNLOAD_PAGE;
}

/** Resolve { tag, version, url } or null. Never throws. */
async function fetchLatest({ fetchImpl = fetch, currentVersion = '0.0.0' } = {}) {
  if (!updatesAllowed()) return null;
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { 'User-Agent': `Grayout/${currentVersion}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j.tag_name !== 'string') return null;
    return { tag: j.tag_name, version: j.tag_name.replace(/^v/i, ''), url: safeReleaseUrl(j.html_url) };
  } catch {
    return null;
  }
}

const DISABLED = Object.freeze({ checked: false, disabled: true });

/** What createUpdater returns in a build without the update check. */
function disabledUpdater() {
  return {
    check: async () => ({ ...DISABLED }),
    start() {},
    stop() {},
    getAvailable: () => null,
    dismiss() {},
    disabled: true
  };
}

/**
 * deps: { currentVersion, isEnabled(): bool, state: {get,update}, onAvailable(info), fetchImpl }
 */
function createUpdater(deps) {
  if (!updatesAllowed()) return disabledUpdater();
  let timer = null;
  let available = null;

  async function check({ manual = false } = {}) {
    if (!updatesAllowed()) return { ...DISABLED };
    if (!manual && !deps.isEnabled()) return { checked: false };
    const latest = await fetchLatest({ fetchImpl: deps.fetchImpl, currentVersion: deps.currentVersion });
    if (deps.state) deps.state.update(s => { s.lastUpdateCheck = Date.now(); });
    if (!latest) return { checked: false };
    const newer = isNewer(latest.version, deps.currentVersion);
    const dismissed = deps.state && deps.state.get().dismissedVersion === latest.version;
    if (newer && (manual || !dismissed)) {
      available = latest;
      try { deps.onAvailable(latest); } catch {}
    }
    return { checked: true, newer, latest };
  }

  function start() {
    stop();
    if (!updatesAllowed()) return;
    timer = setTimeout(() => {
      check().catch(() => {});
      timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
      if (timer.unref) timer.unref();
    }, FIRST_CHECK_DELAY_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; } }
  function getAvailable() { return available; }
  function dismiss() {
    if (available && deps.state) deps.state.update(s => { s.dismissedVersion = available.version; });
    available = null;
  }

  return { check, start, stop, getAvailable, dismiss };
}

module.exports = { isNewer, parseVersion, fetchLatest, safeReleaseUrl, createUpdater, disabledUpdater, RELEASES_URL, DOWNLOAD_PAGE };
