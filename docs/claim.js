/*
 * success.html only: turn a finished Stripe Checkout into a license key.
 * POST /v1/claim { sessionId } (API contract v3, section 6.6). Loaded with
 * defer after app.js, which provides window.Grayout (config, the one fetch
 * wrapper, and small helpers).
 */
(function () {
  'use strict';

  var G = window.Grayout;
  var box = document.querySelector('[data-claim]');
  if (!G || !box) return;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  var SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;
  var states = $$('[data-claim-state]', box);
  var tips = $('[data-tips]');
  // The tips row (menu bar, billing, quitting) is only for someone who just
  // paid. On "nothing to claim", a failed payment and the like it would talk
  // about a subscription that does not exist.
  var PAID_STATES = ['ready', 'pending', 'unreachable', 'trouble'];
  var h1 = $('[data-claim-title]');
  var sub = $('[data-claim-sub]');
  var session = G.storage('sessionStorage');
  var sid = '', fromApp = false;

  var params = new URLSearchParams(location.search);
  if (params.has('session_id') || params.has('from')) {
    sid = params.get('session_id') || '';
    fromApp = params.get('from') === 'app';
    if (session) { try { session.setItem('grayout.claim', JSON.stringify({ sid: sid, fromApp: fromApp })); } catch (e) { /* ignore */ } }
    // The session id is a bearer credential: keep it out of the address bar and history.
    history.replaceState(null, '', location.pathname + location.hash);
  } else if (session) {
    try { var saved = JSON.parse(session.getItem('grayout.claim') || 'null'); if (saved) { sid = saved.sid || ''; fromApp = !!saved.fromApp; } } catch (e) { /* ignore */ }
  }
  $$('[data-from-app]').forEach(function (n) { n.hidden = !fromApp; });

  var TITLES = {
    off: ['Nothing to claim yet', 'This page shows your license key right after checkout. Subscriptions are not open yet.'],
    none: ['Nothing to claim here', 'This page shows your license key right after checkout. Open it from the link Stripe sends you back to.'],
    checking: ['Unlocking Grayout Pro', 'Checking your purchase with the Grayout service. This usually takes a few seconds.'],
    ready: ["You're set.", 'Your license key is below. Paste it into Grayout to unlock Pro.'],
    // A purchase started in the app: the app unlocks without the key.
    readyApp: ["You're set.", 'Grayout on your Mac unlocks itself in a few seconds. The key below is for another Mac.'],
    pending: ['Almost there', 'Your payment went through. Your key is not ready yet.'],
    unreachable: ['Your key is safe', 'We could not reach the Grayout service from this page.'],
    trouble: ['Your key is safe', 'The Grayout service is having trouble right now.'],
    failed: ['The payment did not finish', 'Stripe did not complete this purchase, so nothing was charged for it.'],
    expired: ['This link has expired', 'This checkout link is no longer claimable.'],
    revoked: ['This subscription ended', 'It was refunded or disputed, so its license no longer works.'],
    badlink: ['This link looks incomplete', 'The checkout id in the link is missing or damaged.']
  };

  function show(name, data) {
    states.forEach(function (n) { n.hidden = n.getAttribute('data-claim-state') !== name; });
    if (tips) tips.hidden = PAID_STATES.indexOf(name) === -1;
    var t = (name === 'ready' && fromApp ? TITLES.readyApp : TITLES[name]) || TITLES.none;
    if (h1) h1.textContent = t[0];
    if (sub) sub.textContent = t[1];
    document.title = t[0] + ' | Grayout';
    box.setAttribute('aria-busy', name === 'checking' ? 'true' : 'false');
    if (name === 'ready') {
      $('[data-license]', box).textContent = data;
      G.announce('Your license key is ready.');
    }
    if (name === 'failed' && data) {
      var r = $('[data-fail-reason]', box);
      if (r) r.textContent = data === 'expired' ? 'The checkout page expired before payment.' : 'The payment was declined or could not be completed.';
    }
  }

  // Every "Reload this page" button (the pending, unreachable and trouble states each have one).
  $$('[data-claim-retry]', box).forEach(function (b) { b.addEventListener('click', function () { window.location.reload(); }); });

  if (!G.cfg.apiBase) { show('off'); return; }
  if (!sid) { show('none'); return; }
  if (!SESSION_RE.test(sid)) { show('badlink'); return; }

  show('checking');
  var DELAYS = [0, 2, 2, 3, 5, 8, 10];
  var started = Date.now();
  var attempt = 0;
  // What the most recent answer was, so the 120 s timeout says the right thing:
  // 'pending' only after a real { status: 'pending' }, 'trouble' after a server
  // error (5xx, rate limiting, an unexpected answer), 'unreachable' when the
  // request never got an answer at all.
  var last = 'unreachable';
  var shown = 'checking';
  function showOnce(name) { if (shown !== name) { shown = name; show(name); } }

  function next(extraWait) {
    var d = attempt >= DELAYS.length ? 10000 : DELAYS[attempt] * 1000;
    d = Math.max(d, (extraWait || 0) * 1000);
    if (Date.now() + d - started > 120000) { show(last); return; }
    attempt++;
    setTimeout(tryOnce, d);
  }

  function tryOnce() {
    G.api('/v1/claim', { sessionId: sid }, { timeout: 10000 }).then(function (r) {
      if (r.ok && r.body) {
        var st = r.body.status;
        if (st === 'ready' && typeof r.body.license === 'string' && G.LICENSE_RE.test(r.body.license)) { show('ready', r.body.license); return; }
        if (st === 'failed') { show('failed', r.body.reason); return; }
        last = st === 'pending' ? 'pending' : 'trouble';
        next(0); return;
      }
      if (r.code === 'bad_request') { show('badlink'); return; }
      if (r.code === 'code_expired') { show('expired'); return; }
      if (r.code === 'license_revoked') { show('revoked'); return; }
      // The service is missing a secret or a Stripe setting (contract 8): no retry will fix that
      // within the 120 s window, so say so now instead of spinning.
      if (r.code === 'not_configured') { show('trouble'); return; }
      if (r.code === 'rate_limited') {
        // The service did answer, so a timeout here must never claim it could
        // not be reached. Keep a real 'pending' if one came before.
        if (last !== 'pending') last = 'trouble';
        next(r.retryAfter || 10); return;
      }
      if (r.status >= 500) {
        // A server error: show it now (with its reload button) instead of a
        // spinner that says Stripe is being asked, and keep trying quietly.
        // A later ready answer still replaces it.
        last = 'trouble';
        showOnce('trouble');
        next(0); return;
      }
      last = r.status ? 'trouble' : 'unreachable'; // another error answer, or no answer
      next(0); // keep backing off until 120 s
    });
  }
  tryOnce();
})();
