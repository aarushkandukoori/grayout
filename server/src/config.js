// Every number and setting the service runs on, in one place.
//
// The values come from docs/API-CONTRACT.md section 13. If you change one here,
// change the contract first: the app and the site read the same numbers.

/** The Stripe API version this code reads. stripe-node 22.6 pins the same one. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

/**
 * A fixed label for this checkout flow. Stripe uses it to tell integrations
 * apart; it was generated once (8 random letters) and never changes.
 */
export const INTEGRATION_IDENTIFIER = 'grayout_pro_kaklnzxs';

export const CONTRACT_VERSION = 3;

export const TRIAL_DAYS = 7;
export const FREE_CHECKS = 100;
/**
 * Free checks one network (an IPv4 address, or an IPv6 /56) may use in a
 * calendar month, however many devices it mints. Three Macs' worth. Without
 * it, re-minting devices gave one network free checks forever.
 */
export const FREE_CHECKS_PER_NETWORK = 300;
/** IPv6 addresses are grouped by this prefix for minting and free checks. */
export const NETWORK_V6_PREFIX_BITS = 56;
/**
 * IPv6 networks are also grouped into bigger blocks of this prefix. One /48
 * holds 256 /56 networks, and some providers hand out a whole /48 for free,
 * so the monthly per-network cap alone would let one person with a /48 use
 * up a day's free budget for everyone.
 */
export const BLOCK_V6_PREFIX_BITS = 48;
/**
 * One IPv6 /48 block may take at most 1/20 of a day's free budget (150 of
 * the default 3,000), but never fewer than one device's 100.
 */
export const FREE_DAILY_SHARE_DIVISOR = 20;
/**
 * Paid checks a month (contract sections 2 and 13). The website and the
 * terms promise this number, so change the contract first, then here, the app
 * (src/pricing.js) and the site together.
 */
export const INCLUDED_CHECKS = 10000;
/**
 * Checks a month while the subscription is still a free trial. A real week of
 * use is under 1,000; a card that only ever takes trials costs pennies.
 */
export const TRIAL_CHECKS = 1000;
/** Past the monthly allowance, one check per this many seconds. */
export const OVER_ALLOWANCE_INTERVAL_SECONDS = 600;
/** Service keeps going this long after the paid period ends. */
export const GRACE_SECONDS = 3 * 86400;
/** How long a device code (and a Checkout Session) lives. */
export const DEVICE_CODE_TTL_SECONDS = 3600;
/**
 * Device codes one device may hold at once (unexpired). The app reuses an
 * open checkout, so a real buyer needs one or two an hour. Without a cap, one
 * device on many IPv6 addresses could write rows without end.
 */
export const MAX_LIVE_DEVICE_CODES = 5;
/** /v1/claim asks Stripe about one session at most this often. */
export const SESSION_RECHECK_SECONDS = 10;
/**
 * Before refusing a license, re-read Stripe if the row is older than this.
 * Also the least time between two Stripe reads for one license, even when the
 * read fails, so a broken read cannot turn every request into a Stripe call.
 */
export const DENY_RECHECK_SECONDS = 900;
/** /v1/status and /v1/activate re-read Stripe when the row is older than this. */
export const STALE_SYNC_SECONDS = 86400;
export const MINTS_PER_IP_PER_HOUR = 10;
/** A refused mint asks the client to wait this long. */
export const MINT_RETRY_AFTER_SECONDS = 600;
export const MAX_CHECK_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Every image in a check must be a JPEG no wider than this, no taller than
 * twice that (a portrait display), and no bigger than this many bytes. The app
 * already shrinks screenshots to 1366 px wide; anything bigger would cost more
 * per check than the free budget and the price assume.
 */
export const MAX_IMAGE_WIDTH = 1366;
export const MAX_IMAGE_HEIGHT = 2 * 1366;
export const MAX_IMAGE_BYTES = 1536 * 1024;
export const DEFAULT_FREE_DAILY_BUDGET = 3000;
export const DEFAULT_MODEL = 'gpt-5-mini';

export const PLANS = ['monthly', 'yearly'];

// ---------------------------------------------------------------- secret checks
//
// A secret that is missing or still a placeholder must never open anything.
// v2's runbook deployed with the public string `whsec_placeholder`, which let
// anyone forge a webhook and mint a license. Each check below fails closed.

// `xxx` is never searched for as a plain substring. A real random secret
// contains three x's in a row by chance (about 1 in 1,000 webhook secrets,
// 1 in 300 long keys), and refusing it would lock that owner out: every
// webhook would get 503 and refunds would never revoke.
const PLACEHOLDER_WORDS = /placeholder|replace|example/i;

function looksLikePlaceholder(value) {
  return PLACEHOLDER_WORDS.test(value);
}

/**
 * True for a webhook secret that is a template rather than a real secret.
 * The part after `whsec_` is split into words (at anything that is not a
 * letter or digit), and it is a placeholder when:
 * - it contains placeholder, replace or example (any case);
 * - any word is only x's, 3 or more (`whsec_xxxx…`, `whsec_XXX_paste_here_…`);
 * - it is one character repeated (`whsec_0000…`).
 * A real secret is one word of random letters and digits, so it can only be
 * refused by the first rule, which a random string matches a few times in a
 * billion.
 */
export function webhookSecretLooksLikePlaceholder(value) {
  const body = String(value).replace(/^whsec_/, '');
  if (looksLikePlaceholder(body)) return true;
  if (body.split(/[^A-Za-z0-9]+/).some(word => /^x{3,}$/i.test(word))) return true;
  return /^(.)\1*$/.test(body);
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** rk_… (preferred) or sk_…, and not a placeholder. */
export function stripeKeyOk(value) {
  if (!present(value)) return false;
  if (!/^(rk|sk)_(live|test)_[A-Za-z0-9]+$/.test(value)) return false;
  return !looksLikePlaceholder(value);
}

/** whsec_ followed by at least 32 characters, and not a placeholder. */
export function webhookSecretOk(value) {
  if (!present(value)) return false;
  if (!/^whsec_[A-Za-z0-9+/=_-]{32,}$/.test(value)) return false;
  return !webhookSecretLooksLikePlaceholder(value);
}

/** The model key only has to be there. */
export function modelKeyOk(value) {
  return present(value) && !looksLikePlaceholder(value);
}

/** DEVICE_SECRET and LICENSE_SECRET: at least 32 characters of real randomness. */
export function longSecretOk(value) {
  return present(value) && value.length >= 32 && !looksLikePlaceholder(value);
}

// ---------------------------------------------------------------- live or sandbox
//
// A Stripe key is either live (real money) or test (a sandbox, test cards).
// Licenses and checkout sessions remember which one made them (`livemode`).
// A license only works on a Worker whose key is in the same mode, so a key
// bought with a test card can never get real service from the live Worker.
//
// Test licenses also need ALLOW_TEST_LICENSES = "1", which only the sandbox
// Worker sets (wrangler.jsonc, env.sandbox). A live Worker that was given a
// test key by mistake therefore sells nothing and serves no test license.
//
// The sandbox Worker's address can be guessed from the live one, and anyone
// can "pay" there with a test card. So every check made with a test license
// also comes out of FREE_DAILY_BUDGET (check.js): however many test keys
// someone makes, the sandbox never spends more on the model than that a day.

/** True when STRIPE_SECRET_KEY is a live key (rk_live_… or sk_live_…). */
export function liveKeyMode(env) {
  return /^(rk|sk)_live_/.test(String(env.STRIPE_SECRET_KEY || ''));
}

/** True when this Worker may use a row made in `livemode` (1/true = live, 0/false = test). */
export function modeAllowed(env, livemode) {
  const rowIsLive = livemode === 1 || livemode === true;
  if (rowIsLive) return liveKeyMode(env);
  return !liveKeyMode(env) && env.ALLOW_TEST_LICENSES === '1';
}

/** True when this Worker may sell at all: a live key, or a test key on the sandbox Worker. */
export function sellingAllowed(env) {
  return modeAllowed(env, liveKeyMode(env));
}

/** Which secrets and bindings are in place. /v1/health shows this. */
export function configuredFlags(env) {
  return {
    stripe: stripeKeyOk(env.STRIPE_SECRET_KEY),
    webhook: webhookSecretOk(env.STRIPE_WEBHOOK_SECRET),
    model: modelKeyOk(env.OPENAI_API_KEY),
    device: longSecretOk(env.DEVICE_SECRET),
    license: longSecretOk(env.LICENSE_SECRET),
    db: !!(env.DB && typeof env.DB.prepare === 'function'),
    // The key's mode fits this Worker: live, or test on the sandbox Worker.
    keyMode: stripeKeyOk(env.STRIPE_SECRET_KEY) && sellingAllowed(env)
  };
}

// ---------------------------------------------------------------- plain settings

/** SITE_URL without a trailing slash, or '' when it is not set. */
export function siteUrl(env) {
  return String(env.SITE_URL || '').trim().replace(/\/+$/, '');
}

/** The browser origins allowed to read CORS responses. */
export function siteOrigins(env) {
  return String(env.SITE_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** FREE_DAILY_BUDGET as a whole number. "0" turns free checks off. */
export function freeDailyBudget(env) {
  const raw = env.FREE_DAILY_BUDGET;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_FREE_DAILY_BUDGET;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FREE_DAILY_BUDGET;
}

/** Free checks one IPv6 /48 block may take per UTC day (see FREE_DAILY_SHARE_DIVISOR). */
export function freeDailyShare(env) {
  return Math.max(FREE_CHECKS, Math.ceil(freeDailyBudget(env) / FREE_DAILY_SHARE_DIVISOR));
}

/** The price id for a plan, or '' when it is not configured. Only for NEW checkouts. */
export function priceFor(env, plan) {
  const value = plan === 'yearly' ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY;
  return typeof value === 'string' && value.startsWith('price_') ? value : '';
}

/**
 * The Grayout Pro product id (prod_…), or '' when it is not configured.
 * Existing subscribers are recognised by this, not by today's price ids,
 * because a price change makes new price ids and old subscribers keep theirs.
 */
export function productId(env) {
  const value = env.STRIPE_PRODUCT;
  return typeof value === 'string' && value.startsWith('prod_') ? value : '';
}

/** "Email support@… to start again." or a version without an address. */
export function supportSentence(env) {
  const email = String(env.SUPPORT_EMAIL || '').trim();
  return email ? `Email ${email} to start again.` : 'Email Grayout support to start again.';
}
