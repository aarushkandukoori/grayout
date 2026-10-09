/*
 * account.html only: paste a license key to open the Stripe billing portal.
 * POST /v1/portal (API contract v3, section 6.10). Loaded with defer after
 * app.js, which provides window.Grayout (config, the one fetch wrapper, and
 * small helpers). The form only shows when config.js turns licensePortal on.
 */
(function () {
  'use strict';

  var G = window.Grayout;
  var form = document.querySelector('[data-license-form]');
  if (!G || !form) return;

  var input = form.querySelector('input');
  var btn = form.querySelector('button[type="submit"]');
  var msg = form.querySelector('[data-license-msg]');
  var LINK = { text: 'link.com', href: 'https://link.com' };

  // People paste keys with spaces, line breaks or the wrong letter case.
  function normalizeLicense(v) {
    var s = String(v || '').replace(/\s+/g, '');
    var m = /^gry_(live|test)_(.+)$/i.exec(s);
    if (!m) return s;
    return 'gry_' + m[1].toLowerCase() + '_' + m[2].toUpperCase();
  }

  input.addEventListener('input', function () { input.removeAttribute('aria-invalid'); G.setMessage(msg, ''); });

  // Back button from the Stripe portal: the browser can restore this page from
  // its back/forward cache with the button still disabled and saying "Opening
  // the portal...". Put the button back so the visitor can try again.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    G.setBusy(btn, false);
    G.setMessage(msg, '');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (btn.getAttribute('aria-busy') === 'true') return;
    if (!G.cfg.apiBase || !G.cfg.licensePortal) { G.setMessage(msg, ['Use Manage subscription in the Grayout menu, or link.com.'], true); return; }
    var key = normalizeLicense(input.value);
    if (!G.LICENSE_RE.test(key)) {
      input.setAttribute('aria-invalid', 'true');
      G.setMessage(msg, ['That does not look like a Grayout license key. It starts with gry_live_ and has 24 more letters and digits.'], true);
      input.focus();
      return;
    }
    G.setBusy(btn, true, 'Opening the portal...');
    G.deviceCall('/v1/portal', { license: key }, { timeout: 12000 }).then(function (r) {
      if (r.ok && r.body && typeof r.body.url === 'string' && G.safeRedirect(r.body.url, G.PORTAL_HOSTS)) {
        input.value = '';
        return;
      }
      G.setBusy(btn, false);
      var parts;
      switch (r.code) {
        case 'license_invalid': parts = ['That license key is not one Grayout issued. Check for a missing character.']; input.setAttribute('aria-invalid', 'true'); break;
        case 'license_revoked': parts = ['This subscription was refunded or disputed. '].concat(G.supportParts('Email ')); break;
        case 'rate_limited': parts = ['Too many tries from this network. Wait a minute and try again.']; break;
        case 'device_unverified': parts = ['Grayout could not register this browser with the service. Try again later.']; break;
        case 'not_configured': parts = ['The billing portal is not available right now. You can still manage the subscription at ', LINK, '.']; break;
        default: parts = r.network
          ? ['Could not reach the billing service from this page. Use Manage subscription in the Grayout menu, or ', LINK, '.']
          : ['The portal did not open. Try again in a moment.'];
      }
      G.setMessage(msg, parts, true);
      G.announce(msg.textContent);
    });
  });
})();
