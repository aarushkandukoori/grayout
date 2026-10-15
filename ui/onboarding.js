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
  // Set once at boot: setup was already finished and only consent is missing
  // or stale (an install from before the consent step, or consent withdrawn).
  // Then the window is just the consent card.
  let consentOnlyMode = false;

  const show = (el, on) => { el.hidden = !on; };
  const setText = (el, text) => { el.textContent = text == null ? '' : String(text); };
  const money = n => (typeof n === 'number' && Number.isFinite(n)) ? `$${n.toFixed(2)}` : null;
  const swallow = p => Promise.resolve(p).catch(() => undefined);

  /* ---------------- edition + consent ----------------
     onb:getState carries channel: { name, isMAS, features } (src/channel.js)
     and consent: { granted, at, version, processor: { name, via } }
     (src/consent.js). A main process from before either existed sends
     neither: that reads as the direct build with consent not given yet. */

  const DIRECT_FEATURES = { moveToApplications: true, tccResetHint: true, licenseInOnboarding: true, manualLicenseEntry: true, canvas: true, tasksFile: true };
  const MAS_FEATURES = { moveToApplications: false, tccResetHint: false, licenseInOnboarding: false, manualLicenseEntry: true, canvas: false, tasksFile: false };
  const isMAS = () => !!(S && S.channel && S.channel.isMAS === true);
  function feature(name) {
    const f = S && S.channel && S.channel.features;
    if (f && typeof f[name] === 'boolean') return f[name];
    return (isMAS() ? MAS_FEATURES : DIRECT_FEATURES)[name] === true;
  }
  // Task titles come only from Canvas or a tasks file. A build with neither
  // (the App Store edition) never sends any, so the consent card never lists them.
  const sendsTaskTitles = () => feature('canvas') || feature('tasksFile');

  // Who receives the screenshots for the engine and provider in use. The
  // hosted service (OpenAI, behind the Grayout service) is the product, so it
  // is also what an older payload without a processor means.
  const HOSTED = { name: 'OpenAI', via: 'the Grayout service' };
  // True only when the main process has no consent bridge at all (older than
  // the consent step): it then has nothing to record and nothing to gate.
  let consentLocal = false;
  function processorOf() {
    const p = S && S.consent && S.consent.processor;
    const ok = v => typeof v === 'string' && v.trim().length > 0;
    return p && ok(p.name) && ok(p.via) ? { name: p.name.trim().slice(0, 40), via: p.via.trim().slice(0, 80) } : HOSTED;
  }
  const consentGranted = () => consentLocal || !!(S && S.consent && S.consent.granted === true);

  /* ---------------- navigation ---------------- */

  function go(n, opts = {}) {
    let next = Math.min(STEPS, Math.max(1, Number(n) || 1));
    // The consent card comes before everything that could capture anything:
    // no later step opens until it is given (App Review 5.1.2(i)).
    if (consentOnlyMode || (next > 1 && !consentGranted())) next = 1;
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
    // Allow and continue never gets the focus by default: consent is a click,
    // not a stray Return.
    const target = {
      1: consentGranted() && !consentOnlyMode ? '#btn-1-continue' : null,
      2: '#btn-2-continue', 3: isMAS() ? '#btn-free' : '#btn-subscribe', 4: '#work', 5: '#btn-preview'
    }[n];
    const el = target && document.querySelector(target);
    if (el && !el.disabled) setTimeout(() => el.focus({ preventScroll: true }), 0);
  }

  /* ---------------- screen 1 ---------------- */

  function renderScreen1() {
    const only = consentOnlyMode;
    const granted = consentGranted();
    // Running from source has no Applications concept; only a packaged build
    // that lives outside /Applications gets the bar. The App Store installs
    // the app itself, so its build never shows it.
    const needsMove = !only && feature('moveToApplications') && !!(S && S.isPackaged && !S.inApplications);
    show($('move-bar'), needsMove);
    show($('intro'), !only);
    show($('intro-tail'), !only);
    show($('consent-only-lede'), only);
    setText($('h1-1'), only ? 'Before Grayout keeps watching' : 'How Grayout works');
    setText($('consent-title'), only ? 'What leaves your Mac.' : 'Before Grayout starts.');
    if (only) setText($('progress'), '');
    renderConsentCopy();
    const done = granted && !only;
    show($('consent-granted'), done);
    setText($('consent-granted'), done ? grantedLine() : '');
    show($('consent-when'), !done);
    show($('btn-consent-later'), !granted);
    show($('btn-consent-allow'), !granted);
    show($('btn-1-continue'), done);
  }

  /** The consent sentences for whoever receives the screenshots. */
  function consentCopy(p) {
    const name = p.name;
    if (p.via === HOSTED.via) {
      // Only OpenAI's API terms are known here: no training on API data, and
      // abuse-monitoring logs kept for up to 30 days.
      const terms = name === 'OpenAI'
        ? 'OpenAI does not use them to train its models and may keep them for up to 30 days to check for abuse.'
        : `${name} handles them under its terms for API data.`;
      return {
        lede: 'To decide whether you are on task, Grayout sends these to the Grayout service at each check:',
        who: `The Grayout service sends them to ${name}, a third-party AI provider, gets back a one-line verdict, and keeps none of them. ${terms}`
      };
    }
    if (p.via === 'your own API key') {
      return {
        lede: `To decide whether you are on task, Grayout sends these straight to ${name}, a third-party AI provider, at each check:`,
        who: `They go with your own API key, under your account and ${name}'s terms for API data, and never through the Grayout service.`
      };
    }
    if (p.via === 'your Claude CLI login') {
      return {
        lede: `To decide whether you are on task, Grayout hands these to the Claude CLI at each check, which sends them to ${name}, a third-party AI provider:`,
        who: `They go under your Claude CLI login and ${name}'s terms for it, and never through the Grayout service.`
      };
    }
    return {
      lede: `To decide whether you are on task, Grayout sends these to ${name}, a third-party AI provider, at each check:`,
      who: `They go through ${p.via}, under ${name}'s terms.`
    };
  }

  function renderConsentCopy() {
    const c = consentCopy(processorOf());
    setText($('consent-lede'), c.lede);
    setText($('consent-who'), c.who);
    setText($('consent-work'), sendsTaskTitles()
      ? 'your work description and task titles, if you add them'
      : 'your work description, if you add one');
  }

  function grantedLine() {
    const t = Date.parse((S && S.consent && S.consent.at) || '');
    const when = Number.isFinite(t)
      ? ` on ${new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
      : '';
    return `You allowed this${when}. You can withdraw it any time in Settings.`;
  }

  function consentStatus(text, cls) {
    const el = $('consent-status');
    el.classList.remove('status-good', 'status-bad');
    setText(el, text);
    if (cls) el.classList.add(cls === 'ok' ? 'status-good' : 'status-bad');
  }

  let consentBusy = false;

  async function allowConsent() {
    if (consentBusy || consentGranted()) return;
    consentBusy = true;
    $('btn-consent-allow').disabled = true;
    $('btn-consent-later').disabled = true;
    consentStatus('');
    let r;
    if (typeof api.grantConsent === 'function') {
      try { r = await api.grantConsent(); } catch (e) { r = { ok: false, message: e && e.message }; }
    } else {
      consentLocal = true;
      r = { ok: true };
    }
    if (r !== false && !(r && r.ok === false)) {
      await refreshState();
      if (!consentGranted()) {
        // A main process that reports consent but did not record it: say so
        // rather than walking on as if it had.
        if (S && S.consent && typeof S.consent === 'object') r = { ok: false };
        else consentLocal = true;
      }
    }
    consentBusy = false;
    $('btn-consent-allow').disabled = false;
    $('btn-consent-later').disabled = false;
    if (r === false || (r && r.ok === false)) {
      consentStatus('Grayout could not save your choice, so nothing will be sent. Try again.', 'err');
      return;
    }
    if (consentOnlyMode) {
      // The main process closes this window and resumes watching.
      renderScreen1();
      consentStatus('Thanks. Grayout is watching again.', 'ok');
      return;
    }
    go(2);
  }

  function declineConsent() {
    consentStatus(consentOnlyMode
      ? 'Nothing is captured and no check is sent. Grayout stays paused until you allow this, here or in Settings under Send screenshots for checks.'
      : 'Nothing is captured and no check is sent. Setup cannot finish without this, because checking your screen is all Grayout does. You can quit Grayout from the menu bar.');
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
    // The Terminal fix is for the ad-hoc signed download, whose identity can
    // change with an update. Store signing keeps the grant, so the App Store
    // build only says to toggle it.
    const tcc = feature('tccResetHint');
    show($('tcc-row'), tcc);
    show($('tcc-or'), tcc);
    show($('stale-why'), tcc);
    show($('tcc-end'), !tcc);
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
     The product is a subscription. There is no API key here: the service holds
     the model key. Every price on this screen comes from src/pricing.js through
     onb:getState, so a price is changed in exactly one place. Payments are
     Stripe Managed Payments: Stripe, selling through Link, is the seller, adds
     tax where it applies, and the statement says LINK.COM*. */

  let plan = 'monthly';
  let claiming = false;   // the browser tab is open and /v1/claim is polling
  let busy = false;       // a checkout or activate call is in flight

  const planFacts = id => {
    const p = S && S.plans && S.plans[id];
    return p && typeof p.priceLabel === 'string' ? p : null;
  };
  const countOf = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const commas = n => n.toLocaleString('en-US');
  const TAX = 'plus tax where it applies';
  const MANAGE = 'You can also manage it at link.com, where this purchase is listed as Sold through Link.';

  // False only when this build was never given the service's address. Then
  // nothing on this screen can work, and it says so instead of failing.
  const connected = () => !(S && S.account && S.account.configured === false);
  // engine "cli" in config.json: checks use the Claude CLI's own login, so no
  // Grayout plan (and no key) is needed and Continue is enough.
  const usesCli = () => !!(S && S.engine === 'cli');

  function subStatus(text, cls) {
    const el = $('sub-status');
    el.classList.remove('status-good', 'status-bad');
    setText(el, text);
    if (cls) el.classList.add(cls === 'ok' ? 'status-good' : 'status-bad');
  }

  function syncPlanButtons() {
    const locked = claiming || busy || !connected();
    $('btn-subscribe').disabled = locked;
    $('btn-free').disabled = locked;
    $('btn-have-key').disabled = !connected();
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
        ? `${m.trialDays}-day free trial, then ${m.priceLabel} ${m.periodLabel} ${TAX}. Cancel any time.`
        : `${TAX[0].toUpperCase()}${TAX.slice(1)}. Cancel any time.`);
    }
    if (y) {
      const off = Number.isFinite(y.savingsPercent) ? `, ${y.savingsPercent}% off` : '';
      setText($('price-yearly'), `${y.priceLabel} ${y.periodLabel}`);
      setText($('note-yearly'), y.perMonthLabel
        ? `${y.perMonthLabel} a month, billed yearly${off}, ${TAX}.`
        : `Billed yearly${off}, ${TAX}.`);
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
    const cli = usesCli();
    setText($('plan-existing'), cli
      ? 'Grayout is set to check through the Claude CLI on your Claude subscription (engine "cli" in config.json), so no Grayout plan or key is needed. Continue.'
      : has
        ? `This Mac already has a license key${acct.licenseMasked ? ` (${acct.licenseMasked})` : ''}. Continue to use it.`
        : '');
    show($('plan-unavailable'), !cli && !connected());
    // Mac App Store: the free checks lead and Subscribe follows, so the first
    // run never reads as a paywall (App Review 2.4.5(vi)), and there is no
    // license box on this screen at all.
    const mas = isMAS();
    $('btn-free').classList.toggle('btn-primary', mas);
    $('btn-subscribe').classList.toggle('btn-primary', !mas);
    $('btn-subscribe').classList.toggle('btn-secondary', mas);
    if (mas) $('plan-group').before($('free-card'));
    const licenseHere = feature('licenseInOnboarding');
    show($('license-block'), licenseHere);
    if (!licenseHere) { show($('license-row'), false); $('license').value = ''; }
    // Without a service there is nothing to choose here, so setup goes on.
    show($('btn-3-continue'), cli || has || !connected());

    for (const r of document.querySelectorAll('input[name="plan"]')) r.checked = r.value === plan;
    subStatus('');
    syncPlanButtons();
  }

  function detailOf(r) {
    return r && typeof r.message === 'string' ? r.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  }

  // Messages for the failures every call on this screen can hit.
  function commonMessage(r) {
    const kind = r && r.kind;
    if (kind === 'network') return 'Could not reach the Grayout service. Check your connection and try again.';
    if (kind === 'not_connected') return 'This build of Grayout is not connected to the Grayout service yet.';
    if (kind === 'device_unverified') return 'Grayout could not register this Mac with the service. Try again later.';
    if (kind === 'secrets_locked') return detailOf(r) || 'Grayout could not unlock its saved keys in the macOS Keychain. Quit and reopen Grayout, and choose Always Allow.';
    if (kind === 'not_configured' || kind === 'overloaded') return 'The Grayout service is not ready right now. Try again in a few minutes.';
    if (kind === 'rate_limited') return 'Too many tries just now. Wait a minute and try again.';
    // The service's own sentence names the support address to write to.
    if (kind === 'license_revoked') return detailOf(r) || 'This subscription was refunded or disputed.';
    return '';
  }

  function checkoutMessage(r) {
    const common = commonMessage(r);
    if (common) return common;
    const detail = detailOf(r);
    return detail ? `Checkout did not start: ${detail}` : 'Checkout did not start. Try again.';
  }

  // "Already subscribed" is good news, not an error: nothing was charged.
  function alreadySubscribedMessage(r) {
    return [
      detailOf(r) || 'This Mac already has a Grayout subscription, so nothing new was charged.',
      r.restored ? 'Its license key is back on this Mac.' : '',
      r.opened ? 'The billing page is open in your browser if you want to change or cancel it.' : '',
      r.manageNote || MANAGE
    ].filter(Boolean).join(' ');
  }

  function claimMessage(r) {
    const kind = r && r.kind;
    // Never tell somebody who may have paid to pay again. A checkout page left
    // open in the browser can still be paid after Grayout stops waiting, so a
    // new one is only started after the old tab is closed: two open checkouts
    // could both be paid.
    if (kind === 'timeout') return 'Grayout stopped waiting for the checkout. If you finished paying, your key arrives by itself the next time Grayout opens or you open Settings. If not, close that checkout tab first, then press Subscribe to start again, so you are only charged once.';
    if (kind === 'code_expired') return 'That checkout link has expired. If you finished paying, your key arrives by itself the next time you open Settings. If not, press Subscribe to start again.';
    if (kind === 'payment_failed') return 'The payment did not go through, so nothing was charged. Press Subscribe to try again.';
    if (kind === 'checkout_expired') return 'That checkout expired before it was finished. Press Subscribe to start again.';
    if (kind === 'network') {
      return `Grayout lost its connection while waiting. If you finished paying, your key arrives by itself the next time you open Settings${feature('licenseInOnboarding') ? ', or paste it below' : ''}.`;
    }
    const common = commonMessage(r);
    if (common) return common;
    const detail = detailOf(r);
    return detail || 'Checkout did not finish. Press Subscribe to try again.';
  }

  function activateMessage(r) {
    const kind = r && r.kind;
    if (kind === 'license_invalid') return 'That license key is not one Grayout issued. Check it for missing characters.';
    if (kind === 'no_license') return 'Paste your license key first.';
    const common = commonMessage(r);
    if (common) return common;
    const detail = detailOf(r);
    return detail || 'That key could not be activated.';
  }

  /** What to say while the browser checkout is open. */
  function waitingMessage(r) {
    const first = r.reused
      ? 'Your checkout is still open, so Grayout reopened that same page instead of starting a second one.'
      : 'Finish in your browser.';
    // `trial` is the service's answer for this checkout, so somebody who
    // already had a trial is told before paying that no new one applies.
    const trial = r.plan === 'monthly'
      ? (r.trial ? ' This checkout starts with a free trial.' : ' This checkout has no free trial, because this Mac or its subscription already had one.')
      : '';
    return `${first}${trial} This window unlocks itself the moment the payment goes through.`;
  }

  async function subscribe() {
    if (claiming || busy || !connected()) return;
    busy = true;
    syncPlanButtons();
    subStatus('Opening checkout in your browser…');
    let r;
    try { r = await api.startCheckout(plan); } catch (e) { r = { ok: false, kind: 'unknown', message: e && e.message }; }
    busy = false;
    if (r && r.kind === 'already_subscribed') {
      await refreshState();
      syncPlanButtons();
      const has = !!(S && S.account && S.account.hasLicense);
      show($('btn-3-continue'), has);
      subStatus(alreadySubscribedMessage(r), has ? 'ok' : null);
      return;
    }
    if (!r || !r.ok) { syncPlanButtons(); subStatus(checkoutMessage(r), 'err'); return; }
    if (r.opened === false) {
      syncPlanButtons();
      subStatus(feature('licenseInOnboarding')
        ? 'Grayout could not open your browser. Subscribe on the Grayout site instead, then paste the license key below.'
        : feature('manualLicenseEntry')
          ? 'Grayout could not open your browser. Subscribe on the Grayout site instead, then use Connect an existing subscription in Settings under Your plan.'
          : 'Grayout could not open your browser. Check that macOS has a default browser, then press Subscribe again.', 'err');
      return;
    }

    claiming = true;
    syncPlanButtons();
    subStatus(waitingMessage(r));
    let c;
    try { c = await api.pollClaim(r.deviceCode); } catch (e) { c = { ok: false, kind: 'unknown', message: e && e.message }; }
    claiming = false;
    syncPlanButtons();

    if (c && c.ok) {
      await refreshState();
      subStatus(c.status === 'trialing' ? 'Your free trial has started. Grayout is ready.' : 'Subscribed. Grayout is ready.', 'ok');
      go(4);
      return;
    }
    // Only the waiting stopped. The page in the browser can still be paid, and
    // pressing Subscribe again reopens it rather than starting a second one.
    if (c && c.kind === 'cancelled') { subStatus('Stopped waiting. The checkout page is still open in your browser: press Subscribe to pick it up again rather than starting a new one.'); return; }
    subStatus(claimMessage(c), 'err');
  }

  function cancelCheckout() {
    // pollClaim resolves with kind 'cancelled'; subscribe() says what that means.
    swallow(api.cancelClaim());
  }

  async function startFree() {
    if (claiming || busy || !connected()) return;
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
    if (!key || claiming || busy || !connected()) return;
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
      // A canceled or lapsed key still activates; the service then says
      // service: false. Say so rather than pretending all is well.
      if (r.service === false) {
        show($('btn-3-continue'), true);
        subStatus(`That key is saved on this Mac, but its subscription is not active right now. Update the payment in Settings under Your plan. ${MANAGE}`, 'err');
        return;
      }
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
    const cli = usesCli();
    for (const sec of [30, 45, 90]) {
      const row = est[sec];
      if (cli) {
        setText($(`est-${sec}`), 'no per-check charge');
      } else if (hosted) {
        setText($(`est-${sec}`), row && Number.isFinite(row.checks) ? `about ${commas(row.checks)} checks a day` : '');
      } else {
        const d = row && money(row.daily);
        setText($(`est-${sec}`), d ? `about ${d} a day` : 'estimate unavailable');
      }
    }
    if (cli) {
      setText($('est-note'), "Checks run through the Claude CLI on your Claude subscription, so there is no per-check charge. Each check counts toward the plan's usage limits.");
    } else if (hosted) {
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
    if (!consentGranted()) {
      // Never finish setup without the consent card's answer.
      go(1);
      consentStatus('Allow Grayout to send screenshots for checks first. Nothing is captured until you do.', 'err');
      return;
    }
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
  $('btn-consent-allow').addEventListener('click', allowConsent);
  $('btn-consent-later').addEventListener('click', declineConsent);
  $('btn-1-continue').addEventListener('click', () => { if (consentGranted()) go(2); });

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
    // Return never gives consent; it only moves on once consent is given.
    if (step === 1) { if (consentGranted() && !consentOnlyMode) go(2); else handled = false; }
    else if (step === 2) { if (!$('btn-2-continue').disabled) go(3); else handled = false; }
    else if (step === 3) {
      if (claiming || busy) handled = false;
      else if (!connected()) go(4);
      else if (feature('licenseInOnboarding') && $('license').value.trim()) activateLicense();
      else if (isMAS()) startFree();
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
    consentOnlyMode = S.completed === true && !consentGranted();
    const resume = Number.isInteger(S.step) ? S.step : 1;
    go(consentOnlyMode ? 1 : resume, { silent: true });
  })();
})();
