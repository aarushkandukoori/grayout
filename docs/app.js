/*
 * Grayout site: config, page state, shared UI, and every call to the Grayout
 * service (API contract v3, docs/API-CONTRACT.md). No other file talks to the
 * network. Loaded synchronously in <head> right after config.js so the page
 * state is set before first paint; everything that touches the DOM waits for
 * DOMContentLoaded.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  /* ------------------------------------------------------------------ */
  /* Config                                                              */
  /* ------------------------------------------------------------------ */

  var RAW = window.GRAYOUT_CONFIG || {};

  function parseBase(value) {
    if (typeof value !== 'string' || !value) return '';
    var u;
    try { u = new URL(value); } catch (e) { return ''; } // the placeholder lands here
    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
    if (u.username || u.password || u.search || u.hash) return '';
    return (u.origin + u.pathname).replace(/\/+$/, '');
  }

  function parseHttpsUrl(value, hosts) {
    if (typeof value !== 'string' || !value) return '';
    try {
      var u = new URL(value);
      if (u.protocol !== 'https:') return '';
      if (hosts && hosts.indexOf(u.hostname) === -1) return '';
      return u.href;
    } catch (e) { return ''; }
  }

  var EMAIL_RE = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  var CHECKOUT_HOSTS = ['checkout.stripe.com'];
  var PORTAL_HOSTS = ['billing.stripe.com'];

  // The Mac App Store listing: only a real product page on apps.apple.com,
  // e.g. https://apps.apple.com/us/app/grayout-back-to-work/id1234567890?mt=12.
  // Anything else (another host, http, a search page, a typo) gives '' and the
  // App Store links stay hidden, so a bad edit can never send people elsewhere.
  var MAS_HOSTS = ['apps.apple.com'];
  var MAS_PATH_RE = /^\/(?:[a-z]{2}\/)?app\/(?:[^\/]+\/)?id\d{6,12}$/;
  function parseMasUrl(value) {
    var href = parseHttpsUrl(value, MAS_HOSTS);
    if (!href) return '';
    var u = new URL(href);
    if (u.username || u.password || u.port || u.hash) return '';
    return MAS_PATH_RE.test(u.pathname) ? u.href : '';
  }

  var CFG = {
    apiBase: parseBase(RAW.apiBase || window.GRAYOUT_API_BASE),
    checkoutLive: RAW.checkoutLive === true,
    portalLoginUrl: parseHttpsUrl(RAW.portalLoginUrl, PORTAL_HOSTS),
    supportEmail: (typeof RAW.supportEmail === 'string' && EMAIL_RE.test(RAW.supportEmail.trim())) ? RAW.supportEmail.trim() : '',
    licensePortal: RAW.licensePortal === true,
    masUrl: parseMasUrl(RAW.masUrl)
  };
  // Selling also needs a support address: the refund policy promises refunds
  // that only an email can grant, so checkout stays off until one is set.
  CFG.live = !!(CFG.apiBase && CFG.checkoutLive && CFG.supportEmail);
  if (CFG.apiBase && CFG.checkoutLive && !CFG.supportEmail && window.console) {
    console.warn('grayout: checkoutLive is on but supportEmail is empty, so checkout stays off. Fill in supportEmail in config.js.');
  }

  root.setAttribute('data-service', CFG.apiBase ? 'on' : 'off');
  root.setAttribute('data-checkout', CFG.live ? 'live' : 'off');
  root.setAttribute('data-support', CFG.supportEmail ? 'on' : 'off');
  root.setAttribute('data-portal', CFG.portalLoginUrl ? 'on' : 'off');
  root.setAttribute('data-licenseportal', (CFG.apiBase && CFG.licensePortal) ? 'on' : 'off');
  root.setAttribute('data-mas', CFG.masUrl ? 'on' : 'off');

  var planFromUrl = null;
  try { planFromUrl = new URLSearchParams(location.search).get('plan'); } catch (e) { /* old browser */ }
  root.setAttribute('data-plan', planFromUrl === 'yearly' ? 'yearly' : 'monthly');

  var reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function on(el, ev, fn, opts) { if (el) el.addEventListener(ev, fn, opts || false); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  // Server text is never rendered as HTML and never trusted to be short.
  function oneLine(value, fallback) {
    var s = (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
    if (!s) return fallback || '';
    return s.length > 180 ? s.slice(0, 177) + '...' : s;
  }

  function storage(kind) {
    try { var s = window[kind]; var k = '__g'; s.setItem(k, '1'); s.removeItem(k); return s; } catch (e) { return null; }
  }

  function safeRedirect(url, hosts) {
    var ok = parseHttpsUrl(url, hosts);
    if (!ok) return false;
    window.location.assign(ok);
    return true;
  }

  function announce(text) {
    var live = $('[data-live]');
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 50);
  }

  // Build a message out of plain strings and {text, href} link parts.
  function setMessage(target, parts, isError) {
    if (!target) return;
    target.textContent = '';
    target.classList.toggle('msg--err', !!isError);
    (Array.isArray(parts) ? parts : [parts]).forEach(function (p) {
      if (p == null) return;
      if (typeof p === 'string') target.appendChild(document.createTextNode(p));
      else if (p.href) target.appendChild(el('a', { href: p.href, class: 'inline-link' }, p.text));
    });
  }

  function supportParts(prefix) {
    if (CFG.supportEmail) return [prefix || 'Email ', { text: CFG.supportEmail, href: 'mailto:' + CFG.supportEmail }, '.'];
    return [prefix ? prefix.replace(/Email $/, 'Open ') : 'Open ', { text: 'a GitHub issue', href: 'https://github.com/aarushkandukoori/grayout/issues' }, ' (never paste a license key or an email address into it).'];
  }

  /* ------------------------------------------------------------------ */
  /* Network: the only fetch on the site                                  */
  /* ------------------------------------------------------------------ */

  function api(path, body, opts) {
    opts = opts || {};
    if (!CFG.apiBase) return Promise.resolve({ ok: false, status: 0, network: true, code: 'not_configured', body: null });
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = opts.timeout || 12000;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : null;
    var init = {
      method: body === undefined ? 'GET' : 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (ctrl) init.signal = ctrl.signal;
    return fetch(CFG.apiBase + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        var err = data && data.error && typeof data.error === 'object' ? data.error : null;
        var retry = err && typeof err.retryAfter === 'number' ? err.retryAfter : parseInt(res.headers.get('Retry-After') || '', 10);
        return {
          ok: res.ok,
          status: res.status,
          body: data,
          code: err && typeof err.code === 'string' ? err.code : (res.ok ? '' : 'http_' + res.status),
          message: err ? oneLine(err.message) : '',
          error: err,
          retryAfter: isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : 0,
          requestId: res.headers.get('X-Grayout-Request-Id') || ''
        };
      });
    }).catch(function (e) {
      return { ok: false, status: 0, network: true, timeout: !!(e && e.name === 'AbortError'), code: '', body: null };
    }).then(function (r) { if (timer) clearTimeout(timer); return r; });
  }

  /* Device identity (contract 4.1): minted by the server, one per browser. */
  var DEV_KEY = 'grayout.device';
  var DEV_ID_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
  var DEV_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  var memDevice = null;
  var local = storage('localStorage');
  if (local) { try { local.removeItem('grayout.deviceId'); } catch (e) { /* v2 leftover */ } }

  function validDevice(d) { return d && DEV_ID_RE.test(d.deviceId) && DEV_TOKEN_RE.test(d.deviceToken); }
  function loadDevice() {
    if (memDevice) return memDevice;
    if (!local) return null;
    try { var d = JSON.parse(local.getItem(DEV_KEY) || 'null'); if (validDevice(d)) { memDevice = d; return d; } } catch (e) { /* corrupt */ }
    return null;
  }
  function saveDevice(d) { memDevice = d; if (local) { try { local.setItem(DEV_KEY, JSON.stringify(d)); } catch (e) { /* quota */ } } }
  function clearDevice() { memDevice = null; if (local) { try { local.removeItem(DEV_KEY); } catch (e) { /* ignore */ } } }

  /* "Pause animations" (WCAG 2.2.2). One switch for every page: .is-still on
     <html> stops the CSS loops, and the JS loops (here and in motion.js) ask
     isStill() and listen through onStill(). Remembered in this browser only. */
  var STILL_KEY = 'grayout.still';
  var still = false;
  var stillFns = [];
  if (local) { try { still = local.getItem(STILL_KEY) === '1'; } catch (e) { still = false; } }
  root.classList.toggle('is-still', still);
  function isStill() { return still; }
  function onStill(fn) { stillFns.push(fn); }
  function setStill(v) {
    still = !!v;
    root.classList.toggle('is-still', still);
    if (local) { try { if (still) local.setItem(STILL_KEY, '1'); else local.removeItem(STILL_KEY); } catch (e) { /* ignore */ } }
    $$('[data-motion-toggle]').forEach(function (b) { b.setAttribute('aria-pressed', still ? 'true' : 'false'); });
    stillFns.forEach(function (fn) { try { fn(still); } catch (e) { /* ignore */ } });
  }

  function ensureDevice(force) {
    if (!force) { var have = loadDevice(); if (have) return Promise.resolve({ ok: true, device: have }); }
    return api('/v1/device', {}, { timeout: 10000 }).then(function (r) {
      if (r.ok && r.body && validDevice(r.body)) {
        var d = { deviceId: r.body.deviceId, deviceToken: r.body.deviceToken };
        saveDevice(d);
        return { ok: true, device: d };
      }
      if (r.ok) { r.ok = false; r.code = 'bad_response'; }
      return { ok: false, res: r };
    });
  }

  // A device-scoped call: mint once, and on device_unverified re-mint once and retry once.
  function deviceCall(path, extra, opts) {
    function call(d) {
      var body = { deviceId: d.deviceId, deviceToken: d.deviceToken };
      Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
      return api(path, body, opts);
    }
    return ensureDevice(false).then(function (m) {
      if (!m.ok) return m.res;
      return call(m.device).then(function (r) {
        if (r.status !== 401 || r.code !== 'device_unverified') return r;
        clearDevice();
        return ensureDevice(true).then(function (m2) {
          if (!m2.ok) return m2.res;
          return call(m2.device).then(function (r2) {
            if (r2.status === 401 && r2.code === 'device_unverified') r2.gaveUp = true;
            return r2;
          });
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Shared UI                                                           */
  /* ------------------------------------------------------------------ */

  function initStatus() {
    var pill = $('[data-status]');
    if (!pill) return;
    var dot = pill.querySelector('.dot');
    var text = pill.querySelector('[data-status-text]');
    function set(kind, label) { dot.className = 'dot dot--' + kind; text.textContent = label; }
    if (!CFG.apiBase) { set('amber', 'Subscriptions opening soon'); return; }
    set('gray', 'Checking the service');
    var run = function () {
      api('/v1/health', undefined, { timeout: 6000 }).then(function (r) {
        if (r.ok && r.body && r.body.ok === true) set('green', CFG.live ? 'Service online' : 'Service online. Subscriptions open soon');
        else set('gray', 'Service unreachable');
      });
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 2500 }); else setTimeout(run, 600);
  }

  function initSupport() {
    if (!CFG.supportEmail) return;
    $$('[data-support-email]').forEach(function (a) {
      a.textContent = CFG.supportEmail;
      if (a.tagName === 'A') a.setAttribute('href', 'mailto:' + CFG.supportEmail);
    });
  }

  function initPortalLink() {
    if (!CFG.portalLoginUrl) return;
    $$('[data-portal-login]').forEach(function (a) { a.setAttribute('href', CFG.portalLoginUrl); });
  }

  // Every "Download on the Mac App Store" link. They sit inside
  // [data-when="mas"], which style.css hides until masUrl is set.
  function initMas() {
    if (!CFG.masUrl) return;
    $$('[data-mas-link]').forEach(function (a) { a.setAttribute('href', CFG.masUrl); });
  }

  /* Mobile sheet (F3) */
  function initSheet() {
    var sheet = $('#sheet');
    var opener = $('[data-sheet-open]');
    if (!sheet || !opener) return;
    var panel = $('.sheet__panel', sheet);
    var lastFocus = null;
    var siblings = function () { return $$('body > *').filter(function (n) { return n !== sheet && n.tagName !== 'SCRIPT'; }); };

    function focusables() { return $$('a[href], button:not([disabled])', panel); }
    function open() {
      lastFocus = document.activeElement;
      sheet.hidden = false;
      siblings().forEach(function (n) { n.setAttribute('inert', ''); });
      opener.setAttribute('aria-expanded', 'true');
      document.body.style.setProperty('overflow', 'hidden');
      requestAnimationFrame(function () { requestAnimationFrame(function () { sheet.classList.add('is-open'); }); });
      setTimeout(function () { var f = focusables()[0]; if (f) f.focus(); }, 60);
    }
    function close() {
      if (sheet.hidden) return;
      sheet.classList.remove('is-open');
      siblings().forEach(function (n) { n.removeAttribute('inert'); });
      opener.setAttribute('aria-expanded', 'false');
      document.body.style.removeProperty('overflow');
      setTimeout(function () { sheet.hidden = true; }, reducedMQ.matches ? 0 : 320);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    on(opener, 'click', open);
    $$('[data-sheet-close]', sheet).forEach(function (b) { on(b, 'click', close); });
    $$('nav a', sheet).forEach(function (a) { on(a, 'click', function () { setTimeout(close, 10); }); });
    on(document, 'keydown', function (e) {
      if (sheet.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        var f = focusables();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    var mq = window.matchMedia('(min-width: 768px)');
    var onMq = function () { if (mq.matches) close(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
  }

  /* Floating CTA (F1): appears once the page's main CTA has scrolled away. */
  function initFloat() {
    var btn = $('[data-float]');
    if (!btn) return;
    var target = $('[data-hero-cta]');
    // While off it is invisible, so it is also out of the tab order and
    // hidden from screen readers (style.css adds visibility:hidden too).
    function set(v) {
      btn.classList.toggle('is-on', v);
      btn.setAttribute('tabindex', v ? '0' : '-1');
      if (v) btn.removeAttribute('aria-hidden'); else btn.setAttribute('aria-hidden', 'true');
    }
    set(false);
    if (target && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { set(!e.isIntersecting && e.boundingClientRect.top < 0); });
      }).observe(target);
    } else {
      var tick = false;
      var check = function () { tick = false; set(window.scrollY > 360); };
      on(window, 'scroll', function () { if (!tick) { tick = true; requestAnimationFrame(check); } }, { passive: true });
      check();
    }
  }

  /* Scroll-in reveals (C) */
  function initReveal() {
    var els = $$('[data-reveal]');
    if (!els.length) return;
    if (reducedMQ.matches || !('IntersectionObserver' in window)) { els.forEach(function (n) { n.classList.add('is-in'); }); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -50px 0px', threshold: 0.01 });
    els.forEach(function (n) { io.observe(n); });
    on(window, 'beforeprint', function () { els.forEach(function (n) { n.classList.add('is-in'); }); });
    // Tab can focus a link whose wrapper sits in the bottom 50 px of the window,
    // where the observer above does not count it as in view yet. Show it now.
    on(document, 'focusin', function (e) {
      var r = e.target && e.target.closest ? e.target.closest('[data-reveal]') : null;
      if (r && !r.classList.contains('is-in')) { r.classList.add('is-in'); io.unobserve(r); }
    });
  }

  /* FAQ accordion (E5, E6) */
  function initFaq() {
    $$('[data-faq]').forEach(function (list, li) {
      $$('.faq__item', list).forEach(function (item, i) {
        var q = $('.faq__q', item), a = $('.faq__a', item);
        if (!q || !a) return;
        var id = 'faq-' + li + '-' + i;
        a.id = id; q.setAttribute('aria-controls', id); q.setAttribute('aria-expanded', 'false');
        a.setAttribute('role', 'region'); a.setAttribute('aria-labelledby', id + '-q'); q.id = id + '-q';
        on(q, 'click', function () {
          var openNow = !item.classList.contains('is-open');
          item.classList.toggle('is-open', openNow);
          q.setAttribute('aria-expanded', openNow ? 'true' : 'false');
        });
      });
      var h = (location.hash || '').replace(/[^#\w-]/g, '');
      if (h.length > 1) {
        var t = null;
        try { t = $(h, list); } catch (e) { t = null; }
        if (t && t.classList.contains('faq__item')) {
          // Show the list now (skipping its reveal slide), open the item, then
          // scroll to it. .faq__item has scroll-margin-top, so it lands with room
          // above it instead of flush against the top of the window.
          var rev = t.closest('[data-reveal]');
          if (rev) { rev.style.setProperty('transition', 'none'); rev.classList.add('is-in'); void rev.offsetWidth; rev.style.removeProperty('transition'); }
          $('.faq__q', t).click();
          requestAnimationFrame(function () {
            try { t.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch (e) { t.scrollIntoView(true); }
          });
        }
      }
    });
  }

  /* Copy buttons */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = el('textarea', { readonly: '', 'aria-hidden': 'true' });
    ta.value = text;
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  function selectNode(node) {
    try {
      var range = document.createRange(); range.selectNodeContents(node);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      if (node.focus) node.focus();
    } catch (e) { /* ignore */ }
  }
  function initCopy() {
    on(document, 'click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-copy]') : null;
      if (!b) return;
      var src = b.getAttribute('data-copy');
      var node = src && src.charAt(0) !== '=' ? $(src) : null;
      var text = node ? node.textContent.trim() : (src || '').slice(1);
      if (!text) return;
      var label = b.querySelector('[data-copy-label]') || b;
      var before = label.textContent;
      copyText(text).then(function (ok) {
        if (ok) {
          b.classList.add('is-done'); label.textContent = 'Copied'; announce('Copied to the clipboard.');
        } else {
          if (node) selectNode(node);
          label.textContent = 'Press Command-C';
          announce('Copy did not work here. The text is selected; press Command-C.');
        }
        setTimeout(function () { b.classList.remove('is-done'); label.textContent = before; }, 1500);
      });
    });
  }

  /* Toast */
  var toastTimer = null;
  function toast(parts, ms) {
    var t = $('[data-toast]');
    if (!t) return;
    setMessage($('[data-toast-text]', t), parts);
    t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms || 9000);
  }
  function hideToast() {
    var t = $('[data-toast]');
    if (!t) return;
    t.classList.remove('is-on');
    setTimeout(function () { if (!t.classList.contains('is-on')) t.hidden = true; }, 400);
  }

  /* Download links: architecture hint, split menu, next-step toast */
  var ARCH_LABEL = { arm64: 'Apple Silicon', x64: 'Intel' };
  var DMG_SIZE = { arm64: '130 MB', x64: '137 MB' }; // the release assets, rounded
  var DMG = {
    arm64: 'https://github.com/aarushkandukoori/grayout/releases/latest/download/Grayout-arm64.dmg',
    x64: 'https://github.com/aarushkandukoori/grayout/releases/latest/download/Grayout-x64.dmg'
  };

  // A phone or tablet: iOS, Android, or an iPad that says "Macintosh" (iPadOS
  // Safari does) but has a touch screen. Real Macs report no touch points.
  // Only these count, so a Mac is never mistaken for one.
  function onPhoneOrTablet() {
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || '';
    if (/Android|iPhone|iPad|iPod/i.test(ua) || /^(Android|iOS)$/i.test(plat)) return true;
    return /Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1;
  }

  function initDownloads() {
    var handheld = onPhoneOrTablet();
    if (handheld) {
      // The main "Download for Mac" buttons go to the download page (which
      // says what Grayout needs) instead of starting a 130 MB DMG on a phone.
      $$('[data-dl-auto]').forEach(function (a) {
        a.setAttribute('href', 'download.html');
        a.removeAttribute('data-dl');
        a.removeAttribute('data-dl-auto');
        var lab = a.querySelector('[data-dl-label]'); if (lab) lab.textContent = 'Download for Mac';
      });
    }
    // Chromium can tell Apple Silicon from Intel. Every other browser keeps the
    // Apple Silicon default, and the button says so ("Download for Apple
    // Silicon"); the caret menu and download.html offer the Intel build.
    if (!handheld && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues && /Mac/.test(navigator.platform || '')) {
      navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (v) {
        var arch = v && v.architecture === 'x86' ? 'x64' : (v && v.architecture === 'arm' ? 'arm64' : '');
        if (!arch) return;
        $$('[data-dl-auto]').forEach(function (a) {
          a.setAttribute('href', DMG[arch]); a.setAttribute('data-dl', arch);
          var lab = a.querySelector('[data-dl-label]'); if (lab) lab.textContent = 'Download for Mac';
        });
        $$('[data-dl-card]').forEach(function (c) { c.classList.toggle('is-mine', c.getAttribute('data-dl-card') === arch); });
        $$('[data-dl-detected]').forEach(function (n) { n.textContent = 'This Mac looks like ' + ARCH_LABEL[arch] + '.'; n.hidden = false; });
      }, function () { /* not allowed */ });
    }

    on(document, 'click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-dl]') : null;
      if (!a) return;
      if (handheld) {
        // Any direct DMG link (the caret menus, the download page's cards).
        e.preventDefault();
        toast(['Grayout is a Mac app. Open this page on your Mac to download it.'], 9000);
        return;
      }
      var arch = a.getAttribute('data-dl');
      var onDownloadPage = root.getAttribute('data-page') === 'download';
      toast(['Downloading Grayout for ' + (ARCH_LABEL[arch] || 'Mac') + ' (about ' + (DMG_SIZE[arch] || '130 MB') + '). Next, open the DMG and drag Grayout to Applications. ',
        onDownloadPage ? { text: 'First launch steps', href: '#first-run' } : { text: 'First launch steps', href: 'download.html#first-run' }], 12000);
    });
    var close = $('[data-toast-close]');
    on(close, 'click', hideToast);

    // Split buttons: caret opens a small menu.
    $$('[data-split]').forEach(function (split) {
      var caret = $('.split__caret', split);
      var menu = $('.menu', split);
      if (!caret || !menu) return;
      function items() { return $$('a, button', menu); }
      function openMenu(focusFirst) {
        menu.hidden = false; caret.setAttribute('aria-expanded', 'true');
        if (focusFirst) { var f = items()[0]; if (f) f.focus(); }
      }
      function closeMenu(refocus) {
        if (menu.hidden) return;
        menu.hidden = true; caret.setAttribute('aria-expanded', 'false');
        if (refocus) caret.focus();
      }
      on(caret, 'click', function (e) { e.stopPropagation(); if (menu.hidden) openMenu(e.detail === 0); else closeMenu(false); });
      on(caret, 'keydown', function (e) { if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(true); } });
      on(menu, 'keydown', function (e) {
        var list = items(); var i = list.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
        else if (e.key === 'Tab') { closeMenu(false); }
      });
      on(menu, 'click', function (e) {
        var b = e.target.closest('button[data-copy]');
        if (b) { setTimeout(function () { closeMenu(true); }, 900); return; }
        if (e.target.closest('a')) closeMenu(false);
      });
      on(document, 'click', function (e) { if (!split.contains(e.target)) closeMenu(false); });
    });
  }

  /* "Preview the gray" (H): the page itself drains for 4 seconds. Runs under reduced motion too, without transitions. */
  function initPreviewGray() {
    var veil = $('.grayveil');
    var buttons = $$('[data-preview-gray]');
    if (!veil || !buttons.length) return;
    var timer = null, active = false;
    function stop() {
      if (!active) return;
      active = false; clearTimeout(timer);
      veil.classList.add('is-off'); veil.classList.remove('is-on'); root.classList.remove('is-gray');
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      announce('Color is back.');
      setTimeout(function () { veil.classList.remove('is-off'); }, 950);
    }
    function start() {
      active = true; veil.classList.remove('is-off'); veil.classList.add('is-on'); root.classList.add('is-gray');
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', 'true'); });
      announce('Page is gray for 4 seconds. Press Escape to restore color.');
      timer = setTimeout(stop, 4000);
    }
    buttons.forEach(function (b) { on(b, 'click', function () { if (active) stop(); else start(); }); });
    on(document, 'keydown', function (e) { if (e.key === 'Escape') stop(); });
  }

  /* Final-CTA keycaps (F5) */
  function initKeys() {
    var keys = $('[data-keys]');
    if (!keys || reducedMQ.matches || !('IntersectionObserver' in window)) return;
    var caps = $$('.keycap', keys), i = 0, timer = null, inView = false;
    function step() {
      caps.forEach(function (c) { c.classList.remove('is-down'); });
      caps[i % caps.length].classList.add('is-down');
      setTimeout(function () { caps.forEach(function (c) { c.classList.remove('is-down'); }); }, 520);
      i++;
    }
    function run() {
      clearInterval(timer); timer = null;
      keys.classList.toggle('is-live', inView && !still);
      if (inView && !still && !document.hidden) { step(); timer = setInterval(step, 1600); }
    }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { inView = e.isIntersecting; run(); });
    }, { threshold: 0.3 }).observe(keys);
    on(document, 'visibilitychange', function () { if (document.hidden) { clearInterval(timer); timer = null; } else run(); });
    onStill(run);
  }

  /* Home cards: below 768 px .trio is a sideways scroller. Tab can land on the
     slider in a card that is mostly off to the side, and the browser counts it
     as in view, so bring the whole card in when the keyboard focuses it. */
  function initTrio() {
    $$('[data-trio]').forEach(function (trio) {
      on(trio, 'focusin', function (e) {
        var t = e.target, card = t && t.closest ? t.closest('.tcard') : null;
        if (!card || trio.scrollWidth <= trio.clientWidth) return;
        try { if (!t.matches(':focus-visible')) return; } catch (err) { /* no :focus-visible: always scroll */ }
        card.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      });
    });
  }

  /* "Pause animations" buttons: every [data-motion-toggle] flips the one switch. */
  function initMotionToggle() {
    var buttons = $$('[data-motion-toggle]');
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', still ? 'true' : 'false');
      on(b, 'click', function () {
        setStill(!still);
        announce(still ? 'Animations paused.' : 'Animations playing.');
      });
    });
  }

  /* Doc pages: heading anchors and the table of contents */
  function initDoc() {
    $$('.prose h2[id], .prose h3[id]').forEach(function (h) {
      if (h.querySelector('.anchor')) return;
      var a = el('a', { class: 'anchor', href: '#' + h.id, 'aria-label': 'Link to this section' }, '#');
      h.insertBefore(a, h.firstChild);
    });
    var toc = $('[data-toc]');
    if (!toc || !('IntersectionObserver' in window)) return;
    var links = $$('a[href^="#"]', toc);
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle('is-active', a === map[e.target.id]); });
      });
    }, { rootMargin: '-10% 0px -70% 0px' });
    Object.keys(map).forEach(function (id) { var h = document.getElementById(id); if (h) io.observe(h); });
  }

  /* ------------------------------------------------------------------ */
  /* Pricing: billing toggle, rolling prices, checkout                   */
  /* ------------------------------------------------------------------ */

  // The price is drawn as columns of digits that roll. Two things keep it
  // readable as text:
  // 1. The whole visual roll is aria-hidden, and a visually hidden sibling
  //    (span.sr-only[data-roll-text]) holds the real price, "$9.99". Screen
  //    readers read that span. (An aria-label on a plain span is not allowed
  //    by ARIA, and NVDA and JAWS often skip it.)
  // 2. The digits and symbols inside the roll come from CSS (::before content
  //    in style.css), not from DOM text. So copy and paste, Cmd+F, reader mode
  //    and crawlers see "$9.99" instead of "0 1 2 3 4 5 6 7 8 9" stacks.
  function rollText(node) {
    var t = node.nextElementSibling;
    if (!t || !t.hasAttribute('data-roll-text')) {
      t = el('span', { class: 'sr-only', 'data-roll-text': '' });
      node.parentNode.insertBefore(t, node.nextSibling);
    }
    return t;
  }

  function buildRoll(node, value) {
    var prev = node.getAttribute('data-value');
    node.setAttribute('data-value', value);
    node.removeAttribute('aria-label');
    node.setAttribute('aria-hidden', 'true');
    rollText(node).textContent = '$' + value;
    var chars = String(value).split('');
    var cols = $$('.roll__col, .roll__sym', node);
    var animate = prev !== null && !reducedMQ.matches;
    if (!animate || cols.length !== chars.length || prev.replace(/\d/g, '0') !== String(value).replace(/\d/g, '0')) {
      node.textContent = '';
      node.classList.add('roll');
      node.appendChild(el('span', { class: 'roll__sym', 'data-ch': '$' }));
      chars.forEach(function (ch, i) {
        if (/\d/.test(ch)) {
          var col = el('span', { class: 'roll__col' });
          // An empty stack: style.css draws the digits 0 to 9 in it with ::before.
          var stack = el('span', { class: 'roll__stack' });
          col.appendChild(stack);
          node.appendChild(col);
          var start = animate ? (prev && /\d/.test(prev.charAt(i)) ? +prev.charAt(i) : 0) : +ch;
          stack.style.setProperty('transform', 'translateY(' + (-1.2 * start) + 'em)');
          if (animate) {
            col.style.setProperty('opacity', '0');
            requestAnimationFrame(function () { requestAnimationFrame(function () {
              col.style.removeProperty('opacity');
              stack.style.setProperty('transform', 'translateY(' + (-1.2 * +ch) + 'em)');
            }); });
          }
        } else {
          node.appendChild(el('span', { class: 'roll__sym', 'data-ch': ch }));
        }
      });
      return;
    }
    // Same shape: roll each column in place.
    var stacks = $$('.roll__stack', node);
    var di = 0;
    chars.forEach(function (ch) {
      if (/\d/.test(ch)) { stacks[di].style.setProperty('transform', 'translateY(' + (-1.2 * +ch) + 'em)'); di++; }
    });
  }

  function initBilling() {
    var rolls = $$('[data-roll]');
    function apply(plan, first) {
      root.setAttribute('data-plan', plan);
      $$('[data-billing] [role="switch"]').forEach(function (s) { s.setAttribute('aria-checked', plan === 'yearly' ? 'true' : 'false'); });
      $$('[data-billing] [data-label]').forEach(function (l) { l.classList.toggle('is-active', l.getAttribute('data-label') === plan); });
      rolls.forEach(function (r) { buildRoll(r, r.getAttribute('data-' + plan)); });
      if (!first) announce(plan === 'yearly' ? 'Yearly billing: 79 dollars a year.' : 'Monthly billing: 9 dollars 99 a month.');
    }
    $$('[data-billing]').forEach(function (g) {
      var sw = $('[role="switch"]', g);
      on(sw, 'click', function () { apply(root.getAttribute('data-plan') === 'yearly' ? 'monthly' : 'yearly'); });
      $$('[data-label]', g).forEach(function (l) {
        on(l, 'click', function () { apply(l.getAttribute('data-label')); });
      });
    });
    apply(root.getAttribute('data-plan'), true);
  }

  // Busy state swaps the label for a spinner and a short line; the original label markup is kept intact.
  function setBusy(btn, busy, label) {
    var lab = $('[data-btn-label]', btn);
    var busyLab = $('[data-busy-label]', btn);
    if (busy) {
      btn.setAttribute('aria-busy', 'true');
      btn.setAttribute('aria-disabled', 'true');
      if (btn.tagName === 'BUTTON') btn.disabled = true;
      if (lab) lab.hidden = true;
      if (!busyLab) {
        busyLab = el('span', { 'data-busy-label': '' });
        btn.appendChild(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
        btn.appendChild(busyLab);
      }
      busyLab.textContent = label || 'Opening checkout...';
    } else {
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-disabled');
      if (btn.tagName === 'BUTTON') btn.disabled = false;
      var sp = $('.spinner', btn); if (sp) sp.remove();
      if (busyLab) busyLab.remove();
      if (lab) lab.hidden = false;
    }
  }

  function checkoutError(r) {
    var dl = { text: 'Download Grayout', href: 'download.html' };
    switch (r.code) {
      case 'already_subscribed': {
        // The server uses this one code for "already subscribed", "a payment
        // needs fixing" and "a payment is still processing", and its message
        // says which. It is plain text (shown with textContent), so use it.
        var portal = r.error && parseHttpsUrl(r.error.portalUrl, PORTAL_HOSTS);
        var lead = oneLine(r.message, 'You already have a Grayout Pro subscription.') + ' ';
        if (portal) {
          return [[lead, { text: 'Manage your subscription', href: portal }, ' on Stripe, or at link.com, where it is listed as sold through Link.'], false];
        }
        return [[lead, { text: 'Ways to manage it', href: 'account.html' }, '.'], false];
      }
      case 'license_revoked':
        return [['This subscription was refunded or disputed. '].concat(supportParts('Email ')), true];
      case 'rate_limited':
        // Under a minute is the per-browser lock (contract 6.5 step 1): a
        // checkout from this browser is already being opened.
        if (r.retryAfter && r.retryAfter < 60) return [['Another checkout is opening. Try again in a few seconds.'], true];
        return [['Too many tries from this network. Try again in ' + (r.retryAfter ? Math.ceil(r.retryAfter / 60) + ' minute' + (r.retryAfter > 60 ? 's' : '') : 'a minute') + '.'], true];
      case 'device_unverified':
        return [['Grayout could not register this browser with the service. Try again later.'], true];
      case 'not_configured':
        return [['Checkout is not available right now. Grayout itself still works: ', dl, '.'], true];
      default:
        if (r.network) return [[r.timeout ? 'Checkout took too long to open. ' : 'Could not reach checkout. ', 'Check your connection and try again.'], true];
        return [['Checkout did not open' + (r.requestId ? ' (request ' + oneLine(r.requestId).slice(0, 40) + ')' : '') + '. Try again in a moment.'], true];
    }
  }

  function initCheckout() {
    var buttons = $$('button[data-buy]');
    buttons.forEach(function (btn) {
      on(btn, 'click', function (e) {
        e.preventDefault();
        if (!CFG.live) { window.location.assign('download.html'); return; }
        if (btn.getAttribute('aria-busy') === 'true') return;
        var plan = btn.getAttribute('data-buy') === 'auto' ? root.getAttribute('data-plan') : btn.getAttribute('data-buy');
        if (plan !== 'monthly' && plan !== 'yearly') plan = 'monthly';
        var scope = btn.closest('[data-checkout-scope]') || btn.parentNode;
        var msg = $('[data-checkout-msg]', scope);
        setMessage(msg, '');
        setBusy(btn, true);
        // One checkout can chain up to four requests (mint the device, check
        // out, re-mint after device_unverified, retry): about 44 s at worst.
        // After 20 s the button comes back; from then on this click is stale,
        // and whatever its requests answer later is ignored, so a late answer
        // never sends the visitor to Stripe behind a newer click's back.
        var stale = false;
        var guard = setTimeout(function () {
          stale = true;
          setBusy(btn, false);
          setMessage(msg, ['Checkout is taking longer than usual. Try again in a moment.'], true);
        }, 20000);
        deviceCall('/v1/checkout', { plan: plan }, { timeout: 12000 }).then(function (r) {
          if (stale) return;
          clearTimeout(guard);
          if (r.ok && r.body && typeof r.body.url === 'string') {
            var stripeUrl = parseHttpsUrl(r.body.url, CHECKOUT_HOSTS);
            if (stripeUrl) {
              setBusy(btn, true, 'Opening Stripe...');
              // The server answers { url, sessionId, trial } (contract 6.5).
              // trial === false on a monthly plan means this browser (or the
              // subscription it already had) used up the free trial, so the
              // Stripe page will charge right away. Say so before leaving,
              // since the button promised "Start 7-day free trial".
              if (plan === 'monthly' && r.body.trial === false) {
                setMessage(msg, ['This browser already used its free trial, so checkout starts the paid plan.'], false);
                announce(msg ? msg.textContent : '');
                setTimeout(function () { safeRedirect(stripeUrl, CHECKOUT_HOSTS); }, 1500);
              } else {
                safeRedirect(stripeUrl, CHECKOUT_HOSTS);
              }
              return;
            }
            r = { ok: false, code: 'bad_redirect' };
          }
          setBusy(btn, false);
          var m = checkoutError(r);
          setMessage(msg, m[0], m[1]);
          announce(msg ? msg.textContent : '');
        });
      });
    });

    // Back button from Stripe. Browsers keep the page in a back/forward cache
    // and restore it exactly as it was when we left, which was "Opening
    // Stripe..." with the button disabled. Nothing else would ever reset it
    // (the 20 s guard was already cleared), so undo the busy state and clear
    // the old message when a page comes back from that cache.
    on(window, 'pageshow', function (e) {
      if (!e.persisted) return;
      buttons.forEach(function (b) { setBusy(b, false); });
      $$('[data-checkout-msg]').forEach(function (m) { setMessage(m, ''); });
    });

    // Back from a cancelled checkout (cancel_url = pricing.html?canceled=1,
    // plus &from=app when the checkout was opened by the app). A visitor from
    // the app only needs to know nothing was charged and that the app is
    // still where they left it, not to be offered the download.
    var params = new URLSearchParams(location.search);
    if (params.get('canceled') === '1') {
      var note = $('[data-canceled]');
      var fromApp = params.get('from') === 'app';
      if (note) {
        $$('[data-canceled-web]', note).forEach(function (n) { n.hidden = fromApp; });
        $$('[data-canceled-app]', note).forEach(function (n) { n.hidden = !fromApp; });
        note.hidden = false;
      }
      params.delete('canceled');
      params.delete('from');
      var q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  // Shared with motion.js and the page-only scripts (claim.js on success.html,
  // account.js on account.html), which load after this file.
  window.Grayout = {
    cfg: CFG,
    reduced: function () { return reducedMQ.matches; },
    announce: announce,
    api: api,
    deviceCall: deviceCall,
    setMessage: setMessage,
    setBusy: setBusy,
    safeRedirect: safeRedirect,
    supportParts: supportParts,
    storage: storage,
    isStill: isStill,
    onStill: onStill,
    PORTAL_HOSTS: PORTAL_HOSTS,
    LICENSE_RE: /^gry_(live|test)_[0-9A-HJKMNP-TV-Z]{24}$/
  };

  function boot() {
    [initStatus, initSupport, initPortalLink, initMas, initSheet, initFloat, initReveal, initFaq, initCopy,
      initDownloads, initPreviewGray, initKeys, initTrio, initMotionToggle, initDoc, initBilling, initCheckout]
      .forEach(function (fn) {
        try { fn(); } catch (e) { if (window.console) console.error('grayout:', fn.name, e); }
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
