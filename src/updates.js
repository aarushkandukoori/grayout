'use strict';
// Update check against GitHub Releases. No electron-updater: Squirrel.Mac
// rejects unsigned/ad-hoc apps. Nothing identifying is sent — the request is
// an anonymous GET with a User-Agent of "Grayout/<version>".
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

/** Resolve { tag, version, url } or null. Never throws. */
async function fetchLatest({ fetchImpl = fetch, currentVersion = '0.0.0' } = {}) {
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { 'User-Agent': `Grayout/${currentVersion}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j.tag_name !== 'string') return null;
    return { tag: j.tag_name, version: j.tag_name.replace(/^v/i, ''), url: typeof j.html_url === 'string' ? j.html_url : DOWNLOAD_PAGE };
  } catch {
    return null;
  }
}

/**
 * deps: { currentVersion, isEnabled(): bool, state: {get,update}, onAvailable(info), fetchImpl }
 */
function createUpdater(deps) {
  let timer = null;
  let available = null;

  async function check({ manual = false } = {}) {
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

module.exports = { isNewer, parseVersion, fetchLatest, createUpdater, RELEASES_URL, DOWNLOAD_PAGE };
