/* Grayout for Mac — site behaviour.
   External rather than inline because the pages ship a strict CSP.
   No third-party code, no analytics, no cookies. The only network call this
   file can make is to the Grayout API, and only when someone clicks a plan. */

'use strict';

/* The one place the API lives. See docs/API-CONTRACT.md. */
const API_BASE = 'https://api.grayout.app';

/* Where a checkout URL is allowed to send someone. */
const REDIRECT_HOSTS = ['checkout.stripe.com', 'billing.stripe.com', 'api.grayout.app', 'grayout.app'];

/* Tell the stylesheet JS is alive, before first paint, so the scroll-reveal
   start state does not flash for people without it. */
document.documentElement.classList.add('js');

/* ------------------------------------------------------------ utilities */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function randomHex(byteCount) {
  const a = new Uint8Array(byteCount);
  window.crypto.getRandomValues(a);
  let out = '';
  for (let i = 0; i < a.length; i++) out += a[i].toString(16).padStart(2, '0');
  return out;
}

/* A 128-bit install id, the web half of the deviceId in the contract. It is
   created the first time somebody clicks a plan, never on a plain visit, and
   it is a random number with nothing about the machine hashed into it. */
function deviceId() {
  const KEY = 'grayout.deviceId';
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored && /^[0-9a-f]{32}$/.test(stored)) return stored;
    const fresh = randomHex(16);
    window.localStorage.setItem(KEY, fresh);
    return fresh;
  } catch (err) {
    return randomHex(16);
  }
}

function safeRedirect(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch (err) { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (REDIRECT_HOSTS.indexOf(parsed.hostname) === -1) return false;
  window.location.href = parsed.href;
  return true;
}

/* Server text is never trusted as markup and never allowed to run long. */
function oneLine(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 180 ? t.slice(0, 177) + '…' : t;
}

function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(function () { controller.abort(); }, timeoutMs || 12000);
  const opts = Object.assign({ signal: controller.signal, mode: 'cors', credentials: 'omit' }, options || {});
  return fetch(url, opts).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (body) {
      return { ok: res.ok, status: res.status, body: body };
    });
  }).finally(function () { window.clearTimeout(timer); });
}

/* ------------------------------------------------------------------ nav */

function initNav() {
  const nav = $('[data-nav]');
  if (!nav) return;
  let ticking = false;
  function apply() {
    nav.classList.toggle('is-condensed', window.scrollY > 24);
    ticking = false;
  }
  apply();
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(apply);
  }, { passive: true });
}

/* -------------------------------------------------------- scroll reveal */

function initReveal() {
  const items = $$('.reveal');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('is-in'); });
    return;
  }
  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
  items.forEach(function (el) { io.observe(el); });
}

/* ---------------------------------------------------------------- stage */

/* The looping mock only animates while somebody can see it. */
function initStage() {
  const stage = $('.stage');
  if (!stage) return;
  if (!('IntersectionObserver' in window)) return;
  stage.classList.add('is-paused');
  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      stage.classList.toggle('is-paused', !entry.isIntersecting);
    });
  }, { threshold: 0.15 });
  io.observe(stage);
}

/* -------------------------------------------------------------- pricing */

function initPricing() {
  const plans = $('[data-plans]');
  const switches = $$('[data-billing]');
  if (!plans || !switches.length) return;

  function select(period) {
    const yearly = period === 'yearly';
    plans.classList.toggle('is-yearly', yearly);
    switches.forEach(function (btn) {
      const on = btn.getAttribute('data-billing') === period;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $$('[data-plan-button]').forEach(function (btn) {
      btn.setAttribute('data-checkout', yearly ? 'yearly' : 'monthly');
    });
  }

  switches.forEach(function (btn) {
    btn.addEventListener('click', function () { select(btn.getAttribute('data-billing')); });
  });
  select('monthly');
}

/* ------------------------------------------------------------- checkout */

function noteFor(button) {
  const id = button.getAttribute('data-note');
  return id ? document.getElementById(id) : null;
}

function showNote(note, message) {
  if (!note) return;
  const msg = $('.msg', note);
  if (msg) msg.textContent = message;
  note.hidden = false;
}

function initCheckout() {
  const buttons = $$('[data-checkout]');
  if (!buttons.length) return;

  buttons.forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.preventDefault();
      const plan = button.getAttribute('data-checkout') === 'yearly' ? 'yearly' : 'monthly';
      const note = noteFor(button);
      if (note) note.hidden = true;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');

      fetchJson(API_BASE + '/v1/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId(), plan: plan })
      }, 12000).then(function (res) {
        if (res.ok && res.body && safeRedirect(res.body.url)) return;
        const err = res.body && res.body.error;
        showNote(note, res.ok
          ? 'Checkout is not live yet.'
          : oneLine(err && err.message, 'Checkout is not live yet.'));
      }).catch(function () {
        showNote(note, 'Checkout is not live yet.');
      }).finally(function () {
        button.classList.remove('is-busy');
        button.removeAttribute('aria-busy');
      });
    });
  });
}

/* -------------------------------------------------- success.html: claim */

/* The app claims its own license: it made a device code before it opened this
   tab and polls GET /v1/claim with it. A purchase that started here, in a
   browser, has no device code, so this page claims by Checkout Session id
   instead (GET /v1/claim?sessionId=, see docs/API-CONTRACT.md). The webhook
   that issues the license can land a second or two after the redirect, so a
   `pending` answer is retried a few times before the page gives up gracefully.
   Either way the app unlocks itself; the key box is only for someone who needs
   to paste it somewhere. */
var CLAIM_TRIES = 6;
var CLAIM_WAIT_MS = 3000;

function initClaim() {
  const box = $('[data-claim]');
  if (!box) return;

  const status = $('.claim-status', box);
  const keyEl = $('.key', box);
  const copyBtn = $('[data-copy]', box);
  const row = $('.claim-row', box);

  function setStatus(text) { if (status) status.textContent = text; }
  function hideKey() {
    if (keyEl) keyEl.hidden = true;
    if (row) row.hidden = true;
  }
  function settle() {
    setStatus('No key to show here, which is normal. Grayout claims the license itself, so open the app and it unlocks within a few seconds.');
  }

  hideKey();

  let sessionId = '';
  try {
    sessionId = new URLSearchParams(window.location.search).get('session_id') || '';
  } catch (err) {
    sessionId = '';
  }

  if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) {
    setStatus('This link has no checkout session on it. Open Grayout and it will pick up the subscription on its own.');
    return;
  }

  setStatus('Looking for your license key\u2026');

  function attempt(left) {
    fetchJson(API_BASE + '/v1/claim?sessionId=' + encodeURIComponent(sessionId), { method: 'GET' }, 9000)
      .then(function (res) {
        const body = res.ok && res.body ? res.body : null;
        const license = body && typeof body.license === 'string' ? body.license : '';
        if (body && body.status === 'ready' && /^gry_live_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/.test(license)) {
          if (keyEl) { keyEl.textContent = license; keyEl.hidden = false; }
          if (row) row.hidden = false;
          setStatus('Grayout should already be unlocked. This key is here only if you need to paste it somewhere.');
          return;
        }
        // `pending` means the webhook has not landed yet. Anything else is a
        // dead end for this page, and the app is still the real path.
        if (body && body.status === 'pending' && left > 1) {
          window.setTimeout(function () { attempt(left - 1); }, CLAIM_WAIT_MS);
          return;
        }
        settle();
      })
      .catch(settle);
  }

  attempt(CLAIM_TRIES);

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      const label = $('.copy-label', copyBtn) || copyBtn;
      const text = keyEl ? keyEl.textContent : '';
      if (!text) return;
      const done = function (ok) {
        label.textContent = ok ? 'Copied' : 'Select the key above and copy it';
        window.setTimeout(function () { label.textContent = 'Copy key'; }, 2400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  }
}

/* ------------------------------------------------------------------ go */

/* Each step is isolated: a failure in one must never leave the scroll-reveal
   sections stuck at opacity 0, which is the only way this file can hide
   content that would otherwise be readable. */
function boot() {
  [initReveal, initNav, initStage, initPricing, initCheckout, initClaim].forEach(function (step) {
    try {
      step();
    } catch (err) {
      /* Nothing to report to; the page stays usable without this piece. */
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
