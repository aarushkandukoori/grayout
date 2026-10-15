/*
 * Grayout site configuration. This is the only file to edit when the service
 * goes live (API contract v3, section 3). Nothing else on the site names the
 * API host.
 *
 * GRAYOUT_API_BASE: the deploy step replaces the placeholder with the Worker's
 * origin, e.g. https://grayout-api.<your-subdomain>.workers.dev. The
 * placeholder is deliberately not a URL, so a site that was never filled in
 * makes no network calls at all. Never use api.grayout.app until that domain
 * is owned and pointed at the Worker.
 *
 * ORDER MATTERS. Fill in GRAYOUT_API_BASE only after a 2.x build is the
 * "latest" release on GitHub. A filled-in apiBase switches the whole site to
 * "100 checks free, no card, no account, no API key", but every Download
 * button fetches releases/latest. While that is still 1.0.1 (which only runs
 * on your own API key), the site would promise free checks the download
 * cannot give. Publish the 2.x release first, then fill this in.
 *
 * The page CSP allows https://*.workers.dev for connect-src. If the API ever
 * moves to another host (a bought domain), add that origin to the CSP meta tag
 * on every page as well.
 */
window.GRAYOUT_API_BASE = '__GRAYOUT_API_BASE__';

window.GRAYOUT_CONFIG = {
  // Same value as above; read by app.js. '' or the placeholder = service off.
  apiBase: window.GRAYOUT_API_BASE,

  // true once Stripe live mode, the prices and the webhook are set up.
  // While false, every purchase button becomes a working download link.
  // Checkout also stays off until supportEmail below is filled in: the refund
  // policy promises refunds that only an email address can grant.
  checkoutLive: false,

  // Optional. Stripe Dashboard > Settings > Billing > Customer portal >
  // "Login link" (https://billing.stripe.com/p/login/...). Shown on
  // account.html as "Open the billing portal" when set.
  portalLoginUrl: '',

  // Needed before launch: a real, watched support address (the same one as
  // in Stripe's business details). Shown on the account, terms, refunds and
  // privacy pages when set. checkoutLive does nothing while this is empty.
  supportEmail: '',

  // Leave false unless the service answers browsers on POST /v1/portal
  // (contract v3 section 5 lists only health, device, checkout and claim as
  // CORS routes). When true, account.html shows "paste your license key".
  licensePortal: false,

  // The Mac App Store listing ("Grayout: Back to Work", United States
  // storefront only). Leave '' until App Store Connect says "Ready for
  // Distribution" AND the URL opens in a signed-out browser. While it is '',
  // every "Download on the Mac App Store" link and the Apple trademark credit
  // stay hidden. Only https://apps.apple.com/.../id<digits> URLs are accepted;
  // anything else is ignored. Shape:
  // https://apps.apple.com/us/app/grayout-back-to-work/id0000000000?mt=12
  masUrl: ''
};
