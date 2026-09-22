'use strict';
// Onboarding window logic. The only door to the main process is window.grayout
// (ui/preload/onboarding.js); the handlers live in src/ipc.js. Untrusted
// strings (activity phrases, error messages) are rendered with textContent.
(() => {
  const api = window.grayout;
  const $ = id => document.getElementById(id);
  const STEPS = 5;
  // Links on the <a data-external> elements in the HTML go through the main
  // process's host allowlist (src/ipc.js ALLOWED_HOSTS).

  if (!api) {
    $('no-bridge').style.display = 'block';
    $('loading').hidden = true;
    $('screens').hidden = true;
    return;
  }

  let S = null;              // last onb:getState payload
  let step = 1;
  let screenTimer = null;    // screen 2 poll
  let screenState = 'not-determined';
  // null until the first getState() resolves; then true if macOS had already
  // granted Screen Recording to this process when it launched.
  let grantedAtBoot = null;
  let loginNoticeShown = false;
  let finishing = false;

  const show = (el, on) => { el.hidden = !on; };
  const setText = (el, text) => { el.textContent = text == null ? '' : String(text); };
  const money = n => (typeof n === 'number' && Number.isFinite(n)) ? `$${n.toFixed(2)}` : null;
  const swallow = p => Promise.resolve(p).catch(() => undefined);

  /* ---------------- navigation ---------------- */

  function go(n, opts = {}) {
    const next = Math.min(STEPS, Math.max(1, Number(n) || 1));
    if (next !== 2) stopScreenPoll();
    if (next !== 3 && claiming) cancelCheckout();
    step = next;
    for (const sec of document.querySelectorAll('.screen')) {
      sec.classList.toggle('on', Number(sec.dataset.step) === step);
    }
    setText($('progress'), `${step} of ${STEPS}`);
    if (!opts.silent) swallow(api.setStep(step));
    onEnter(step);
  }

  function onEnter(n) {
    if (n === 1) renderScreen1();
    if (n === 2) { renderScreenPill(S ? S.screen : screenState); startScreenPoll(); }
    if (n === 3) renderScreen3();
    if (n === 4) renderScreen4();
    if (n === 5) renderScreen5();
    focusPrimary(n);
  }

  function focusPrimary(n) {
    const target = {
      1: '#btn-1-continue', 2: '#btn-2-continue', 3: '#btn-subscribe', 4: '#work', 5: '#btn-preview'
    }[n];
    const el = target && document.querySelector(target);
    if (el && !el.disabled) setTimeout(() => el.focus({ preventScroll: true }), 0);
  }

  /* ---------------- screen 1 ---------------- */

  function renderScreen1() {
    // Running from source has no Applications concept; only a packaged build
    // that lives outside /Applications gets the bar.
    const needsMove = !!(S && S.isPackaged && !S.inApplications);
    show($('move-bar'), needsMove);
  }

  async function moveToApplications() {
    const btn = $('btn-move');
    btn.disabled = true;
    setText($('move-status'), '');
    let ok = false;
    try { ok = await api.moveToApplications(); } catch { ok = false; }
    if (!ok) {
      // On success the app relaunches from /Applications by itself.
      btn.disabled = false;
      setText($('move-status'), 'Grayout stayed where it is. Drag it to Applications in Finder, then open it again.');
    }
  }

  /* ---------------- screen 2 ---------------- */

  function renderScreenPill(status) {
    screenState = status || 'not-determined';
    const pill = $('screen-pill');
    const granted = screenState === 'granted';
    const stale = screenState === 'stale';
    pill.classList.remove('pill-good', 'pill-bad', 'pill-warn');
    pill.classList.add(granted ? 'pill-good' : stale ? 'pill-warn' : 'pill-bad');
    setText($('screen-pill-text'), granted ? 'Allowed' : stale ? 'Allowed, but stale' : 'Not allowed');

    // A grant that was already in place when this window opened is live in this
    // process: Continue is the way forward. A grant that arrived just now is not
    // applied until the app restarts, so Relaunch is the only primary and
    // Continue stays disabled rather than silently skipping the restart.
    const needsRelaunch = granted && grantedAtBoot === false;
    show($('btn-open-screen'), !granted);
    show($('btn-relaunch'), needsRelaunch);
    show($('relaunch-note'), needsRelaunch);
    show($('stale-box'), stale);
    $('btn-2-continue').disabled = !granted || needsRelaunch;
    $('btn-2-continue').classList.toggle('btn-primary', !needsRelaunch);
    $('btn-2-continue').classList.toggle('btn-secondary', needsRelaunch);
  }

  async function pollScreen() {
    try {
      const r = await api.recheckScreen();
      if (r && typeof r.screen === 'string') {
        if (r.tccResetCmd) setText($('tcc-cmd'), r.tccResetCmd);
        if (r.screen !== screenState) renderScreenPill(r.screen);
        if (S) S.screen = r.screen;
      }
    } catch { /* keep the last known state */ }
  }

  function startScreenPoll() {
    stopScreenPoll();
    pollScreen();
    screenTimer = setInterval(pollScreen, 2000);
  }

  function stopScreenPoll() {
    if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }
  }

  async function copyTcc() {
    const btn = $('btn-copy-tcc');
    try { await api.copyText($('tcc-cmd').textContent); } catch { return; }
    setText(btn, 'Copied');
    setTimeout(() => setText(btn, 'Copy'), 1500);
  }

  function relaunch() {
    $('btn-relaunch').disabled = true;
    setText($('btn-relaunch'), 'Relaunching…');
    swallow(api.relaunch());
  }

  /* ---------------- screen 3: the plan ----------------
     v2 sells a subscription. There is no API key here: the service holds the
     model key. Every price on this screen comes from src/pricing.js through
     onb:getState, so a price is changed in exactly one place. */

  let plan = 'monthly';
  let claiming = false;   // the browser tab is open and /v1/claim is polling
  let busy = false;       // a checkout or activate call is in flight

  const planFacts = id => {
    const p = S && S.plans && S.plans[id];
    return p && typeof p.priceLabel === 'string' ? p : null;
  };
  const countOf = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const commas = n => n.toLocaleString('en-US');

  function subStatus(text, cls) {
    const el = $('sub-status');
    el.classList.remove('status-good', 'status-bad');
    setText(el, text);
    if (cls) el.classList.add(cls === 'ok' ? 'status-good' : 'status-bad');
  }

  function syncPlanButtons() {
    const locked = claiming || busy;
    $('btn-subscribe').disabled = locked;
    $('btn-free').disabled = locked;
    $('btn-activate').disabled = locked || !$('license').value.trim();
    for (const r of document.querySelectorAll('input[name="plan"]')) r.disabled = locked;
    show($('btn-cancel-claim'), claiming);
    setText($('btn-subscribe'), claiming ? 'Waiting for checkout…' : 'Subscribe');
  }

  function renderScreen3() {
    const free = countOf(S && S.freeChecks, 100);
    const included = countOf(S && S.includedChecks, null);
    const m = planFacts('monthly');
    const y = planFacts('yearly');

    if (m) {
      setText($('price-monthly'), `${m.priceLabel} ${m.periodLabel}`);
      setText($('note-monthly'), m.trialDays
        ? `${m.trialDays}-day free trial, then ${m.priceLabel} ${m.periodLabel}. Cancel any time.`
        : 'Cancel any time.');
    }
    if (y) {
      const off = Number.isFinite(y.savingsPercent) ? `, ${y.savingsPercent}% off` : '';
      setText($('price-yearly'), `${y.priceLabel} ${y.periodLabel}`);
      setText($('note-yearly'), y.perMonthLabel
        ? `${y.perMonthLabel} a month, billed yearly${off}.`
        : `Billed yearly${off}.`);
    }
    setText($('plan-included'), included === null
      ? ''
      : `Either plan includes ${commas(included)} checks a month, well above ordinary use.`);
    setText($('btn-free'), `Try ${free} checks free`);
    setText($('free-note'), `${free} checks on this Mac. No card, no account, no sign-in. That is usually most of a working day.`);

    // A license already on this Mac (a reinstall, a second machine) means there
    // is nothing to buy: Continue is enough.
    const acct = (S && S.account) || null;
    const has = !!(acct && acct.hasLicense);
    setText($('plan-existing'), has
      ? `This Mac already has a license${acct.licenseMasked ? ` (${acct.licenseMasked})` : ''}. Continue, or subscribe again to replace it.`
      : '');
    show($('btn-3-continue'), has);

    for (const r of document.querySelectorAll('input[name="plan"]')) r.checked = r.value === plan;
    subStatus('');
    syncPlanButtons();
  }

  function detailOf(r) {
    return r && typeof r.message === 'string' ? r.message.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  }

  function checkoutMessage(r) {
    const kind = r && r.kind;
    if (kind === 'network') return 'Could not reach the Grayout service. Check your connection and try again.';
    if (kind === 'rate_limited') return 'Too many tries just now. Wait a moment and press Subscribe again.';
    const detail = detailOf(r);
    return detail ? `Checkout did not start: ${detail}` : 'Checkout did not start. Try again.';
  }

  function claimMessage(r) {
    const kind = r && r.kind;
    if (kind === 'timeout') return 'Checkout was not finished in time. Press Subscribe to start again.';
    if (kind === 'claim_expired') return 'That checkout link has expired. Press Subscribe to start again.';
    if (kind === 'key_rejected' || kind === 'no_license') return 'The service did not accept that purchase. Press Subscribe to start again.';
    if (kind === 'network') return 'Grayout lost its connection while waiting. If you did pay, paste the license key below.';
    const detail = detailOf(r);
    return detail || 'Checkout did not finish. Press Subscribe to try again.';
  }

  function activateMessage(r) {
    const kind = r && r.kind;
    if (kind === 'license_invalid' || kind === 'key_rejected') return 'That key is not one this service issued. Check it for missing characters.';
    if (kind === 'no_license') return 'Paste your license key first.';
    if (kind === 'trial_expired' || kind === 'subscription_inactive') return 'That license is no longer active. Subscribe again above to start a new one.';
    if (kind === 'network') return 'Could not reach the Grayout service. Check your connection and try again.';
    const detail = detailOf(r);
    return detail || 'That key could not be activated.';
  }

  async function subscribe() {
    if (claiming || busy) return;
    busy = true;
    syncPlanButtons();
    subStatus('Opening checkout in your browser…');
    let r;
    try { r = await api.startCheckout(plan); } catch (e) { r = { ok: false, kind: 'unknown', message: e && e.message }; }
    busy = false;
    if (!r || !r.ok) { syncPlanButtons(); subStatus(checkoutMessage(r), 'err'); return; }
    if (r.opened === false) {
      syncPlanButtons();
      subStatus('Grayout could not open your browser. Subscribe on the Grayout site instead, then paste the license key below.', 'err');
      return;
    }

    claiming = true;
    syncPlanButtons();
    subStatus('Finish in your browser. This window unlocks itself the moment the payment goes through.');
    let c;
    try { c = await api.pollClaim(r.deviceCode); } catch (e) { c = { ok: false, kind: 'unknown', message: e && e.message }; }
    claiming = false;
    syncPlanButtons();

    if (c && c.ok) {
      await refreshState();
      subStatus('Subscribed. Grayout is ready.', 'ok');
      go(4);
      return;
    }
    if (c && c.kind === 'cancelled') { subStatus(''); return; }
    subStatus(claimMessage(c), 'err');
  }

  function cancelCheckout() {
    // pollClaim resolves with kind 'cancelled'; subscribe() clears the line.
    swallow(api.cancelClaim());
  }

  async function startFree() {
    if (claiming || busy) return;
    busy = true;
    syncPlanButtons();
    await swallow(api.startFree());
    busy = false;
    syncPlanButtons();
    await refreshState();
    go(4);
  }

  async function activateLicense() {
    const key = $('license').value.trim();
    if (!key || claiming || busy) return;
    busy = true;
    syncPlanButtons();
    subStatus('Checking that key…');
    let r;
    try { r = await api.activateLicense(key); } catch (e) { r = { ok: false, kind: 'unknown', message: e && e.message }; }
    busy = false;
    syncPlanButtons();
    if (r && r.ok) {
      $('license').value = '';
      await refreshState();
      subStatus('That license is active on this Mac.', 'ok');
      go(4);
      return;
    }
    subStatus(activateMessage(r), 'err');
  }

  function toggleLicenseRow() {
    const row = $('license-row');
    const on = !!row.hidden;
    show(row, on);
    $('btn-have-key').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) $('license').focus();
  }

  // The plan and usage shown on screen 4 come from the account, so re-read the
  // state after anything that changes it.
  async function refreshState() {
    let fresh = null;
    try { fresh = await api.getState(); } catch { fresh = null; }
    if (fresh && typeof fresh === 'object') {
      S = { ...(S || {}), ...fresh };
      screenState = S.screen || screenState;
    }
  }


  /* ---------------- screen 4 ---------------- */

  function renderScreen4() {
    const cfg = (S && S.config) || {};
    const e = S && S.estimates;
    const est = (e && e.byInterval) || {};
    // On the subscription there is no per-check bill to show, so the rows count
    // checks against the allowance instead of dollars nobody pays.
    const hosted = !(S && S.selfHosted);
    for (const sec of [30, 45, 90]) {
      const row = est[sec];
      if (hosted) {
        setText($(`est-${sec}`), row && Number.isFinite(row.checks) ? `about ${commas(row.checks)} checks a day` : '');
      } else {
        const d = row && money(row.daily);
        setText($(`est-${sec}`), d ? `about ${d} a day` : 'estimate unavailable');
      }
    }
    if (hosted) {
      const included = countOf(S && S.includedChecks, null);
      setText($('est-note'), included === null
        ? 'Change-gating skips the check when nothing on screen moved, so the real count is usually about half of this.'
        : `An upper bound: change-gating skips the check when nothing on screen moved, so the real count is usually about half of this. Your plan includes ${commas(included)} checks a month.`);
    } else if (e && e.providerLabel && e.model) {
      const when = e.priceDate ? `, at prices on ${e.priceDate}` : '';
      setText($('est-note'), `Estimates for ${e.providerLabel} ${e.model} on one display${when}. A second display roughly doubles it.`);
    }
    if (!$('work').value && typeof cfg.workDescription === 'string') $('work').value = cfg.workDescription;
    const sel = [30, 45, 90].includes(cfg.checkIntervalSec) ? cfg.checkIntervalSec : 45;
    for (const r of document.querySelectorAll('input[name="interval"]')) r.checked = Number(r.value) === sel;
    $('camera').checked = !!cfg.camera && S && S.cameraStatus === 'granted';
    const inApps = !!(S && (S.inApplications || (S.loginItem && S.loginItem.inApplications)));
    show($('login-block'), inApps);
    $('login').checked = !!cfg.startAtLogin && !!(S && S.loginItem && S.loginItem.status === 'enabled');
    setText($('setup-status'), '');
  }

  async function onCameraToggle() {
    const box = $('camera');
    const out = $('camera-status');
    out.classList.remove('status-good', 'status-bad');
    if (!box.checked) { setText(out, ''); return; }
    box.disabled = true;
    setText(out, 'Asking macOS…');
    let r;
    try { r = await api.requestCamera(); } catch { r = { granted: false, status: 'unknown' }; }
    box.disabled = false;
    if (r && r.granted) {
      out.classList.add('status-good');
      setText(out, 'Camera allowed.');
      return;
    }
    box.checked = false;
    out.classList.add('status-bad');
    out.replaceChildren();
    out.append(r && r.status === 'denied'
      ? 'macOS has the camera turned off for Grayout. '
      : 'macOS did not allow the camera. ');
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'link'; link.textContent = 'Open Camera settings';
    link.addEventListener('click', () => swallow(api.openCameraSettings()));
    out.append(link, ', turn on Grayout, then try again.');
  }

  function renderLoginStatus(li) {
    const out = $('login-status');
    out.classList.remove('status-good', 'status-bad');
    out.replaceChildren();
    const status = li && li.status;
    if (!$('login').checked) return;
    if (status === 'requires-approval') {
      loginNoticeShown = true;
      out.append('macOS wants you to approve this: ');
      const link = document.createElement('button');
      link.type = 'button'; link.className = 'link'; link.textContent = 'Open Login Items settings';
      link.addEventListener('click', () => swallow(api.openLoginItems()));
      out.append(link, '.');
    } else if (status === 'enabled') {
      out.classList.add('status-good');
      out.append('Grayout will start when you log in.');
    } else if (status === 'not-in-applications') {
      $('login').checked = false;
      out.classList.add('status-bad');
      out.append('Move Grayout to Applications first.');
    } else if (status) {
      out.classList.add('status-bad');
      out.append('macOS did not register the login item. You can try again in Settings.');
    }
  }

  async function onLoginToggle() {
    const box = $('login');
    box.disabled = true;
    setText($('login-status'), box.checked ? 'Registering…' : '');
    let r;
    try { r = await api.saveSetup({ startAtLogin: box.checked }); } catch { r = null; }
    box.disabled = false;
    if (r && r.loginItem) { if (S) S.loginItem = r.loginItem; renderLoginStatus(r.loginItem); }
    else if (box.checked) { setText($('login-status'), 'Could not change the login item right now.'); }
  }

  function setupPayload() {
    const sel = document.querySelector('input[name="interval"]:checked');
    return {
      workDescription: $('work').value.trim().slice(0, 500),
      checkIntervalSec: sel ? Number(sel.value) : 45,
      camera: $('camera').checked,
      startAtLogin: !$('login-block').hidden && $('login').checked
    };
  }

  async function saveSetup() {
    const btn = $('btn-4-continue');
    btn.disabled = true;
    setText($('setup-status'), '');
    let r;
    try { r = await api.saveSetup(setupPayload()); } catch (e) { r = null; }
    btn.disabled = false;
    if (!r) { setText($('setup-status'), "Couldn't save these settings. Try again."); return; }
    if (S) { if (r.config) S.config = { ...S.config, ...r.config }; if (r.loginItem) S.loginItem = r.loginItem; }
    if (r.loginItem && $('login').checked && r.loginItem.status === 'requires-approval' && !loginNoticeShown) {
      // Show the approval link once before moving on; the next Continue proceeds.
      renderLoginStatus(r.loginItem);
      return;
    }
    go(5);
  }

  /* ---------------- screen 5 ---------------- */

  function renderScreen5() {
    setText($('preview-status'), '');
    $('btn-finish').disabled = finishing;
  }

  async function preview() {
    const btn = $('btn-preview');
    const out = $('preview-status');
    if (btn.disabled) return;
    btn.disabled = true;
    setText(out, '');
    const release = new Promise(r => setTimeout(r, 3500));
    let ok = true;
    try { ok = await api.previewGray(); } catch { ok = null; }
    await release;
    btn.disabled = false;
    setText(btn, 'Again');
    if (ok === false || (S && S.grayscaleAvailable === false)) {
      setText(out, "Grayscale isn't available on this Mac; Grayout will use the red border only.");
    } else if (ok === null) {
      setText(out, "The preview didn't run. You can try it again.");
    }
  }

  async function finish() {
    if (finishing) return;
    finishing = true;
    const btn = $('btn-finish');
    btn.disabled = true;
    setText(btn, 'Starting…');
    try { await api.finish(); }
    catch {
      finishing = false;
      btn.disabled = false;
      setText(btn, 'Start watching');
    }
  }

  /* ---------------- wiring ---------------- */

  for (const a of document.querySelectorAll('[data-external]')) {
    a.addEventListener('click', e => { e.preventDefault(); swallow(api.openExternal(a.dataset.external)); });
  }

  $('btn-move').addEventListener('click', moveToApplications);
  $('btn-1-continue').addEventListener('click', () => go(2));

  $('btn-open-screen').addEventListener('click', () => swallow(api.openScreenSettings()));
  $('btn-relaunch').addEventListener('click', relaunch);
  $('btn-copy-tcc').addEventListener('click', copyTcc);
  $('btn-2-back').addEventListener('click', () => go(1));
  $('btn-2-skip').addEventListener('click', () => go(3));
  $('btn-2-continue').addEventListener('click', () => { if (!$('btn-2-continue').disabled) go(3); });

  for (const r of document.querySelectorAll('input[name="plan"]')) {
    r.addEventListener('change', () => { if (r.checked) plan = r.value === 'yearly' ? 'yearly' : 'monthly'; });
  }
  $('btn-subscribe').addEventListener('click', subscribe);
  $('btn-cancel-claim').addEventListener('click', cancelCheckout);
  $('btn-free').addEventListener('click', startFree);
  $('btn-have-key').addEventListener('click', toggleLicenseRow);
  $('license').addEventListener('input', syncPlanButtons);
  $('btn-activate').addEventListener('click', activateLicense);
  $('btn-3-continue').addEventListener('click', () => go(4));
  $('btn-3-back').addEventListener('click', () => go(2));

  $('camera').addEventListener('change', onCameraToggle);
  $('login').addEventListener('change', onLoginToggle);
  $('btn-4-continue').addEventListener('click', saveSetup);
  $('btn-4-back').addEventListener('click', () => go(3));

  $('btn-preview').addEventListener('click', preview);
  $('btn-finish').addEventListener('click', finish);
  $('btn-5-back').addEventListener('click', () => go(4));

  // Enter advances where sensible. Buttons and links keep their own Enter.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.metaKey || e.altKey || e.ctrlKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return;
    let handled = true;
    if (step === 1) go(2);
    else if (step === 2) { if (!$('btn-2-continue').disabled) go(3); else handled = false; }
    else if (step === 3) {
      if (claiming || busy) handled = false;
      else if ($('license').value.trim()) activateLicense();
      else subscribe();
    }
    else if (step === 4) saveSetup();
    else if (step === 5) finish();
    if (handled) e.preventDefault();
  });

  window.addEventListener('beforeunload', () => { stopScreenPoll(); if (claiming) cancelCheckout(); });

  /* ---------------- boot ---------------- */

  // Nothing but a neutral line shows until the state is known. getState can
  // take a while (a locked Mac, a slow first probe), and the user may be
  // resuming on step 3 or 4, so screen 1 is never shown as a fallback. A call
  // that hangs past SLOW_MS, or rejects, is retried every RETRY_MS until the
  // deadline; the first answer wins.
  const SLOW_MS = 5000, RETRY_MS = 2000, DEADLINE_MS = 30000;

  function readState() {
    return new Promise(resolve => {
      const started = Date.now();
      let settled = false;
      let calls = 0;
      let timer = null;
      const finish = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const schedule = ms => { clearTimeout(timer); timer = setTimeout(fire, ms); };
      const fire = () => {
        if (settled) return;
        if (Date.now() - started >= DEADLINE_MS) { finish(null); return; }
        calls += 1;
        schedule(calls === 1 ? SLOW_MS : RETRY_MS);
        Promise.resolve().then(() => api.getState()).then(
          v => { if (v && typeof v === 'object') finish(v); else schedule(RETRY_MS); },
          () => schedule(RETRY_MS));
      };
      fire();
      setTimeout(() => finish(null), DEADLINE_MS);
    });
  }

  (async () => {
    const state = await readState();
    if (!state) {
      setText($('loading'), 'Grayout could not read its state. Quit and reopen the app.');
      return;
    }
    S = state;
    screenState = S.screen || 'not-determined';
    // Set once, before anything can change it: was the permission already ours
    // when this process started?
    grantedAtBoot = screenState === 'granted';
    if (S.tccResetCmd) setText($('tcc-cmd'), S.tccResetCmd);
    $('loading').hidden = true;
    $('screens').hidden = false;
    const resume = Number.isInteger(S.step) ? S.step : 1;
    go(resume, { silent: true });
  })();
})();
