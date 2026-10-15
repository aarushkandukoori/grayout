# Grayout hosted API — the contract (v3)

Dated 2026-10-07. This file is binding for the app (`src/`, `main.js`, `ui/`),
the service (`server/`) and the site (`docs/`). If something here is wrong,
change it here first, then change the code. Where this file and any other file
disagree (README, runbook, comments), this file wins.

v2 was never deployed: no Worker, no Stripe account, no customers, no shipped
client talks to it. v3 therefore replaces v2 outright. There is no data to
migrate and no old client to stay compatible with.

---

## 1. What changed in v3, in one list

- **Stripe is the merchant of record (Managed Payments).** Stripe, selling
  through Link, calculates, collects and pays US sales tax and EU/UK VAT,
  handles fraud, disputes and buyer support. We pass
  `managed_payments: { enabled: true }` on every Checkout Session and never pass
  the parameters it forbids (section 9).
- **Stripe API `2026-08-26.dahlia`, stripe-node `^22.6.0`.** Field paths in this
  file are dahlia paths (section 17).
- **Cloudflare D1** (binding `DB`) replaces Workers KV for everything durable.
  Migrations live in `server/migrations/`.
- **Workers Rate Limiting bindings** replace the KV counters, plus a global daily
  budget for free checks.
- **The server mints device identities.** `POST /v1/device` returns a `deviceId`
  and a `deviceToken`. Every device-scoped call carries both.
- **No credentials in URLs.** Every endpoint except `GET /v1/health` is a
  `POST` with a JSON body.
- **Checkout is safe to click twice.** A device whose subscription (used or
  bought, from the app or the website) is still open at Stripe gets
  `409 already_subscribed`. One checkout per device runs at a time, and older
  open ones are expired first. A known Stripe customer is reused. The 7-day
  trial is given once per device, once per customer, and once per email and
  card.
- **Sandbox and live never mix.** Each has its own Worker and database, and a
  `gry_test_` key (bought with a test card) never gets service from the live
  Worker.
- **Webhooks never trust event order.** Every subscription, invoice, refund or
  dispute event makes the service read the customer's subscriptions live from
  Stripe and write what it finds. Events are de-duplicated by `event.id`.
- **Full refunds and disputes cancel the subscription and revoke the license.**
- **Website purchases do not wait for webhooks.** `POST /v1/claim { sessionId }`
  asks Stripe directly and issues the license on the spot when it is paid.
- **Access has an end date.** Service stops 3 days after the paid period ends,
  whatever the stored status says, and the service re-reads Stripe before it
  turns anyone away.
- **Default base URL is a deploy-time placeholder,** never the unowned
  `api.grayout.app`.
- **Bodies are measured as they stream in** and cut off at 8 MB (`/v1/check`)
  or 1 MB (everything else).
- **New error codes:** `device_unverified` (401), `already_subscribed` (409),
  `not_configured` (503). New endpoint: `POST /v1/restore`.

Appendix A maps each of the 29 confirmed review findings to the rule that fixes
it.

---

## 2. Pricing

| Plan | Price | What you get |
|---|---|---|
| Free taste | $0, no card, no account | 100 checks per device, bounded by per-IP limits and a global daily budget |
| Pro monthly | **$9.99 / month** plus tax where it applies, 7-day free trial | 10,000 checks a month |
| Pro yearly | **$79 / year** plus tax where it applies (34% off) | 10,000 checks a month |

- **Prices are tax-exclusive** (`tax_behavior: "exclusive"`). A buyer in a place
  that taxes software pays the price plus that tax, shown at checkout. The site
  must say "plus tax where it applies" next to every price.
- **Buyers may see their local currency.** Managed Payments always turns on
  Adaptive Pricing.
- **One product, two prices.** Product "Grayout Pro", tax code
  `txcd_10105003` (AI as a Service, cloud-based and downloaded, personal use).
- **Cost of goods (measured 2026-09-22):** one `gpt-5-mini` check costs
  $0.00070. A typical month is about 8,100 checks before change-gating and about
  4,050 after it, so about $2.85. Managed Payments adds a per-transaction fee on
  top of normal card processing (the owner's decision file records +3.5%; check
  stripe.com/pricing). Margin at $9.99 is therefore roughly 60%, not 70%.
- **Past 10,000 checks a month the service slows down instead of stopping:**
  one check per 10 minutes per license until the month resets (section 8,
  `quota_exceeded`).
- The trial needs a payment method up front (Checkout's default). A trial
  serves at most **1,000 checks** a month (`TRIAL_CHECKS`; a real week is under
  1,000), and a second trial with an email or card that already had one is
  ended at once (7.1 step 6). A subscription that has never had a payment go
  through never gets the paid allowance or the 3 days of grace (7.2), so a
  card that declines when the trial ends gets nothing more. Together these
  are the brakes on trial abuse.
- **The allowance is a ceiling, not the expected use.** $0.0007 is one
  1366 px screenshot. A Mac with three displays and the webcam costs a few
  times that per check. The allowance was 15,000 until 2026-10-08, when the owner
  lowered it to 10,000: 15,000 checks at even $0.0007 is $10.50, above what a
  $9.99 month nets (about $9 after fees), while 10,000 is at most about $7. The server bounds the cost of one check (6.11 step
  1: JPEG only, at most 1366 px wide, 2732 px tall and 1.5 MiB per image; the
  webcam photo goes at low detail). Before launch the owner re-checks
  `INCLUDED_CHECKS` against the provider's real per-check usage numbers from
  the sandbox.

---

## 3. Base URL and deploy-time constants

Until a domain is bought, the API lives at:

```
https://grayout-api.<cloudflare-subdomain>.workers.dev
```

The deploy step fills it into exactly two lines. Nothing else in the repo names
the API host.

| Where | The one line | Placeholder in git |
|---|---|---|
| App | `src/config.js`: `const DEFAULT_API_BASE = '__GRAYOUT_API_BASE__';` (exported; `src/account.js` imports it) | `__GRAYOUT_API_BASE__` |
| Site | `docs/config.js`: `window.GRAYOUT_API_BASE = '__GRAYOUT_API_BASE__';` (loaded before `docs/app.js`) | `__GRAYOUT_API_BASE__` |

Rules:

- **The placeholder is deliberately not a URL.** A real-looking stand-in such as
  `grayout-api.YOUR-SUBDOMAIN.workers.dev` could be registered by a stranger and
  would then receive screenshots. `__GRAYOUT_API_BASE__` fails URL parsing, so a
  build that was never filled in makes no network calls at all.
- **App, placeholder still present:** never call the network. Show "This build
  of Grayout is not connected to the Grayout service yet."
- **Site, placeholder still present:** buttons say "Subscriptions open soon" and
  no `fetch` happens.
- **Never default to `api.grayout.app`.** It is not owned. When it is bought and
  pointed at the Worker, it becomes the value of these two lines; nothing else
  changes.
- **Overrides (app only):** `apiBase` in `config.json` (https anywhere, http only
  for localhost) and `GRAYOUT_API_BASE` in the environment for unpackaged builds.
- **Site CSP:** every page that loads `config.js` or `app.js` must allow the API
  origin in `connect-src`: either `https://*.workers.dev`, the exact origin, or
  the `__GRAYOUT_API_BASE__` placeholder (which the deploy step fills on
  `connect-src` lines). `bash server/scripts/deploy.sh live` runs
  `server/scripts/check-csp.js` after filling in the address and **stops** if any
  page would block it or still names `grayout.app`. Drop `grayout.app` from CSP
  and from `SITE_ORIGINS` until it is owned.
- **The sandbox address is never committed.** `deploy.sh sandbox` prints it but
  writes it into nothing; the public files only ever point at the live Worker.

---

## 4. Identities and credentials

### 4.1 Device

- **`deviceId`** is minted by the server: `dev_` + 26 Crockford base32
  characters (130 random bits). Pattern: `^dev_[0-9A-HJKMNP-TV-Z]{26}$`.
- **`deviceToken`** = base64url, no padding, of
  `HMAC-SHA256(DEVICE_SECRET, deviceId)`. 43 characters,
  `^[A-Za-z0-9_-]{43}$`. The server stores no tokens; it recomputes and compares
  in constant time.
- **A device is verified** when the token matches **and** a `devices` row
  exists. Anything else is `401 device_unverified`.
- **The app** stores `deviceId` in `state.json` and `deviceToken` in
  `secrets.bin` (safeStorage) under `grayoutDeviceToken`. The token can restore
  a license (`/v1/restore`), so it gets the same protection as the license.
- **The site** mints one device per browser and keeps
  `{ deviceId, deviceToken }` in `localStorage` under `grayout.device`. It only
  uses it for `/v1/checkout`. Website purchases are never attached to a browser
  device, so a browser device can never restore a key.
- **On `device_unverified`:** mint a new device once, retry once, then stop and
  say "Grayout could not register this Mac with the service. Try again later."
  Never loop.
- **Rotating `DEVICE_SECRET` unverifies every device.** Clients re-mint, and
  honest users get a fresh free taste. Do not rotate it casually.

### 4.2 License key

- **Shape:** `gry_live_` or `gry_test_` + 24 Crockford base32 characters.
  Pattern: `^gry_(live|test)_[0-9A-HJKMNP-TV-Z]{24}$`. `gry_test_` keys come
  from Stripe sandboxes (`livemode: false`). The site's key regex must accept
  both.
- **Derived, not stored.** The key is the first 15 bytes (120 bits) of
  `HMAC-SHA256(LICENSE_SECRET, "grayout-license:v1:" + customerId + ":" + generation)`
  written in Crockford base32, after the prefix. The same Stripe customer
  always gets the same key, so two webhook deliveries racing each other cannot
  mint two different keys.
- **D1 stores only `key_hash`** = lowercase hex SHA-256 of the full key string.
  A copy of the database, or an agent running `SELECT * FROM licenses`, never
  sees a working key. To answer a request, hash the key that came in and look it
  up by hash. To show a key again (claim, restore), derive it again from the
  row.
- **`LICENSE_SECRET` must never be rotated.** Rotating it changes every
  customer's key. (It fills the "LICENSE_PEPPER (if used)" slot in the owner's
  secret list; it derives keys rather than salting a hash, hence the name.)
  `generation` exists so a single key can be replaced later; v3 always uses 1.
- **One license per Stripe customer** (`UNIQUE (customer_id)`). The license
  follows that customer's best current subscription (section 7.3).
- **Where it travels:** only in JSON bodies (`"license"`) or an
  `Authorization: Bearer gry_…` header. Never in a URL, never in a log.
- **App storage:** `secrets.bin` under `grayoutLicense`. Shown masked as
  `gry_live_…CB6D`.

### 4.3 Device code and Checkout Session id

- **Device code:** 8 Crockford characters, displayed `XXXX-XXXX`, accepted with
  or without the dash, any case. Lives 3,600 seconds. It is a polling handle
  for one app-initiated purchase and only works together with the device that
  created it.
- **Checkout Session id:** `cs_live_…` or `cs_test_…`, pattern
  `^cs_(live|test)_[A-Za-z0-9]{10,200}$`. It is a bearer credential: whoever
  holds it can read the license that session bought, and nothing else. The
  server only answers for session ids it created itself (the
  `checkout_sessions` table). Unknown ids are refused without a call to Stripe.

---

## 5. Conventions for every request

- **Methods:** `GET /v1/health` is the only GET. Everything else is `POST` with
  `Content-Type: application/json` (a `charset` parameter is fine). Any other
  content type on a POST is `400 bad_request`. That forces browsers to preflight,
  so a hostile web page cannot make its visitors' browsers spend our model key.
- **Body limits:** count bytes while reading the stream and stop as soon as the
  limit is crossed, with `413 payload_too_large`. A declared `Content-Length`
  over the limit is refused before reading. Limits: **8 MiB (8,388,608 bytes)
  for `/v1/check`**, **1 MiB (1,048,576 bytes) for everything else**, webhook
  included. An empty body is read as `{}`. A body that is not a JSON object is
  `400 bad_request`.
- **Query strings are ignored.** No endpoint reads one.
- **Request id:** every response carries `X-Grayout-Request-Id`. A client may
  send one (`^[A-Za-z0-9._-]{1,64}$`); otherwise the server makes a UUID.
- **Every response** has `Content-Type: application/json; charset=utf-8` and
  `Cache-Control: no-store`.
- **Times** in API responses are ISO 8601 UTC strings
  (`"2026-11-07T14:03:11Z"`) or `null`. Times in D1 are integer Unix seconds.
- **Errors** always look like this:

  ```json
  { "error": { "code": "free_exhausted", "message": "One plain sentence.", "reason": "device" } }
  ```

  `code` and `message` are always present. Three codes add one extra field:
  `already_subscribed` adds `portalUrl` (string or null); `free_exhausted` adds
  `reason` (`"device"` or `"daily_budget"`); `rate_limited` and
  `quota_exceeded` add `retryAfter` (whole seconds, the same number as the
  `Retry-After` header).
- **CORS:** only these routes answer browsers, and only for origins in
  `SITE_ORIGINS`: `GET /v1/health`, `POST /v1/device`, `POST /v1/checkout`,
  `POST /v1/claim`, plus their `OPTIONS` preflight (204). Every other route sends
  no CORS headers, so a browser cannot read its responses. The app is not a
  browser and is unaffected.
- **Client IP** comes from `CF-Connecting-IP`. The rate-limit key (`ipKey`) is
  the full address for IPv4 and the first 64 bits (/64 prefix) for IPv6,
  because one IPv6 customer usually owns a whole /64. The **network key**
  (`netKey`) is the same for IPv4 but the /56 for IPv6; device minting and the
  per-network free-check cap use it, so rotating through /64s does not help.
  When the header is missing (local dev), both are `"local"`. For IPv6 there
  is also a **block key** (`blockKey`, the /48): one block may take only a
  small share of each day's free budget (6.11 step 4). IPv4 has no block key.

---

## 6. Endpoints

Summary:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | none | Is it up, is it configured |
| POST | `/v1/device` | none (IP-limited) | Mint a device identity |
| POST | `/v1/device-code` | device | Make a polling handle for an app purchase |
| POST | `/v1/checkout` | device | Start a Stripe Checkout Session |
| POST | `/v1/claim` | device + code, or session id | Collect the license a purchase bought |
| POST | `/v1/restore` | device | Get back the license attached to this device |
| POST | `/v1/activate` | device + license | Attach a pasted license to this device |
| POST | `/v1/status` | device + license | Subscription state, usage, optional portal link |
| POST | `/v1/portal` | device + license | A Stripe billing portal link |
| POST | `/v1/check` | device (+ license) | The watch loop's one call |
| POST | `/v1/stripe/webhook` | Stripe signature | Stripe events |

"device" means the body carries a verified `deviceId` and `deviceToken`
(section 4.1). "license" means the body carries `license` (or the
`Authorization: Bearer` header does) and it hashes to a row in `licenses`.

### 6.1 The account object

`/v1/activate` and `/v1/status` answer with this shape. `/v1/check` reuses its
`usage`.

```jsonc
{
  "plan": "active",                     // the same value as "status" (kept so the two can never disagree)
  "status": "active",                   // free | trialing | active | past_due | canceled
  "service": true,                      // true when /v1/check will be served right now (section 7.2)
  "interval": "monthly",                // monthly | yearly | null
  "cancelAtPeriodEnd": false,
  "periodEnd": "2026-11-07T14:03:11Z",  // the next billing date, or the trial end while trialing; null on free
  "trialEnd": null,                     // set only while trialing
  "usage": {
    "checksUsed": 412,
    "checksIncluded": 10000,
    "periodEnd": "2026-11-07T14:03:11Z",  // same as above: what the person is billed on
    "resetsAt": "2026-11-01T00:00:00Z"    // when the check meter resets: 00:00 UTC on the 1st of next month
  }
}
```

How Stripe's subscription status maps to `status`:

| Stripe `subscription.status` | `status` |
|---|---|
| `trialing` | `trialing` |
| `active` | `active` |
| `past_due`, `unpaid`, `incomplete` | `past_due` (payment needed) |
| `canceled`, `incomplete_expired`, `paused` | `canceled` |

`status` is for display. Only `service` says whether checks will be served.
Clients never decide access themselves.

On the free taste: `status` `"free"`, `interval` `null`, `periodEnd` `null`,
`usage` = `{ checksUsed: <free used>, checksIncluded: 100, periodEnd: null, resetsAt: null }`.
The free taste never comes back.

### 6.2 `GET /v1/health`

No auth, no side effects, CORS allowed.

```json
{
  "ok": true,
  "contract": 3,
  "configured": { "stripe": true, "webhook": true, "model": true, "device": true, "license": true, "db": true }
}
```

Each `configured` flag is true when the matching secret or binding passes the
checks in section 13. Values are never echoed.

### 6.3 `POST /v1/device`

No auth. CORS allowed. Limits: `RL_MINT` (3 a minute per `netKey`) and at most
10 new devices per `netKey` per rolling hour, enforced in D1 (section 11).

```jsonc
// request
{}
// 200
{ "deviceId": "dev_0F3K7Q9X2M4T8V1N5B6C7D8E9G", "deviceToken": "<43 base64url characters>" }
```

Errors: `rate_limited` (429), `not_configured` (503, `DEVICE_SECRET` missing),
`payload_too_large`, `bad_request`.

### 6.4 `POST /v1/device-code`

Device auth. Limits: `RL_IP`, then `RL_DEVICE` once the device is verified.
A device holds at most `MAX_LIVE_DEVICE_CODES` (5) unexpired codes; the
insert checks this in the same statement (12.3). Over it → `429
rate_limited` with `retryAfter` = seconds until its oldest code expires.
Every call writes a row, and an IPv6 /64 is cheap to change, so a
per-address limit alone would let one device write rows without end. The
app reuses an open checkout (16.1), so a real buyer needs one or two codes an
hour.

```jsonc
// request
{ "deviceId": "dev_…", "deviceToken": "…" }
// 200
{ "deviceCode": "7KQ2-R9XW", "expiresIn": 3600 }
```

Errors: `device_unverified`, `rate_limited`, `bad_request`, `not_configured`.

### 6.5 `POST /v1/checkout`

Device auth. CORS allowed (the site's pricing page uses it). Limits: `RL_IP`,
`RL_DEVICE` and `RL_STRIPE_IP`.

```jsonc
// request
{ "deviceId": "dev_…", "deviceToken": "…", "plan": "monthly", "deviceCode": "7KQ2-R9XW" }  // deviceCode only from the app
// 200
{ "url": "https://checkout.stripe.com/c/pay/cs_live_…", "sessionId": "cs_live_…", "trial": true }
// 409
{ "error": { "code": "already_subscribed", "message": "This Mac already has an active Grayout subscription.", "portalUrl": "https://billing.stripe.com/p/session/…" } }
```

What the server does, in order:

1. Verify the device. Spend `RL_DEVICE` (`dev:<deviceId>`). `plan` must be
   `monthly` or `yearly` (`400 bad_request`). Only then take the device's
   **checkout lock** (`devices.checkout_lock_at`, one atomic statement, 30 s
   if a request dies): the lock is a database write, so a flood of refused
   requests never reaches it. If another checkout for this device holds it →
   `429 rate_limited`, `retryAfter` 5. The lock is released when the request
   ends. Two tabs or a double click therefore run one after the other, never
   together.
2. If `deviceCode` is present it must
   exist, be unexpired, and belong to this device; otherwise `404
   code_expired`. The Worker must be allowed to sell: price ids and `SITE_URL`
   set, and a live key (or a test key with `ALLOW_TEST_LICENSES = "1"`, the
   sandbox Worker only); otherwise `503 not_configured`. Spend `RL_STRIPE_IP`.
3. **Close this device's older open sessions.** For each `checkout_sessions`
   row of this device still `open`: `checkout.sessions.expire` it (or retrieve
   it if the expire fails or it is past `expires_at`). Paid meanwhile → fulfil
   it now (7.1). Complete but its payment still processing → `409
   already_subscribed` ("still being processed", `portalUrl: null`). Still
   `open` at Stripe although the expire failed (and not yet past `expires_at`)
   → `503 not_configured` and log `checkout_expire_failed`: it could still be
   paid, so no second session is opened next to it. Otherwise mark it
   `expired` and, if it was a trial session, hand its trial claim back.
4. **Known licenses:** **both** `devices.bought_license_id` (the license this
   device last bought, from the app **or the website**) **and**
   `devices.license_id` (the key it last used, which may be one pasted in:
   an old ended key, or someone else's), in that order. Checking only one
   let a pasted, ended key hide the live subscription the device bought, and
   the subscriber bought a second one. A license from the other Stripe mode
   does not count. For each known license:
   - Revoked: `403 license_revoked` ("This subscription was refunded or
     disputed. Email `SUPPORT_EMAIL` to start again.").
   - **Ask Stripe live** (`subscriptions.list` for the customer, Grayout Pro
     only). Any subscription still open there — `trialing`, `active`,
     `past_due`, `unpaid`, `paused` or `incomplete` — means `409
     already_subscribed` with a fresh billing portal link in `portalUrl` (or
     `null` if making one failed; it returns to the app's page when the
     request has a `deviceCode`, otherwise home, 6.10). For `past_due`,
     `unpaid`, `paused` and `incomplete` the message says to fix the payment
     in Manage billing or at link.com instead of buying again: Stripe may
     still collect the old invoice, and a second subscription would bill
     twice.
   - Everything there is `canceled` or `incomplete_expired`: carry on.

   Reuse a Stripe customer (`customer: …`) **only** from the license this
   device bought itself. A key that was only pasted in may belong to someone
   else; buying on their customer would put this purchase under their email
   and their key. A device with no bought license makes a new customer.
5. **Trial eligibility:** `plan === "monthly"` **and** `devices.trial_used_at`
   is null **and** there is no known license **and** the trial claim succeeds:
   `UPDATE devices SET trial_used_at = now WHERE device_id = ? AND
   trial_used_at IS NULL RETURNING`. The trial is claimed when the session is
   **created**, not when it is paid; an unpaid session hands the claim back
   when it is closed (step 3, or a claim that finds it expired, 6.6), when
   the daily cleanup deletes its month-old row (12.4), and when Stripe
   refuses the create.
   Repeat trials from a new device or browser are caught at fulfilment by
   email and card (7.1 step 6).
6. Create the Checkout Session with exactly the parameters in section 9.
7. Insert a `checkout_sessions` row (session id, device id, device code, plan,
   trial, livemode, `created_at` = the trial claim time, `expires_at`).
8. Answer `{ url, sessionId, trial }`.

Errors: `bad_request`, `device_unverified`, `code_expired`, `license_revoked`,
`already_subscribed`, `rate_limited`, `not_configured` (Stripe key, price ids
or `SITE_URL` missing, a test key on the live Worker, or Stripe refused the
call).

### 6.6 `POST /v1/claim`

Two forms. Limit: `RL_IP`; any request that would call Stripe also counts
against `RL_STRIPE_IP`. CORS allowed (for the session form).

```jsonc
// request, from the app (a purchase it started)
{ "deviceCode": "7KQ2-R9XW", "deviceId": "dev_…", "deviceToken": "…" }
// request, from success.html (any purchase; the id comes from the redirect URL)
{ "sessionId": "cs_live_…" }

// 200, any of:
{ "status": "pending" }
{ "status": "ready", "license": "gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D" }
{ "status": "failed", "reason": "payment_failed" }   // or "expired"
```

How the server answers:

1. **Find the session row.** Code form: the code must exist, be unexpired and
   belong to this device, else `404 code_expired`; then take the newest
   `checkout_sessions` row with that `device_code`. No row yet means
   `pending`. Session form: the id must match the pattern
   (`400 bad_request`) and exist in `checkout_sessions` (`404 code_expired`,
   with no call to Stripe).
2. **Already paid** (`license_id` set): revoked license → `403
   license_revoked`; otherwise `ready` with the key derived again.
3. **Already failed or expired:** `failed` with the reason.
4. **Asked Stripe less than 10 seconds ago** (`checked_at`): `pending`, no call.
5. **Otherwise ask Stripe** (`checkout.sessions.retrieve`), set `checked_at`,
   and act on what comes back:
   - `status: "complete"` and `payment_status` is `"paid"` or
     `"no_payment_required"` → run **fulfil session** (section 7.1) right now
     → `ready`. The buyer never waits for the webhook.
   - `status: "complete"` and `payment_status: "unpaid"` (a delayed payment
     method) → `pending`.
   - `status: "expired"` → mark the row `expired`, and if it was a trial
     session hand its trial claim back (as 6.5 step 3 does; a row marked
     `expired` is never looked at by step 3 again) → `failed` / `expired`.
   - anything else → `pending`.

Terminal answers stop the poll: `ready`, `failed`, `400 bad_request`,
`404 code_expired`, `403 license_revoked`, `401 device_unverified` (after the
one re-mint). Retrying a terminal answer only burns the rate limit.

Polling cadence:

- **App:** every 2 seconds for the first 2 minutes, then every 5 seconds, until
  `expiresIn` runs out. If the window closes without a license, call
  `/v1/restore` on the next launch and whenever Settings opens. Never tell
  someone who paid to subscribe again.
- **success.html:** first try at once, then back off (2, 2, 3, 5, 8, 10, 10, …
  seconds) for **120 seconds** in total. On timeout say: "Your payment went
  through. Your key is not ready yet. Reload this page in a minute and it will
  appear here." Do not say "open the app": a purchase that started on the
  website has no app waiting for it. When the URL has `from=app`, add "Grayout
  on your Mac picks it up by itself." The session id stays claimable for 30
  days.

### 6.7 `POST /v1/restore`

Device auth. Limit: `RL_IP`. For a Mac whose app lost its key but whose device
still has a license on file (this is exactly the `no_license` case).

```jsonc
// request
{ "deviceId": "dev_…", "deviceToken": "…" }
// 200
{ "status": "ready", "license": "gry_live_…" }
{ "status": "none" }
```

Errors: `device_unverified`, `license_revoked` (403), `rate_limited`.

### 6.8 `POST /v1/activate`

Device and license. Limit: `RL_IP`. For someone pasting a key, and to
re-validate on launch. Attaches the license to the device
(`devices.license_id`, and `trial_used_at` if it was empty). If the license row
was synced more than 24 hours ago, re-read Stripe first (section 7.3).

```jsonc
// request
{ "deviceId": "dev_…", "deviceToken": "…", "license": "gry_live_…" }
// 200: the account object (6.1)
```

Errors: `license_invalid` (401), `license_revoked` (403), `device_unverified`,
`rate_limited`, `bad_request`.

A canceled or expired license still activates; the answer just says
`"service": false`.

### 6.9 `POST /v1/status`

Device and license. Limit: `RL_IP`; with `"portal": true` also `RL_STRIPE_IP`.
The app caches the answer for 10 minutes.

```jsonc
// request
{ "license": "gry_live_…", "deviceId": "dev_…", "deviceToken": "…", "portal": true }  // portal is optional
```

200: the account object (6.1) with one more field, `portalUrl`: a billing
portal URL when the request had `"portal": true`, otherwise `null`. Its return
page follows the rule in 6.10.

- If `licenses.synced_at` is older than **24 hours**, re-read Stripe before
  answering (section 7.3).
- A billing portal link is a live Stripe call and expires 5 minutes after it is
  made unless used, so it is only made when asked for, at the moment someone is
  about to click it.

Errors: as for `/v1/activate`.

### 6.10 `POST /v1/portal`

Device and license. Limits: `RL_IP`, `RL_STRIPE_IP`.

```jsonc
// request
{ "license": "gry_live_…", "deviceId": "dev_…", "deviceToken": "…" }
// 200
{ "url": "https://billing.stripe.com/p/session/…" }
```

`billingPortal.sessions.create({ customer: license.customer_id, return_url })`, where
`return_url` is where the portal's "Return" link goes:

- **From the app:** `SITE_URL + "/account.html?from=app"`. That page must not
  push the download (the buyer already has Grayout); it says to go back to the
  app. A request is from the app when it carries **no `Origin` header**:
  browsers always send one with a `POST`, and the app never does (16.1). This
  only picks a page, never grants anything.
- **From a browser** (an `Origin` header): `SITE_URL + "/"`, as before.
- **The 409 link from `/v1/checkout`** (6.5 step 4) uses the request's
  `deviceCode` instead, the same signal as `success_url` (section 9): with a
  code the app page, without one the home page.

Errors: `license_invalid`, `license_revoked`, `device_unverified`,
`rate_limited`, `not_configured`.

Every place that offers "Manage billing" also says, in plain words: "You can
also manage it at link.com, where this purchase is listed as Sold through Link."
(Managed Payments buyers always have that route; section 10.)

### 6.11 `POST /v1/check`

The only endpoint the watch loop calls. 8 MiB body limit. No CORS.

```jsonc
// request
{
  "deviceId": "dev_…",
  "deviceToken": "…",
  "license": "gry_live_…",          // omitted on the free taste (or sent as Authorization: Bearer)
  "displays": ["<base64 jpeg>"],    // 1 to 3 JPEGs, at most 1366 px wide, 2732 px tall, 1.5 MiB each
  "webcam": "<base64 jpeg>",        // or null; the same limits
  "context": {
    "workDescription": "…",         // at most 500 characters, may be ""
    "frontApp": "Code",             // at most 80 characters, may be null
    "canvasTasks": ["…"],           // at most 20, untrusted text
    "fileTasks": ["…"]              // at most 20, untrusted text
  }
}
// 200
{
  "verdict": { "off_task": false, "activity": "code editor and terminal", "confidence": "high" },
  "usage":   { "checksUsed": 412, "checksIncluded": 10000, "periodEnd": "2026-11-07T14:03:11Z", "resetsAt": "2026-11-01T00:00:00Z" },
  "plan":    "active",
  "service": true
}
```

Order of work (the order matters, so nobody is charged for a request that was
going to be refused):

1. `RL_CHECK_IP` (60 a minute per `ipKey`), **before** the body is read, so
   nobody can make the Worker read and parse 8 MB bodies without limit. Then
   read the body (8 MiB), check the content type, parse, and validate every
   field (`bad_request` on anything malformed). Every image must be base64
   that decodes: a length 1 more than a multiple of 4, or `=` anywhere but
   the end of a whole last group of 4, is `400 bad_request` (never a 500,
   which the app would retry with the same body). Every image must be a JPEG
   whose frame header says at most `MAX_IMAGE_WIDTH` (1366) px wide and
   `MAX_IMAGE_HEIGHT` (2732) px tall, and at most `MAX_IMAGE_BYTES` (1.5 MiB);
   otherwise `400 bad_request`. Bigger images would cost more per check than
   the budgets and the price assume. Screenshots go to the model at `detail:
   "auto"`, the webcam photo at `detail: "low"` (it only has to show whether
   someone holds a phone).
2. Verify the device (`device_unverified`). `RL_DEVICE` (40 a minute per
   device, shared with `/v1/device-code` and `/v1/checkout`).
3. **With a license:** look it up by hash (`license_invalid`, also for a
   license from the other Stripe mode); `RL_LICENSE` (20 a minute per license)
   **before** deciding, because deciding can mean a Stripe read; decide service
   (section 7.2, which may re-read Stripe, counted against `RL_STRIPE_IP`;
   `license_revoked`, `trial_expired`, `subscription_inactive`); reserve one
   check in `usage` with the single atomic statement in section 12.3 (allowance
   10,000, or 1,000 until a payment has gone through: `trialing`, or
   `past_due` on the first charge after the trial, 7.2). No row back means over the allowance
   and inside the 10-minute slow interval → `429 quota_exceeded` with
   `retryAfter` = seconds until 10 minutes after the last served check. A
   **test license** (`livemode = 0`, sandbox Worker only) also reserves one
   unit of today's `FREE_DAILY_BUDGET`; when that is spent → the paid check is
   given back and `429 quota_exceeded` ("This is the sandbox service, and its
   checks for today are used up."), `retryAfter` = seconds until midnight
   UTC. Anyone can "buy" a test key with a test card, so this is what caps
   the sandbox's model spend. Set `devices.license_id` if it differs.
4. **Without a license:** if `devices.license_id` is set → `401 no_license`.
   `RL_FREE_IP` (4 a minute per `netKey`). Reserve one free check on the device
   (`402 free_exhausted`, `reason: "device"`), then one of this network's
   **300 a calendar month** (`FREE_CHECKS_PER_NETWORK`, keyed on a keyed hash
   of `netKey`; `402 free_exhausted`, `reason: "device"`, "This network has
   used its free checks for this month"), then, for IPv6 only, one of its /48
   block's share of today (`free_block`, at most `FREE_DAILY_BUDGET / 20` but
   never fewer than 100; `402 free_exhausted`, `reason: "daily_budget"`, "Free
   checks from this network are paused for today"), then one from today's
   global budget (`402 free_exhausted`, `reason: "daily_budget"`). A step that
   fails gives back the ones before it. Without the network cap, re-minting
   devices gave one network free checks forever and let one address use up the
   global budget for everyone; without the block share, one /48 (256 networks,
   and some providers give one away) could still do it.
5. Call the model. If the provider **certainly did not bill** — the request
   never got through (no connection) or it answered with an error status
   (429, 5xx, 4xx) — give back every reservation made in steps 3 and 4
   (including the block share and a test license's budget unit). If it
   **did** bill — a refusal, an `incomplete` response, an empty or unreadable
   answer, or the 60 s timeout after the request was sent — keep them all.
   Either way answer `502 upstream_unavailable`. Otherwise a caller who makes
   the model fail on purpose could spend the model key without limit. A
   missing `OPENAI_API_KEY` is `503 not_configured`.
6. Answer with the verdict and the usage after this check.

The **server owns the prompt.** The client sends pixels and context, never
prompt text. That keeps the model key on the server and lets the judgement
improve without an app update. The server fences untrusted task text and tells
the model to ignore instructions found in it, exactly as `src/analyzer.js`
documents.

**Anything that is not a clean verdict is treated as on-task by the app,**
exactly as before.

### 6.12 `POST /v1/stripe/webhook`

Verified with the Stripe signature only (no device auth, no CORS, 1 MiB).
Section 7 has the full handling. Answers:

| Case | Status | Body |
|---|---|---|
| Processed | 200 | `{ "received": true, "action": "license_issued" }` (or `duplicate_refunded`, `synced`, `revoked`, `awaiting_payment`, `failed`, `partial_refund`, `ignored`) |
| Seen before | 200 | `{ "received": true, "action": "duplicate" }` |
| Bad or missing signature | 400 | `invalid_signature` |
| `STRIPE_WEBHOOK_SECRET` or `STRIPE_SECRET_KEY` missing or a placeholder | 503 | `not_configured` (fail closed: nothing is processed) |
| Anything threw (D1 or a Stripe call failed) | 500 | `internal_error`; nothing recorded, so Stripe retries |

---

## 7. Licenses, access and webhooks

### 7.1 Fulfil session (shared by the webhook and `/v1/claim`)

One function, `fulfilSession(session)`, used by both paths, so they can never
disagree. It is safe to run any number of times, in any order, at the same time.

1. Find the `checkout_sessions` row by `session.id`. Missing → do nothing,
   action `ignored` (we only sell through sessions we created). A session from
   the other Stripe mode (`session.livemode` vs this Worker's key) → `ignored`
   and log `session_wrong_mode`.
2. If `session.payment_status` is not `"paid"` or `"no_payment_required"` →
   action `awaiting_payment`. Nothing is issued for an unpaid session. A delayed
   payment method finishes later with `checkout.session.async_payment_succeeded`
   (issue) or `checkout.session.async_payment_failed` (mark the row `failed`).
3. **Never a second subscription for one device.** If the row's device
   bought or uses a license (**both** `devices.bought_license_id` and
   `devices.license_id` are checked, the bought one first) of a
   **different** customer, of this Worker's mode, and that customer's
   subscription is still open at Stripe (6.5 step 4's list), this session is
   a duplicate: it was opened before the 409 and the
   session expiry could stop it. Then: cancel its subscription now (unless
   already canceled), refund its payment if it was paid
   (`invoicePayments.list({ invoice: session.invoice, status: "paid" })` →
   `refunds.create({ payment_intent, reason: "duplicate" })` with the
   idempotency key `grayout-duplicate-<payment_intent>`; a
   `charge_already_refunded` error counts as done), log `duplicate_purchase`,
   mark the row `paid` with `license_id` = the device's EXISTING license, and
   stop with action `duplicate_refunded`. No license is issued for the new
   customer and the device is never moved onto it, so `/v1/claim` for this
   session hands back the key that already works. If the cancel or refund
   throws, log `duplicate_undo_failed` and let it answer 500 so Stripe
   retries; every step is safe to repeat. A later run that finds the row
   already `paid` with another customer's license returns
   `duplicate_refunded` at once.
4. **Issue the license** for `session.customer`: derive the key (4.2), then

   ```sql
   INSERT INTO licenses (key_hash, livemode, customer_id, synced_at, created_at)
   VALUES (?1, ?2, ?3, 0, ?4)
   ON CONFLICT (customer_id) DO NOTHING;
   SELECT * FROM licenses WHERE customer_id = ?3;
   ```

   Run both statements in one `DB.batch`. A second or simultaneous delivery hits
   the UNIQUE constraint, inserts nothing, and reads back the same row and the
   same key. `synced_at` starts at 0 ("never synced"), so if step 5 fails, the
   first access decision re-reads Stripe instead of trusting the placeholder
   status.
5. **Sync the customer** from Stripe (7.3). Never guess a status from the
   session.
6. **One trial per email and card.** Only for a trial session the first time
   it is fulfilled, while the license is `trialing`: make the marks
   `email:` + HMAC(`LICENSE_SECRET`, normalized email) (lower case, no
   `+tag`, Gmail dots removed) and `card:` + HMAC(`LICENSE_SECRET`, the
   subscription's default payment method card fingerprint, if readable), and
   insert them into `trial_marks` (first customer keeps a mark). If **another**
   customer already holds either mark, this is a repeat trial: set
   `licenses.trial_denied = 1`, call `subscriptions.update(sub, { trial_end:
   "now" })` (Stripe then bills the first period at once), log `repeat_trial`,
   and sync again. If Stripe refuses the update, `trial_denied` alone keeps
   the license from service while it is still `trialing` (7.2).
7. Only after step 5 succeeded: mark the row `state = 'paid'`,
   `license_id = <id>`. Set `devices.trial_used_at` for the row's device (keep
   the first value if one is there), and `devices.bought_license_id` for every
   purchase, app or website: it is only used to refuse a second checkout
   (6.5), never to serve or restore. If the row has a `device_code` (the app
   started it), also set `devices.license_id` on that device. A browser device
   never gets a license attached.

### 7.2 Access rules: who gets checks served

```
unpaidSinceTrial(license):                 (the first charge after the trial is the one that failed)
  if license.trial_denied and trial_end is null   -> true   (cannot tell; assume it never paid)
  true when trial_end is set and period_start <= trial_end

decide(license, now):
  if license.revoked_at is set            -> deny  license_revoked
  status = license.status                  (Stripe's raw subscription status)
  if status is trialing and license.trial_denied
                                           -> deny  subscription_inactive (repeat trial)
  if status is past_due and unpaidSinceTrial(license)
                                           -> deny  subscription_inactive (repeat trial if trial_denied)
  if status is trialing or active:         paidThrough = license.period_end
  else if status is past_due:              paidThrough = license.period_start
  else                                     -> deny  subscription_inactive
  if paidThrough is null                   -> deny  subscription_inactive
  if now < paidThrough + 3 days            -> allow
  if status is trialing                    -> deny  trial_expired
  otherwise                                -> deny  subscription_inactive
```

- **Why `period_start` for `past_due`:** when a renewal payment fails, Stripe
  has already moved the period forward, so `period_end` is a month or a year
  away. The period the customer actually paid for ended when the unpaid one
  began, which is `period_start`. Using it gives exactly "3 days after the paid
  period ended", and closes the hole where a failed yearly renewal would keep
  working for a year.
- **No grace for a subscription that never paid.** The 3 days are for
  someone who paid and whose renewal failed. When a trial ends and its first
  charge declines, Stripe says `past_due` with `period_start` = the trial's
  end; a repeat trial ended with `trial_end: "now"` (7.1 step 6) whose charge
  declines looks the same (Stripe sets `trial_end` and the new
  `period_start` to that moment). Both are refused at once. Without this, a
  card with no money on it got 3 days at the full 10,000-check allowance at
  the end of every trial, from a new device each time, and never paid. A
  failed **renewal** starts its unpaid period after `trial_end` (a month or a
  year later), so it keeps its grace, repeat trial or not.
- **Allowance:** `TRIAL_CHECKS` (1,000) for a license that has never had a
  payment go through (`trialing`, or `past_due` with `unpaidSinceTrial`),
  `INCLUDED_CHECKS` (10,000) otherwise.
- **`unpaid`, `incomplete`, `incomplete_expired`, `paused`, `canceled`** never
  get service.
- **Re-read before refusing:** if the answer is "deny" for any reason except
  revocation, and `synced_at` is more than **15 minutes** old, sync the customer
  from Stripe (7.3) and decide again. A missed or late webhook can therefore
  never lock out someone who paid, and a single license costs at most one Stripe
  read every 15 minutes.
- **At most one Stripe read per license per 15 minutes, even when reads
  fail.** `licenses.sync_tried_at` is written **before** every re-read; both
  re-read rules wait until it is more than 15 minutes old. `synced_at` stays
  the time of the last **successful** read. A read that keeps failing (Stripe
  down, a missing key permission, a deleted customer) therefore cannot turn
  every request into a Stripe call. Each re-read also counts against the
  caller's `RL_STRIPE_IP`; over it, the stored row is used as it is.
- **Re-read when stale:** `/v1/status` and `/v1/activate` re-read when
  `synced_at` is more than **24 hours** old.
- **Mode:** a license whose `livemode` does not match this Worker is
  `license_invalid` everywhere (`loadLicense`), never decided. A live Worker
  serves only `gry_live_` keys; a `gry_test_` key needs a test key **and**
  `ALLOW_TEST_LICENSES = "1"` (the sandbox Worker only). `/v1/restore`,
  `/v1/claim` and `/v1/checkout` ignore rows of the other mode the same way.
  The sandbox Worker's address can be guessed from the live one, so every
  check with a test license also spends one unit of `FREE_DAILY_BUDGET`
  (6.11 step 3): test cards can never make the sandbox spend more on the
  model than that budget a day.
- **Revocation is sticky.** Nothing automatic ever clears `revoked_at`. The
  owner clears it by hand in D1 if they choose to (section 14).

### 7.3 Sync the customer (the only way status is ever written)

`syncCustomer(customerId)` reads Stripe and writes the license. Nothing else
writes `status`, `billing_interval`, `period_start`, `period_end`,
`trial_end`, `cancel_at_period_end` or `subscription_id`.

1. `stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 })`.
2. Keep only Grayout Pro subscriptions: the first item's
   `price.product` is `STRIPE_PRODUCT`, or (until that is set) its price is
   today's `STRIPE_PRICE_MONTHLY` or `STRIPE_PRICE_YEARLY`. Matching on the
   product means a future price change (new price ids, old subscribers kept on
   the old ones) never locks anyone out. The price ids are only for **new**
   checkouts.
3. Pick one: the newest whose status is `trialing`, `active` or `past_due`;
   if there is none, the newest of any status; if there are none at all, leave
   the license as it is and return.
4. Write from the picked subscription (dahlia field paths):

   | Column | From |
   |---|---|
   | `subscription_id` | `sub.id` |
   | `status` | `sub.status` |
   | `billing_interval` | `sub.items.data[0].price.recurring.interval`: `month` → `monthly`, `year` → `yearly` |
   | `period_start` | `sub.items.data[0].current_period_start` |
   | `period_end` | `sub.items.data[0].current_period_end` |
   | `trial_end` | `sub.trial_end` |
   | `cancel_at_period_end` | `sub.cancel_at_period_end` (as 0/1) |
   | `synced_at` | now |

5. If more than one subscription is `trialing`, `active` or `past_due`, log
   `duplicate_subscription` with the customer id. That should not happen (409 on
   checkout, the duplicate guard in 7.1 step 3, plus Stripe's one-subscription
   setting); the owner refunds by hand
   when it does.

If Stripe has nothing of ours for the customer, only `synced_at` is written.

Because every write comes from a fresh read, the order in which events arrive
does not matter: a late `invoice.payment_failed`, a retried old
`customer.subscription.updated`, or a replayed `checkout.session.completed` all
end up writing whatever Stripe says now.

### 7.4 Webhook handling

Steps for every delivery:

1. Fail closed: if `STRIPE_WEBHOOK_SECRET` or `STRIPE_SECRET_KEY` fails the
   checks in section 13 → `503 not_configured`.
2. Read the raw body (1 MiB limit), then
   `await stripe.webhooks.constructEventAsync(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider())`.
   Workers have no synchronous crypto, hence the async form and the SubtleCrypto
   provider. Default tolerance (5 minutes). Failure → `400 invalid_signature`.
3. If `processed_events` has `event.id` → `200 duplicate`.
4. Handle by type (table below).
5. Only after the handler succeeded:
   `INSERT INTO processed_events (event_id, type, processed_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING`.
   If anything threw, answer 500 and record nothing, so Stripe retries. Every
   handler is idempotent, so a retry after a partial run is safe.

| Event | What the service does | Action |
|---|---|---|
| `checkout.session.completed` | `fulfilSession(event.data.object)` | `license_issued` or `awaiting_payment` or `ignored` |
| `checkout.session.async_payment_succeeded` | `fulfilSession(event.data.object)` | `license_issued` |
| `checkout.session.async_payment_failed` | Mark the `checkout_sessions` row `failed`. If the customer already has a license, `syncCustomer`. | `failed` |
| `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed` | If a license exists for `object.customer`, `syncCustomer`. If not, ignore: issuing the license syncs anyway. | `synced` or `ignored` |
| `invoice.paid`, `invoice.payment_failed` | Same, with `invoice.customer`. Never derive a status from the invoice. | `synced` or `ignored` |
| `charge.refunded` | Only when `charge.refunded === true` (a full refund; partial refunds leave access alone). Resolve the subscription (7.5), cancel it if it is not already canceled, revoke the license whose `subscription_id` is that subscription, if there is one (`revoked_reason = 'refund'`), then `syncCustomer` for its customer. | `revoked` or `partial_refund` or `ignored` |
| `charge.dispute.created` | Resolve the subscription (7.5), revoke the license whose `subscription_id` is that subscription (`'dispute'`), cancel it if it is not already canceled, then `syncCustomer`. We do not answer the dispute: Stripe handles disputes for Managed Payments. | `revoked` or `ignored` |
| `radar.early_fraud_warning.created` | The card's bank says the card was used without permission; a dispute usually follows weeks later. Same as a dispute, with `revoked_reason = 'fraud'`: resolve (7.5), revoke, cancel, sync. | `revoked` or `ignored` |
| anything else | nothing | `ignored` |

Revoking and cancelling: retrieve the subscription; if the license has no
`subscription_id` yet, sync it first so it can be matched; **revoke first**;
then call `stripe.subscriptions.cancel(id)` only when its status is not already
`canceled` or `incomplete_expired`. If the cancel throws, log `cancel_failed`
with the subscription id and let the error answer 500, so Stripe retries the
cancel; the license is already revoked, and revoking again changes nothing
(first time and reason are kept). The cancel is immediate: the buyer has their
money back.

A refund of an old, already-ended subscription never revokes the license of a
newer one, because the license only follows one subscription.

To refund someone without cutting off their access, refund less than the full
charge.

### 7.5 From a charge or dispute to its subscription (dahlia)

Stripe's documented path for API version 2025-03-31.basil and later:

1. Get the PaymentIntent id. `charge.refunded`: `charge.payment_intent`.
   `charge.dispute.created` and `radar.early_fraud_warning.created`: the
   object's `payment_intent`; when that is null,
   `stripe.charges.retrieve(object.charge)` and use its `payment_intent`. No
   PaymentIntent → log `refund_unresolved` / `dispute_unresolved` /
   `fraud_warning_unresolved` and stop.
2. `stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: <pi> }, status: "paid" })`,
   following `has_more`.
3. For each `invoice_payment.invoice`: `stripe.invoices.retrieve(id)`; keep it
   only if `invoice.parent.type === "subscription_details"`; the subscription is
   `invoice.parent.subscription_details.subscription`.
4. Nothing found → log the `…_unresolved` line and stop. We sell nothing but
   subscriptions, so the owner looks at it by hand.

---

## 8. Error codes

| Code | HTTP | Meaning | What the client does |
|---|---|---|---|
| `bad_request` | 400 | Missing or malformed field, wrong content type | Fix the request. A claim poll stops. |
| `invalid_signature` | 400 | Webhook signature did not verify | (Stripe only) |
| `device_unverified` | 401 | Device id or token missing, wrong, or unknown | Mint once (`/v1/device`), retry once, then stop and say so |
| `no_license` | 401 | This device has a license on file and sent none | Call `/v1/restore`. If it returns a key, store it and carry on. If not, ask for the key to be pasted. **Never** say "subscribe". |
| `license_invalid` | 401 | Not a key this service issued, or a key from the other Stripe mode (`gry_test_` on the live Worker) | "That license key is not one Grayout issued." |
| `free_exhausted` | 402 | `reason: "device"`: this device (or this network, this month) used its free checks. `reason: "daily_budget"`: today's free checks for everyone, or this IPv6 /48 block's share of them, are used up | device: "Free checks used up. Subscribe to keep Grayout watching." daily_budget: "Free checks are paused for today because of demand. They come back after midnight UTC, or subscribe to keep going." |
| `trial_expired` | 402 | Trial ended more than 3 days ago without a paid renewal | "Your trial ended. Subscribe in Settings." |
| `subscription_inactive` | 402 | Canceled, unpaid, paused, or more than 3 days past the paid period | "Your subscription is not active. Update your payment in Manage billing or at link.com." |
| `license_revoked` | 403 | Refunded or disputed | "This subscription was refunded or disputed. Email `SUPPORT_EMAIL` to start again." Stop polling. |
| `code_expired` | 404 | Device code expired or unknown, or a session id this service did not create | Stop polling. App: start the purchase again, or `/v1/restore` if a purchase may have gone through. Site: "This link has expired. If you need your key again, email `SUPPORT_EMAIL`." |
| `not_found` | 404 | No such path | |
| `method_not_allowed` | 405 | Wrong method for this path | |
| `already_subscribed` | 409 | This device already bought a subscription (app or website) that is still open at Stripe (`trialing`, `active`, `past_due`, `unpaid`, `paused`, `incomplete`), or a payment from it is still processing | Open `portalUrl` (if not null) to manage or fix the payment, or `/v1/restore` to get the key back. Do not start checkout. |
| `payload_too_large` | 413 | Over 8 MiB (`/v1/check`) or 1 MiB (others) | Send smaller images |
| `quota_exceeded` | 429 | Over 10,000 checks this month and inside the 10-minute slow interval; or, on the sandbox Worker only, today's budget for test-license checks is spent | Wait `retryAfter` seconds. Say "Monthly checks used up: checking every 10 minutes until <resetsAt>." (the sandbox case has its own message) |
| `rate_limited` | 429 | Too many requests | Wait `retryAfter` seconds |
| `internal_error` | 500 | A bug or a failed dependency | Retry later with backoff |
| `upstream_unavailable` | 502 | The model provider failed. The check is given back only if the provider did not bill (no connection, an error status); a refusal, incomplete or unreadable answer or a timeout stays counted | Treat as on-task, retry next cycle |
| `not_configured` | 503 | A secret, binding or Stripe setting is missing, or Stripe refused | Retry later. `/v1/check` treats it as on-task. |

The app handles these by name: `device_unverified`, `no_license`,
`license_invalid`, `license_revoked`, `trial_expired`, `subscription_inactive`,
`free_exhausted`, `quota_exceeded`, `rate_limited`, `upstream_unavailable`,
`payload_too_large`, `code_expired`, `already_subscribed`, `not_configured`.

---

## 9. The Checkout Session, exactly

```js
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-08-26.dahlia',
  httpClient: Stripe.createFetchHttpClient(),   // Workers have fetch, not Node's http
});

await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: plan === 'yearly' ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY, quantity: 1 }],
  managed_payments: { enabled: true },             // Stripe is merchant of record
  integration_identifier: 'grayout_pro_kaklnzxs',  // fixed label for this flow, see below
  client_reference_id: deviceId,                   // shows in the Dashboard; never used for mapping
  ...(knownCustomerId ? { customer: knownCustomerId } : {}),
  ...(trialEligible ? { subscription_data: { trial_period_days: 7 } } : {}),
  success_url: `${env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}${deviceCode ? '&from=app' : ''}`,
  cancel_url: `${env.SITE_URL}/pricing.html?canceled=1${deviceCode ? '&from=app' : ''}`,
  expires_at: nowSeconds + 3600,                   // the same life as a device code
});
```

- **One Stripe client per Worker isolate**, made lazily from `env` and reused.
- **`integration_identifier`** is a fixed label for this checkout flow, not a
  per-request value. `grayout_pro_kaklnzxs` was generated once (8 random
  letters) and is a code constant.
- **Mapping a completed session back to a device** uses our
  `checkout_sessions` row, found by `session.id` (Stripe's own object), not
  `client_reference_id` or metadata.
- **`trialEligible`** is from 6.5 step 3 and is only ever true for `monthly`.
- **`from=app`** goes on both return URLs when the app started the checkout
  (the request had a `deviceCode`; the site never sends one). The pages then
  say "go back to Grayout" instead of offering the download the buyer
  already has. Website checkouts come back exactly as before.

Never pass any of these. Managed Payments rejects them or controls them itself:

`automatic_tax`, `tax_id_collection`, `subscription_data.default_tax_rates`,
`adaptive_pricing`, `payment_method_types`, `payment_method_configuration`,
`customer_update` (`name`, `address`), `shipping_address_collection`,
`shipping_options`, `subscription_data.invoice_settings`, `invoice_creation`,
`subscription_data.application_fee_percent`, `subscription_data.on_behalf_of`,
`subscription_data.transfer_data`, `payment_intent_data.statement_descriptor`,
`payment_intent_data.statement_descriptor_suffix`, `custom_text`,
`consent_collection.payment_method_reuse_agreement.position`,
`submit_type: "donate"` or `"book"`.

Also left out on purpose:

- `payment_method_collection` (the default, `always`, keeps the card-first
  trial).
- `billing_address_collection` (Managed Payments collects what tax needs).
- `allow_promotion_codes` (no promotions at launch; allowed later).
- `metadata` (not used for mapping).

---

## 10. Managed Payments: what it means for us

What Stripe does, so we do not:

- **Tax.** Calculates, collects and remits sales tax, VAT and GST in more than 80
  countries. We set no tax parameters and hold no tax registrations for these
  sales.
- **Receipts and emails.** Receipts, invoices (with PDFs) and refund notices come
  from Link, whatever our Dashboard email settings say. Trial customers get a
  trial-start email. Link sends a trial-ending reminder only "for all trials
  longer than 7 days", and "the Dashboard setting for trial ending emails
  doesn't apply to these emails" (Stripe docs, How Managed Payments works,
  checked 2026-10-08). Our trial is exactly 7 days, so **no reminder exists
  unless the app sends one**, and it does: one macOS notification about 48
  hours before `trialEnd`, once per trial, only while `status` is `trialing`
  and the trial is not set to cancel (`src/trialreminder.js`; the app re-reads
  `/v1/status` about once a day while trialing). A Mac that is off or not
  running Grayout in those 48 hours gets no reminder.
- **Buyer support.** Payment and subscription questions go to Link support.
  Stripe may contact the owner for product questions; with no answer within 48
  hours it may refund without asking. The support email in Dashboard → business
  details must be real and watched (`SUPPORT_EMAIL`).
- **Refunds.** Buyers can ask Link support for one. Stripe can refund within 60
  days. Every full refund reaches us as `charge.refunded` and revokes the
  license (7.4).
- **Disputes.** Stripe reviews each one, submits evidence or accepts it. The
  dispute fee is still charged to the account. We do not respond; we cancel and
  revoke (7.4).
- **Fraud.** Stripe runs the Radar rules.
- **Statement line:** `LINK.COM* <statement descriptor>`.
- **Subscription management:** every buyer can view orders, cancel, switch, and
  update the card or billing address at link.com (guests are prompted to make a
  Link account). We also offer Stripe's billing portal (`/v1/portal`).
- **Data deletion:** if a buyer asks Stripe to delete their data, Stripe cancels
  their Managed Payments subscriptions (we get `customer.subscription.deleted`)
  and emails the owner. The owner then deletes that customer's `licenses` row by
  hand (section 14).

What we must never do:

- Create a subscription any way except a Managed Payments Checkout Session.
- Charge a Managed Payments buyer's payment method outside Managed Payments
  (their consent covers only that).
- Pass a forbidden parameter (section 9).
- Use a custom domain on Checkout (not supported for Managed Payments).

What the site and app must say:

- Every price: "plus tax where it applies".
- At checkout and in the terms or privacy page: "Payments are processed by
  Stripe and sold through Link. Your statement shows LINK.COM*."
- Next to every "Manage billing" link: "You can also manage it at link.com,
  where this purchase is listed as Sold through Link."
- The site needs a terms page (`docs/terms.html`; it does not exist yet) whose
  URL the owner adds to Dashboard → Checkout settings with the privacy page URL,
  because the Managed Payments checkout footer links to them.

---

## 11. Rate limits and budgets

Workers Rate Limiting bindings (in `wrangler.jsonc` under `ratelimits`). They
write nothing to storage. Their `period` can only be 10 or 60 seconds, and their
counts are approximate and per Cloudflare location, which is why the hard limits
below live in D1.

| Binding | `namespace_id` | Limit | Key | Applied to |
|---|---|---|---|---|
| `RL_MINT` | `"1001"` | 3 per 60 s | `netKey` | `POST /v1/device` |
| `RL_IP` | `"1002"` | 120 per 60 s | `ipKey` | every route except `/v1/check`, the webhook and health |
| `RL_STRIPE_IP` | `"1003"` | 10 per 60 s | `ipKey` | every request that is about to call Stripe: checkout, portal, status with `portal`, a claim that will ask Stripe, a 409 that makes a portal link, and every access re-read (7.2) from `/v1/check`, `/v1/status` and `/v1/activate` |
| `RL_FREE_IP` | `"1004"` | 4 per 60 s | `netKey` | `/v1/check` without a license |
| `RL_DEVICE` | `"1005"` | 40 per 60 s | `dev:<deviceId>` | `/v1/check`, `/v1/device-code`, and `/v1/checkout` before its lock |
| `RL_LICENSE` | `"1006"` | 20 per 60 s | `lic:<licenses.id>` | `/v1/check` with a license, before the access decision (about 1,200 an hour at most) |
| `RL_CHECK_IP` | `"1007"` | 60 per 60 s | `ipKey` | `/v1/check`, before its body is read |

The sandbox Worker uses the same limits with namespaces `"2001"` to `"2007"`.

A refusal is `429 rate_limited` with `Retry-After` and `retryAfter` equal to the
binding's period. Binding keys never contain a license key or a device token.

Hard limits kept in D1:

| Limit | Value | How |
|---|---|---|
| New devices per `ipKey` | 10 per rolling hour | the atomic insert in 12.3; refusal is `rate_limited`, `retryAfter` 600 |
| Free checks per device | 100, ever | atomic reserve in 12.3 |
| Free checks per network | 300 per calendar month, however many devices it mints | atomic reserve in `free_network` (12.3); then `free_exhausted` / `device` |
| Free checks per IPv6 /48 block | `FREE_DAILY_BUDGET / 20` per UTC day (150 by default), never fewer than 100 | atomic reserve in `free_block` (12.3); then `free_exhausted` / `daily_budget` |
| Test-license checks (sandbox Worker) | share `FREE_DAILY_BUDGET` per UTC day with the free checks | the free budget reserve in 12.3; then `quota_exceeded` until midnight UTC |
| Free checks for everyone | `FREE_DAILY_BUDGET` per UTC day (default 3,000, about $2.10) | atomic reserve in 12.3; then `free_exhausted` / `daily_budget` |
| Paid checks per license | 10,000 a month (1,000 until a payment has gone through, 7.2), then 1 per 10 minutes | atomic reserve in 12.3; then `quota_exceeded` |
| Device codes per device | `MAX_LIVE_DEVICE_CODES` (5) unexpired at once | the capped insert in 12.3; then `rate_limited` until the oldest expires |
| Stripe reads for one checkout session | at most 1 per 10 seconds | `checkout_sessions.checked_at` |
| Stripe re-reads for one license | at most 1 per 15 minutes, counting failed reads | `licenses.sync_tried_at` (7.2) |
| Checkouts per device | one at a time, and never two payable sessions | `devices.checkout_lock_at` and the expire-or-stop rule (6.5); a paid duplicate is canceled and refunded (7.1 step 3) |

Worst case for the free taste: the global budget caps model spend on free checks
at `FREE_DAILY_BUDGET` × $0.0007 a day, however many devices or IPs an attacker
has, and billed model failures stay counted (6.11 step 5), so failing on
purpose does not get around it. One network can take at most 300 of it a
month, and one IPv6 /48 block at most a twentieth of it a day, so a single
address or a single /48 can no longer use up a day's free checks for
everyone; an attacker with twenty or more separate blocks or IPv4 addresses
still can. Paying customers are unaffected.

**Plan:** the Worker needs the **Workers Paid** plan before launch. Every
served check is a D1 write, and the free plan's daily D1 write and CPU limits
would be reached at a few hundred active subscribers. Check the current
Cloudflare limits at deploy time.

---

## 12. Storage: D1

Binding `DB`, database name `grayout` (live) and `grayout-sandbox` (the
sandbox Worker's own database). Schema in
`server/migrations/0001_init.sql`, applied by `server/scripts/deploy.sh`
(`npx wrangler d1 migrations apply grayout --remote`, or `grayout-sandbox
--remote --env sandbox`). The live database never holds sandbox rows. All
queries use bound parameters (`?1`, `?2`, …); SQL is never built by joining
strings.

### 12.1 Schema (`0001_init.sql`)

```sql
-- One row per Stripe customer who has ever paid or started a trial.
CREATE TABLE licenses (
  id                    INTEGER PRIMARY KEY,
  key_hash              TEXT    NOT NULL UNIQUE,   -- hex SHA-256 of the key; the key itself is never stored
  generation            INTEGER NOT NULL DEFAULT 1,
  livemode              INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  customer_id           TEXT    NOT NULL UNIQUE,   -- cus_…: one license per customer
  subscription_id       TEXT,                      -- sub_… that the license follows
  status                TEXT    NOT NULL DEFAULT 'incomplete',  -- Stripe's raw subscription status
  billing_interval      TEXT    CHECK (billing_interval IN ('monthly', 'yearly')),
  period_start          INTEGER,                   -- items.data[0].current_period_start
  period_end            INTEGER,                   -- items.data[0].current_period_end
  trial_end             INTEGER,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  synced_at             INTEGER NOT NULL,          -- last time this row was written from a live Stripe read
  sync_tried_at         INTEGER,                   -- last time a re-read of Stripe was ATTEMPTED (even if it failed)
  trial_denied          INTEGER NOT NULL DEFAULT 0 CHECK (trial_denied IN (0, 1)),  -- 1: this card or email had a trial before
  created_at            INTEGER NOT NULL,
  revoked_at            INTEGER,
  revoked_reason        TEXT    CHECK (revoked_reason IN ('refund', 'dispute', 'fraud', 'manual'))
);
CREATE INDEX licenses_by_subscription ON licenses (subscription_id);

-- One row per minted device (a Mac running Grayout, or a browser on the site).
CREATE TABLE devices (
  device_id      TEXT    PRIMARY KEY,              -- dev_…
  created_at     INTEGER NOT NULL,
  mint_ip_hash   TEXT,                             -- HMAC(DEVICE_SECRET, ipKey), first 32 hex chars; cleared after 48 h
  free_used      INTEGER NOT NULL DEFAULT 0 CHECK (free_used >= 0),
  trial_used_at  INTEGER,                          -- set once this device started a trial or held a license
  license_id     INTEGER REFERENCES licenses (id), -- the license this device USES (/v1/restore returns it)
  bought_license_id INTEGER REFERENCES licenses (id), -- the license this device last BOUGHT (app or website);
                                                   -- only used to refuse a second purchase, never to serve or restore
  checkout_lock_at INTEGER,                        -- set while /v1/checkout runs for this device (one at a time)
  last_seen_at   INTEGER
);
CREATE INDEX devices_by_mint_ip ON devices (mint_ip_hash, created_at);
CREATE INDEX devices_by_license ON devices (license_id);
CREATE INDEX devices_by_bought_license ON devices (bought_license_id);

-- Polling handles for purchases started in the app.
CREATE TABLE device_codes (
  code        TEXT    PRIMARY KEY,                 -- 8 Crockford characters, stored without the dash
  device_id   TEXT    NOT NULL REFERENCES devices (device_id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX device_codes_by_device ON device_codes (device_id);

-- Every Checkout Session this service created. The only way a session maps to a device.
CREATE TABLE checkout_sessions (
  session_id   TEXT    PRIMARY KEY,                -- cs_…
  device_id    TEXT    NOT NULL REFERENCES devices (device_id),
  device_code  TEXT,                               -- set when the app started it
  plan         TEXT    NOT NULL CHECK (plan IN ('monthly', 'yearly')),
  trial        INTEGER NOT NULL CHECK (trial IN (0, 1)),
  livemode     INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  state        TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paid', 'failed', 'expired')),
  license_id   INTEGER REFERENCES licenses (id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  checked_at   INTEGER                             -- last time /v1/claim asked Stripe about it
);
CREATE INDEX checkout_sessions_by_code ON checkout_sessions (device_code);
CREATE INDEX checkout_sessions_by_device ON checkout_sessions (device_id, state);

-- Paid checks per license per calendar month (UTC).
CREATE TABLE usage (
  license_id  INTEGER NOT NULL REFERENCES licenses (id),
  month       TEXT    NOT NULL,                    -- 'YYYY-MM'
  n           INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  last_at     INTEGER NOT NULL DEFAULT 0,          -- time of the last served check
  PRIMARY KEY (license_id, month)
);

-- Free checks served to everyone, per UTC day.
CREATE TABLE free_budget (
  day  TEXT    PRIMARY KEY,                        -- 'YYYY-MM-DD'
  n    INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0)
);

-- Free checks per network per calendar month (UTC), whatever devices it mints.
CREATE TABLE free_network (
  net_hash  TEXT    NOT NULL,                      -- HMAC(DEVICE_SECRET, network key), first 32 hex chars
  month     TEXT    NOT NULL,                      -- 'YYYY-MM'; rows from past months are deleted daily
  n         INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (net_hash, month)
);

-- Free checks per IPv6 /48 block per UTC day. One /48 holds 256 networks
-- (/56), and some providers give a /48 away, so one block may take only a
-- small share of each day's budget. IPv4 has no rows here.
CREATE TABLE free_block (
  block_hash  TEXT    NOT NULL,                    -- HMAC(DEVICE_SECRET, '/48' key), first 32 hex chars
  day         TEXT    NOT NULL,                    -- 'YYYY-MM-DD'; deleted after 7 days
  n           INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (block_hash, day)
);

-- Who has had a free trial: keyed hashes of the buyer's email and card
-- fingerprint. A second trial with the same email or card ends at once.
CREATE TABLE trial_marks (
  mark         TEXT    PRIMARY KEY,                -- 'email:' or 'card:' + HMAC(LICENSE_SECRET, value), hex
  customer_id  TEXT    NOT NULL,                   -- the customer whose trial set this mark first
  created_at   INTEGER NOT NULL                    -- deleted after a year
);

-- Webhook events already handled, for de-duplication.
CREATE TABLE processed_events (
  event_id      TEXT    PRIMARY KEY,               -- evt_…
  type          TEXT    NOT NULL,
  processed_at  INTEGER NOT NULL
);
```

### 12.2 Why each table exists

| Table | Replaces (v2 KV) | Fixes |
|---|---|---|
| `licenses` | `lic:`, `cus:`, `cus:pending:` | duplicate keys (UNIQUE), status from live reads, no parking |
| `devices` | `dev:` | atomic free counter, trial memory (claimed at checkout), mint limit, what it bought, checkout lock |
| `device_codes` | `code:` | — |
| `checkout_sessions` | (new) | claims never call Stripe for unknown ids; no metadata mapping |
| `usage` | `use:<license>:<YYYY-MM>` | atomic increment, slow mode past the allowance |
| `free_budget` | (new) | global cap on free spend |
| `free_network` | (new) | per-network monthly cap on free checks, so re-minting devices does not help |
| `free_block` | (new) | per-IPv6-/48 daily share of the free budget, so one block of 256 networks cannot drain the day |
| `trial_marks` | (new) | one trial per email and card (keyed hashes only), across devices and browsers |
| `processed_events` | (new) | webhook de-duplication |

### 12.3 The atomic statements

Each is one SQL statement, so two requests at the same moment cannot both slip
through. Each was run against SQLite on 2026-10-07 and behaves as described.

```sql
-- Mint a device, at most ?4 (10) per ip hash per rolling hour. No row back = refused.
INSERT INTO devices (device_id, created_at, mint_ip_hash)
SELECT ?1, ?2, ?3
WHERE (SELECT COUNT(*) FROM devices WHERE mint_ip_hash = ?3 AND created_at > ?2 - 3600) < ?4
RETURNING device_id;

-- Reserve one free check on a device (?3 = 100). No row back = free_exhausted / device.
UPDATE devices SET free_used = free_used + 1, last_seen_at = ?2
WHERE device_id = ?1 AND free_used < ?3
RETURNING free_used;

-- Reserve one free check from today's budget (?2 = FREE_DAILY_BUDGET). No row back = daily_budget.
INSERT INTO free_budget (day, n) VALUES (?1, 1)
ON CONFLICT (day) DO UPDATE SET n = n + 1 WHERE free_budget.n < ?2
RETURNING n;

-- Reserve one paid check (?4 = 10000 included, ?5 = 600 seconds slow interval).
-- No row back = over the allowance and inside the slow interval: quota_exceeded.
INSERT INTO usage (license_id, month, n, last_at) VALUES (?1, ?2, 1, ?3)
ON CONFLICT (license_id, month) DO UPDATE SET n = n + 1, last_at = ?3
  WHERE usage.n < ?4 OR usage.last_at <= ?3 - ?5
RETURNING n;

-- Reserve one free check from this network's month (?3 = 300). No row back = free_exhausted / device.
INSERT INTO free_network (net_hash, month, n) VALUES (?1, ?2, 1)
ON CONFLICT (net_hash, month) DO UPDATE SET n = n + 1 WHERE free_network.n < ?3
RETURNING n;

-- Reserve one free check from this IPv6 /48 block's share of today (?3 = 150). No row back = daily_budget.
INSERT INTO free_block (block_hash, day, n) VALUES (?1, ?2, 1)
ON CONFLICT (block_hash, day) DO UPDATE SET n = n + 1 WHERE free_block.n < ?3
RETURNING n;

-- Store a device code, at most ?5 (5) unexpired per device. No row back = at the cap
-- (then 429 rate_limited) or, very rarely, the random code is taken (then try another).
INSERT INTO device_codes (code, device_id, created_at, expires_at)
SELECT ?1, ?2, ?3, ?4
WHERE (SELECT COUNT(*) FROM device_codes WHERE device_id = ?2 AND expires_at > ?3) < ?5
ON CONFLICT (code) DO NOTHING
RETURNING code;

-- Claim the device's trial when a trial checkout is created. No row back = no trial.
UPDATE devices SET trial_used_at = ?2 WHERE device_id = ?1 AND trial_used_at IS NULL RETURNING device_id;

-- Take the device's checkout lock (?3 = 30 seconds). No row back = another checkout is running.
UPDATE devices SET checkout_lock_at = ?2
WHERE device_id = ?1 AND (checkout_lock_at IS NULL OR checkout_lock_at <= ?2 - ?3)
RETURNING device_id;

-- Give a reservation back after an upstream failure the provider did not bill (6.11 step 5).
UPDATE devices      SET free_used = free_used - 1 WHERE device_id = ?1 AND free_used > 0;
UPDATE free_network SET n = n - 1 WHERE net_hash = ?1 AND month = ?2 AND n > 0;
UPDATE free_block   SET n = n - 1 WHERE block_hash = ?1 AND day = ?2 AND n > 0;
UPDATE free_budget  SET n = n - 1 WHERE day = ?1 AND n > 0;
UPDATE usage        SET n = n - 1 WHERE license_id = ?1 AND month = ?2 AND n > 0;
```

License issuance is in 7.1.

### 12.4 Daily cleanup

A Cron Trigger (`"triggers": { "crons": ["17 4 * * *"] }`) runs a `scheduled`
handler once a day. The `?now`-style names stand for values the handler binds
(Unix seconds, or `'YYYY-MM-DD'` / `'YYYY-MM'` strings):

```sql
DELETE FROM free_network      WHERE month < ?thisMonth;                -- 'YYYY-MM'
DELETE FROM trial_marks       WHERE created_at   < ?now - 365 * 86400;
DELETE FROM device_codes      WHERE expires_at   < ?now - 86400;
-- An unpaid trial checkout hands its device's trial claim back before its row
-- goes (the same rule as releaseTrialClaim). Once the row is deleted nothing
-- else could, and a buyer who came back after 30 days was never offered the trial.
UPDATE devices SET trial_used_at = NULL
WHERE license_id IS NULL AND bought_license_id IS NULL AND trial_used_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM checkout_sessions s
              WHERE s.device_id = devices.device_id AND s.trial = 1 AND s.state <> 'paid'
                AND s.created_at = devices.trial_used_at AND s.created_at < ?now - 30 * 86400);
DELETE FROM checkout_sessions WHERE created_at   < ?now - 30 * 86400;
DELETE FROM processed_events  WHERE processed_at < ?now - 30 * 86400;  -- Stripe retries for 3 days at most
DELETE FROM free_budget       WHERE day < ?sevenDaysAgo;               -- 'YYYY-MM-DD'
DELETE FROM free_block        WHERE day < ?sevenDaysAgo;               -- 'YYYY-MM-DD'
DELETE FROM usage             WHERE month < ?thirteenMonthsAgo;        -- 'YYYY-MM'; keeps a year for the runbook
UPDATE devices SET mint_ip_hash = NULL WHERE mint_ip_hash IS NOT NULL AND created_at < ?now - 172800;
```

All of these run in one `DB.batch`, so the trial claims are handed back in
the same transaction that deletes their rows.

### 12.5 What is stored about a person (for the privacy page)

- **Per device:** a random id, when it was created and last seen, how many free
  checks it used, whether it started a trial, which license it uses, and for 48
  hours a keyed hash of its IP address (only to limit how many devices one
  network can mint).
- **Per license:** the Stripe customer id, the subscription state copied from
  Stripe, and monthly check counts.
- **Per network:** a keyed hash of the network address and how many free
  checks it used this month (deleted when the month ends), and for IPv6 a
  keyed hash of its /48 block and how many free checks the block used each
  day (deleted after 7 days).
- **Per trial, for a year:** keyed hashes (HMAC with `LICENSE_SECRET`) of the
  buyer's email and card fingerprint, only to give one free trial per person.
  The hash cannot be turned back into the email or card.
- **Never stored:** images, prompts, verdicts, IP addresses in clear,
  names, emails, card details, license keys. This covers Cloudflare's logs
  too: only the service's own log lines are kept (section 15), and the
  per-request invocation logs, which would hold each request's headers and
  client IP, are off (section 13).

---

## 13. Secrets, settings and constants

Secrets. The owner sets them with `npx wrangler secret put <NAME>`, and for
`wrangler dev` in `server/.dev.vars` (gitignored). An agent never sets,
prints or stores them.

| Name | Format | Checked at use (fail closed with `not_configured`) |
|---|---|---|
| `STRIPE_SECRET_KEY` | A **restricted** key, `rk_live_…` or `rk_test_…` (permissions in 14.4) | present, starts with `rk_` or `sk_`, not a placeholder. An `sk_` key works but logs one warning: "use a restricted key". |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the endpoint | matches `^whsec_[A-Za-z0-9+/=_-]{32,}$`; the part after `whsec_` does not contain `placeholder`, `replace` or `example` (any case), has no **word** made only of 3 or more x's (`whsec_xxxx…`, `whsec_XXX_paste_here…`; words are split at anything not a letter or digit), and is not one character repeated. `xxx` is never matched inside a word: a real random secret holds three x's in a row about once in 1,000, and refusing it would make every webhook answer 503 |
| `OPENAI_API_KEY` | The service's own model key | present |
| `DEVICE_SECRET` | 32+ random bytes, base64 (`openssl rand -base64 48`) | at least 32 characters |
| `LICENSE_SECRET` | 32+ random bytes, base64. **Never rotate.** | at least 32 characters |

A placeholder secret never opens anything. v2's runbook told the owner to deploy
with `whsec_placeholder`; that string is public, so anyone could have forged a
webhook and minted a license. In v3 that value fails the check, and the
webhook endpoint is registered before the first deploy (14.3), so the real
secret exists in time.

Plain settings in `wrangler.jsonc` `vars` (committed, not secret):

| Name | Value |
|---|---|
| `SITE_URL` | `https://aarushkandukoori.github.io/grayout` |
| `SITE_ORIGINS` | `https://aarushkandukoori.github.io` |
| `STRIPE_PRODUCT` | `prod_…` of Grayout Pro. Existing subscribers are recognised by this (7.3) |
| `STRIPE_PRICE_MONTHLY` | `price_…` for $9.99 / month (new checkouts only) |
| `STRIPE_PRICE_YEARLY` | `price_…` for $79 / year (new checkouts only) |
| `ALLOW_TEST_LICENSES` | `"1"` on the **sandbox Worker only**; never set on live (7.2) |
| `FREE_DAILY_BUDGET` | `"3000"` (sandbox Worker: `"200"`, shared with test-license checks, 6.11 step 3) |
| `SUPPORT_EMAIL` | the address in Stripe's business details |
| `MODEL` | `gpt-5-mini` |

Two Workers from one `wrangler.jsonc`: the top level is the live Worker
`grayout-api`; `env.sandbox` is `grayout-api-sandbox` with its own D1
`grayout-sandbox`, its own rate-limit namespaces and the sandbox product and
prices. Bindings: `DB`, the seven rate limiters in section 11, the cron
trigger in 12.4. `observability` stays on for the service's own log lines
(URLs carry no secrets, and request bodies are never logged), with
`logs.invocation_logs: false` and `traces.enabled: false`: Cloudflare's
per-request invocation logs and traces would store each request's metadata
and headers, the client IP among them, which 12.5 promises is never stored.
`npx wrangler tail` still streams requests live without storing them. The
sandbox Worker inherits the same block.

Code constants (server):

| Constant | Value |
|---|---|
| `STRIPE_API_VERSION` | `'2026-08-26.dahlia'` (stripe-node `^22.6.0`; a test asserts this equals the version the installed stripe-node pins) |
| `INTEGRATION_IDENTIFIER` | `'grayout_pro_kaklnzxs'` |
| `TRIAL_DAYS` | `7` |
| `FREE_CHECKS` | `100` |
| `FREE_CHECKS_PER_NETWORK` | `300` (per calendar month) |
| `NETWORK_V6_PREFIX_BITS` | `56` (`netKey`) |
| `BLOCK_V6_PREFIX_BITS` | `48` (`blockKey`, IPv6 only) |
| `FREE_DAILY_SHARE_DIVISOR` | `20` (a /48 block's daily share: budget / 20, at least `FREE_CHECKS`) |
| `MAX_IMAGE_WIDTH` / `MAX_IMAGE_HEIGHT` / `MAX_IMAGE_BYTES` | `1366` / `2 * 1366` / `1536 * 1024` (per JPEG in a check) |
| `INCLUDED_CHECKS` | `10000` |
| `TRIAL_CHECKS` | `1000` (a month, until a payment has gone through, 7.2) |
| `MAX_LIVE_DEVICE_CODES` | `5` (unexpired device codes per device, 6.4) |
| `OVER_ALLOWANCE_INTERVAL_SECONDS` | `600` |
| `GRACE_SECONDS` | `3 * 86400` |
| `DEVICE_CODE_TTL_SECONDS` / Checkout `expires_at` | `3600` |
| `SESSION_RECHECK_SECONDS` | `10` |
| `DENY_RECHECK_SECONDS` | `900` |
| `STALE_SYNC_SECONDS` | `86400` |
| `MINTS_PER_IP_PER_HOUR` | `10` |
| `MAX_CHECK_BODY_BYTES` / `MAX_BODY_BYTES` | `8 * 1024 * 1024` / `1024 * 1024` |

Deploy-time constants: the API base in `src/config.js` and `docs/config.js`
(section 3), and the site CSP `connect-src`. Optional for the site:
`window.GRAYOUT_PORTAL_LOGIN_URL` in `docs/config.js` (the billing portal login
link from 14.2) for a "Manage billing" link that needs no license.

---

## 14. What the owner sets up in Stripe and Cloudflare

Only the owner does these. Do each in a **sandbox first** (one sandbox for local
development, one for staging), then live. Never the shared test mode. The
sandbox gets its own Worker and database (`bash server/scripts/deploy.sh
sandbox`); live gets a fresh, empty one (`bash server/scripts/deploy.sh live`).
Never point the public site or app at the sandbox Worker.

### 14.1 Stripe account and catalogue

1. Settings → Managed Payments: activate it.
2. Product **Grayout Pro**, tax code `txcd_10105003`. Two prices, USD,
   `tax_behavior: exclusive`: $9.99 every month, $79 every year. Put the two
   `price_…` ids in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`. The trial
   is not on the price; the service asks for it per session.
3. Settings → Business details: a real, watched support email (the same as
   `SUPPORT_EMAIL`).
4. Settings → Checkout: add the terms and privacy URLs. Turn on "Limit customers
   to one subscription" with the redirect to the billing portal (this needs the
   portal login link from 14.2). Confirm in the sandbox that it fires for a
   Managed Payments session.
5. Billing → Subscriptions and emails: "If all retries for a payment fail" →
   **cancel the subscription**. "Manage disputed payments" → **cancel the
   subscription immediately** (card disputes for the full amount; our webhook
   cancels anyway).
6. Radar: turn on free-trial abuse protection
   (<https://docs.stripe.com/radar/free-trial-abuse>) if it is offered with
   Managed Payments. The service already limits trials per email and card
   (7.1 step 6); this is a second guard. Confirm in the sandbox that
   `subscriptions.update(sub, { trial_end: "now" })` works on a Managed
   Payments trial.

### 14.2 Billing portal (Settings → Billing → Customer portal)

- Cancel subscriptions: on, **at the end of the billing period**, ask for a
  reason.
- Update payment methods: on.
- Switch plans: on, product Grayout Pro with both prices, prorate changes,
  downgrades **take effect immediately** (scheduled downgrades would stop the
  customer cancelling in the portal until they take effect).
- Changes during a trial **keep the trial** (`features.subscription_update.trial_update_behavior: "continue_trial"`;
  set it with the API if the Dashboard does not show it).
- Login link: on. Copy it for `GRAYOUT_PORTAL_LOGIN_URL`.
- **Test in the sandbox** with a Managed Payments subscription: switch monthly
  ↔ yearly, cancel, update the card. Stripe documents the portal as working with
  Managed Payments, but plan switching on a Managed Payments subscription is not
  spelled out. If switching fails, turn "Switch plans" off and change the site's
  copy to "To switch between monthly and yearly, cancel and subscribe again."

### 14.3 Webhook endpoint (before the first deploy)

The workers.dev URL is known before the first deploy, so register the endpoint
first. The real `whsec_` then exists before the Worker ever answers.

- URL: `https://grayout-api.<subdomain>.workers.dev/v1/stripe/webhook`
- **API version: `2026-08-26.dahlia`, set explicitly** on the endpoint (the
  Dashboard asks for it when creating a destination; with the API, pass
  `api_version`). Stripe sends each endpoint its events in that endpoint's API
  version. A new account's default is newer (`2026-09-30.endive`), and its
  event shapes are not the ones this code reads.
- Events: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `customer.subscription.paused`, `customer.subscription.resumed`,
  `invoice.paid`, `invoice.payment_failed`, `charge.refunded`,
  `charge.dispute.created`, `radar.early_fraud_warning.created` (13 events).
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 14.4 The restricted API key

Create `rk_…` keys (one per sandbox, one for live) with only:

| Resource | Access | Used for |
|---|---|---|
| Checkout Sessions | Write | create, retrieve |
| Customer portal | Write | portal sessions |
| Subscriptions | Write | list, retrieve, cancel |
| Invoices | Read | retrieve; list invoice payments (grant Invoice Payments read too if the Dashboard lists it separately) |
| Charges | Read | retrieve a disputed charge or a fraud warning's charge |
| Refunds | Write | refund a second subscription one device bought by mistake (7.1 step 3) |
| Payment Methods | Read | the card fingerprint for one trial per card (without it, only the email counts) |
| Radar early fraud warnings | Read, if listed | (events only; listed for completeness) |
| Everything else | None | |

Then run a full sandbox purchase, refund and dispute while
`stripe logs tail` is open, and add any permission that shows a 403. Verifying
webhooks needs no API key.

### 14.5 Cloudflare

1. Workers **Paid** plan.
2. `bash server/scripts/deploy.sh sandbox`: creates `grayout-sandbox`, applies
   the migrations, deploys `grayout-api-sandbox`. It writes the sandbox
   address into nothing public.
3. The five secrets (section 13), each with `--env sandbox`. `GET /v1/health`
   should show every `configured` flag true and `"mode": "test"`.
4. Go live: `bash server/scripts/deploy.sh live` creates the separate, empty
   `grayout` database, deploys `grayout-api`, fills the API base into
   `src/config.js` and `docs/config.js`, and checks every site page's CSP
   allows it (it stops if not). Then the five live secrets without `--env`,
   and `"mode": "live"` in `/v1/health`.

### 14.6 Hand-run D1 operations

```bash
# Clear a revocation (after deciding to let a refunded or disputed customer back in)
npx wrangler d1 execute grayout --remote --command "UPDATE licenses SET revoked_at = NULL, revoked_reason = NULL WHERE customer_id = 'cus_…'"
# Delete a customer's record (after Stripe emails about a data deletion request).
# The script checks the cus_… id and prints one wrangler command; read it, then run it.
node server/scripts/delete-customer.js cus_…              # add --sandbox for the sandbox database
```

The delete command clears, in this order, everything that points at the
customer's license (`devices.license_id`, `devices.bought_license_id`,
`checkout_sessions.license_id`), deletes its `usage` rows and its
`trial_marks` (keyed hashes of the buyer's email and card), and deletes the
`licenses` row last. D1 enforces foreign keys, so a `licenses` row that a
column still points at cannot be deleted; no step ever leaves one pointing at
nothing, and running the command again after it stopped half-way finishes
the job. `server/test/third-pass.test.js` runs it after a real purchase and
checks it covers every column that points at `licenses` or holds a customer
id, so a schema change that adds one fails a test.

`SELECT` on `licenses` is always safe to run and to paste into a chat: there are
no keys in it.

Resending a lost key: the database cannot show it, but it can be derived again.
The server team provides `server/scripts/license-key.js`, which the owner runs
locally as `LICENSE_SECRET=… node server/scripts/license-key.js cus_…` and which
prints the key for that customer (the `livemode` flag of the customer's
`licenses` row picks the prefix). The owner then sends it to the buyer by email.
This is the recovery path for a website buyer who lost the key, since a website
purchase is never attached to a device.

---

## 15. Security rules

- The model key lives only in the Worker's secrets. It is never returned.
- License keys, device tokens, device codes and Checkout Session ids never
  appear in a URL, a log line or an error message. A session id that has to be
  logged is cut to its last 4 characters.
- License keys are never stored, only their SHA-256 (4.2). Device tokens are
  never stored at all (4.1).
- Token and signature comparisons are constant-time.
- Images are never stored, logged or written to disk by the service. They go to
  the model provider and are dropped.
- The prompt fences untrusted task text and tells the model to ignore
  instructions found in it.
- Allowed log fields: request id, route, HTTP status, error code, Stripe
  customer, subscription, event ids and event type, and the named log lines in
  this file (`duplicate_subscription`, `duplicate_purchase`,
  `duplicate_undo_failed`, `duplicate_refund_unresolved`,
  `checkout_expire_failed`, `refund_unresolved`, `dispute_unresolved`).
  Nothing else from a request body.
- Webhooks are verified on the raw body before anything else, and fail closed
  without a real secret.
- `/v1/check` refuses anything but `application/json` and answers no browser
  (no CORS).
- Every Stripe call uses the restricted key. No Stripe key ever reaches the app
  or the site.

---

## 16. Client duties

### 16.1 App (`src/`, `main.js`, `ui/`)

- `DEFAULT_API_BASE` lives in `src/config.js` (one line, section 3). The
  placeholder means no network.
- Mint a device once (`/v1/device`); `deviceId` in `state.json`, `deviceToken`
  in `secrets.bin` (`grayoutDeviceToken`). Send both on every device-scoped
  call.
- Use `POST` for claim and status. The license goes in the body or an
  `Authorization: Bearer` header, never in a URL.
- Send no `Origin` header (Node's `fetch` in the main process sends none). The
  service reads a missing `Origin` as "from the app" to pick the billing
  portal's return page (6.10).
- Purchase: `/v1/device-code`, then `/v1/checkout` with the code, open `url` in
  the browser, poll `/v1/claim` (6.6). Stop on terminal answers. When the window
  closes, `/v1/restore` later.
- Never two payable checkouts from one Mac: while the last checkout for the
  same plan has more than 5 minutes left, Subscribe reopens that same `url`
  and polls the same code instead of asking for a new code and session.
  Cancelling the wait keeps it; paid, failed or expired forgets it.
- A key that `/v1/restore` hands back after a checkout timed out or its code
  expired counts as the purchase only when the plan is served (`service:
  true`). A lapsed subscription's old key always comes back, and it is not a
  purchase.
- Settings offers both plans (monthly and yearly), so a returning buyer checks
  out through this Mac's device (known customer, no second trial) and never
  needs the website.
- `no_license` → `/v1/restore`. `already_subscribed` → offer "Manage
  subscription" (`portalUrl`) and "Restore my key" (`/v1/restore`). The copy for
  either never says "subscribe".
- Show `service` and `status` from `/v1/status`; never work out access locally.
- Honour `retryAfter` on `rate_limited` and `quota_exceeded`.
- Everything that is not a clean verdict counts as on-task.

### 16.2 Site (`docs/`)

- `window.GRAYOUT_API_BASE` lives in `docs/config.js` (one line, section 3).
  Placeholder → "Subscriptions open soon", no fetch.
- Pricing page: mint a browser device once (`/v1/device`, kept in
  `localStorage` `grayout.device`), then `POST /v1/checkout`. On
  `device_unverified` mint once and retry once. A browser device never holds a
  license, so `already_subscribed` should not happen here; if it does, show the
  `portalUrl`. Subscribers coming back from another browser are caught by
  Stripe's "one subscription per customer" setting (14.1), which matches on
  email.
- `success.html`: `POST /v1/claim { sessionId }`, poll for 120 seconds with
  backoff, "reload this page" on timeout (6.6). The key regex accepts
  `gry_live_` and `gry_test_`.
- `from=app` (the app started it, so the visitor already has Grayout):
  `pricing.html?canceled=1&from=app` says nothing was charged and the tab can
  be closed to go back to Grayout; `account.html?from=app` (back from a
  billing portal the app opened) says the tab can be closed to go back to
  Grayout. Neither pushes the download. Without `from=app` both pages behave
  as before.
- Prices say "plus tax where it applies". Terms, privacy and checkout copy say
  "sold through Link" and "LINK.COM*" (section 10). "Manage billing" links to
  `GRAYOUT_PORTAL_LOGIN_URL` when set, and always mentions link.com.
- Privacy page describes exactly what 12.5 lists.
- CSP `connect-src` gets the workers.dev origin; drop `grayout.app` until it is
  owned.

---

## 17. Stripe facts (verified 2026-10-07)

Checked against Stripe's documentation through the Stripe docs search tool on
2026-10-07, and against stripe-node's type definitions where noted. "Inferred"
means the docs imply it without saying it outright; each inferred fact has a
sandbox test in section 14 or 18.

**Managed Payments: turning it on**

1. Set `managed_payments: { enabled: true }` on `checkout.sessions.create`.
   Needs API version `2025-03-31.basil` or later and activation in Dashboard →
   Settings → Managed Payments. Only new subscriptions bought through a Managed
   Payments Checkout Session qualify.
   <https://docs.stripe.com/payments/managed-payments/set-up>,
   <https://docs.stripe.com/payments/managed-payments/update-checkout>
2. Not supported: Connect, Elements and other advanced integrations, third-party
   tax integrations, and **creating a subscription outside Checkout or Payment
   Links**. <https://docs.stripe.com/payments/managed-payments>

**Managed Payments: Checkout Session parameters (subscription mode)**

3. Must be removed: `adaptive_pricing` (always on), `automatic_tax`,
   `tax_id_collection`, `subscription_data.default_tax_rates`,
   `payment_method_configuration`, `payment_method_types`,
   `customer_update[name]`, `customer_update[address]`,
   `shipping_address_collection`, `shipping_options`,
   `subscription_data.application_fee_percent`, `subscription_data.on_behalf_of`,
   `subscription_data.transfer_data`, `subscription_data.invoice_settings`,
   `invoice_creation`.
   <https://docs.stripe.com/payments/managed-payments/update-checkout>
4. The Payment Links version of the list also names
   `payment_intent_data.statement_descriptor`, `…statement_descriptor_suffix`,
   `consent_collection.payment_method_reuse_agreement.position`, `custom_text`
   and `submit_type` `donate`/`book`. We pass none of them on Checkout either.
   <https://docs.stripe.com/payments/managed-payments/use-payment-links>
5. **`customer` is supported:** "If you provide the ID of an existing … customer
   when you create the Checkout Session, that object is updated with any changes
   to the customer's name or billing address." Managed Payments needs a name and
   a valid billing address to calculate tax, and collects them itself.
   <https://docs.stripe.com/payments/managed-payments/update-checkout>
6. **Trials are supported.** `subscription_data.trial_period_days` works;
   Managed Payments sends a trial confirmation email (changelog 2026-04-22).
   `payment_method_collection: "if_required"` (a trial without a card) is
   allowed since 2026-02-09; the default collects a payment method. Stripe's
   trial-ending reminder is sent only for trials longer than 7 days.
   <https://docs.stripe.com/payments/managed-payments/changelog>,
   <https://docs.stripe.com/payments/managed-payments/how-it-works>,
   <https://docs.stripe.com/payments/checkout/free-trials>
7. *Inferred:* `client_reference_id`, `success_url`, `cancel_url`,
   `allow_promotion_codes`, `billing_address_collection` and `expires_at` are not
   on the forbidden list, so they are allowed. Stripe's own Managed Payments
   example passes `success_url`. Still to confirm with the first sandbox
   checkout.
8. `integration_identifier` was added in `2026-03-25.dahlia`. Optional, up to
   200 characters of letters, digits, dashes, underscores and periods. Stripe's
   integration guidance asks for a label ending in 8 random letters.
   <https://docs.stripe.com/changelog/dahlia/2026-03-25/adds-integration-identifier-parameter-to-checkout-sessions>
9. Tax code `txcd_10105003` ("AIaaS – Cloud Based & Downloaded – Personal Use")
   became eligible for Managed Payments on 2026-06-02. Managed Payments uses the
   price's `tax_behavior`; when unspecified, it adds tax on top.
   <https://docs.stripe.com/payments/managed-payments/changelog>,
   <https://docs.stripe.com/payments/managed-payments/set-up>

**Customer Portal and Link**

10. The customer portal lists Managed Payments under the products it works with.
    Managed Payments buyers can always use link.com to view orders, cancel or
    update subscriptions, update payment methods and billing address; "you can
    also offer additional subscription management from your own website using
    the Customer Portal". You can update subscriptions and issue refunds through
    the Dashboard or the API; `payment_behavior` on updates and subscription
    schedules work with Managed Payments since 2026-02-09.
    <https://docs.stripe.com/customer-management>,
    <https://docs.stripe.com/payments/managed-payments/how-it-works>,
    <https://docs.stripe.com/payments/managed-payments/changelog>
11. *Inferred, test in sandbox:* the docs do not spell out portal **plan
    switching** for a Managed Payments subscription (14.2 has the test and the
    fallback copy).
12. Portal limits that shape our settings: no update or cancel while a
    subscription schedule change is pending; a change during a trial ends the
    trial unless `trial_update_behavior` is `continue_trial`; at most 10
    products for plan switching; portal sessions expire after 5 minutes unused,
    then 1 hour after the last activity; it cannot run in an iframe.
    <https://docs.stripe.com/customer-management>,
    <https://docs.stripe.com/customer-management/configure-portal>

**Refunds and disputes**

13. Stripe handles disputes on Managed Payments transactions: it reviews each
    one, submits evidence on our behalf or accepts it. Disputes appear in our
    Dashboard, where we may also accept or counter; the dispute received fee is
    charged to us. <https://docs.stripe.com/payments/managed-payments/how-it-works>
14. `charge.dispute.created` carries a Dispute with `charge` and a nullable
    `payment_intent`; `charge.refunded` carries the Charge (full or partial
    refund). <https://docs.stripe.com/billing/subscriptions/webhooks>,
    <https://docs.stripe.com/disputes/api>.
    *Inferred:* the dispute lives on our account and the Managed Payments docs
    do not say events are withheld, so `charge.dispute.created` still reaches us.
    Still to confirm with a sandbox dispute using Stripe's dispute test card
    (<https://docs.stripe.com/testing>).
15. `charge.refunded` (the field) is true only for a full refund: "If the charge
    is only partially refunded, this attribute will still be false."
    (stripe-node type definitions, `Charges.d.ts`.)
16. Buyers can ask Link support for refunds; Stripe can refund within 60 days,
    and may refund without approval if a product question goes unanswered for
    48 hours. Refunds include the tax; in some places our balance is also reduced
    by the tax amount. <https://docs.stripe.com/payments/managed-payments/how-it-works>
17. Optional Dashboard setting: cancel subscriptions automatically when a card
    payment is disputed for the full amount (takes effect after about an hour).
    <https://docs.stripe.com/billing/subscriptions/cancel>

**Dahlia field paths**

18. Since `2025-03-31.basil`, `current_period_start` and `current_period_end`
    live on subscription items (`sub.items.data[n].current_period_end`), not on
    the subscription. During a free trial they equal the trial end.
    <https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end>,
    <https://docs.stripe.com/billing/subscriptions/mixed-interval>
19. An invoice's subscription is `invoice.parent.subscription_details.subscription`
    after checking `invoice.parent.type === "subscription_details"`.
    <https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects>
20. From a charge or dispute to its subscription: PaymentIntent id → list invoice
    payments with `payment.type = "payment_intent"`, `payment.payment_intent`,
    `status = "paid"` (paginate) → each invoice →
    `parent.subscription_details.subscription`. The node resource is
    `stripe.invoicePayments.list` (stripe-node types).
    <https://docs.stripe.com/billing/subscriptions/webhooks>
21. A subscription-mode Checkout Session creates the subscription only after
    payment; `session.subscription` and `session.invoice` are null until the
    session completes. <https://docs.stripe.com/changelog/basil>

**Webhooks and versions**

22. Each webhook endpoint can pin its own API version, and Stripe always sends
    that endpoint events in that version. The docs list the current API version
    as `2026-09-30.endive`, a newer major release than our pinned dahlia. That is
    why the endpoint and the SDK are both pinned (14.3).
    <https://docs.stripe.com/api-versions>, <https://docs.stripe.com/webhooks/versioning>
23. Live-mode deliveries are retried for up to 3 days with backoff; sandboxes
    retry three times over a few hours. The same event can arrive more than
    once, and occasionally two separate events describe one change. Signatures
    are checked on the raw body, with a 5-minute default tolerance.
    <https://docs.stripe.com/workbench/event-destinations>,
    <https://docs.stripe.com/webhooks>
24. Checkout fulfilment belongs in handlers for both `checkout.session.completed`
    and `checkout.session.async_payment_succeeded`, gated on `payment_status`;
    Managed Payments Checkout sends the same three `checkout.session.*` events.
    <https://docs.stripe.com/payments/managed-payments/set-up>
25. Subscription statuses: `incomplete` (23 hours to pay), `incomplete_expired`,
    `trialing`, `active`, `past_due`, `canceled` (terminal), plus `unpaid` and
    `paused`. After all retries fail, the Dashboard setting decides between
    canceled, unpaid, or staying past_due.
    <https://docs.stripe.com/billing/subscriptions/overview>
26. Stripe's "limit customers to one subscription" setting matches on the
    Customer passed to the session or on email, treats `active`, `past_due`,
    `unpaid` and `paused` as active, and needs the portal login link turned on.
    <https://docs.stripe.com/payments/checkout/limit-subscriptions>

**Everything else Managed Payments decides**

27. Statement line `LINK.COM* <descriptor>`; receipts and invoices come from
    Link whatever our email settings say; custom domains are not supported on
    Managed Payments checkouts; the checkout footer shows standard terms and can
    link our terms and privacy pages.
    <https://docs.stripe.com/payments/managed-payments/how-it-works>
28. Data deletion: on request Stripe cancels the buyer's Managed Payments
    subscriptions, deletes their data from our Stripe objects, and emails us.
    <https://docs.stripe.com/payments/managed-payments/how-it-works>
29. Eligibility: US businesses are supported; digital products only; buyers in
    Ascension Island, China, Cuba, Iran, Kosovo, North Korea, Russia, Syria and
    Tristan da Cunha cannot buy. <https://docs.stripe.com/payments/managed-payments/eligibility>
30. Recurring payment methods under Managed Payments include cards, Apple Pay,
    Google Pay, Link, Cash App Pay (US), Korean cards, UPI and Pix. Some are
    delayed-notification methods, which is why fulfilment checks
    `payment_status`. <https://docs.stripe.com/payments/managed-payments/how-it-works>
31. Stripe's guidance: restricted keys (`rk_`) over secret keys, separate
    sandboxes over the shared test mode, and resolving refund and dispute events
    through the object graph rather than metadata. (Stripe best-practices skill
    `references/security.md` and `references/billing.md`.)

Cloudflare facts used here and checked locally: a rate-limit binding's `period`
must be 10 or 60 seconds (wrangler 4.44 `config-schema.json`). SQLite upsert
`… DO UPDATE … WHERE` with `RETURNING` returns no row when the `WHERE` is false,
and foreign keys are enforced when switched on (node:sqlite, 2026-10-07).
Workers plan limits must be checked at deploy time.

---

## 18. Testing

- **No network in tests.** D1 is an in-memory SQLite (`node:sqlite`,
  `DatabaseSync`) behind a small shim with D1's shape: `prepare(sql)`,
  `.bind(...values)`, `.first()` (one row or `null`), `.all()` (`{ results }`),
  `.run()` (`{ success, meta: { changes } }`), and `db.batch([...])` run in one
  transaction. The shim applies `server/migrations/*.sql` in order and runs
  `PRAGMA foreign_keys = ON`.
- The rate-limit bindings are faked with an in-memory counter that has the
  binding's `limit({ key })` → `{ success }` shape.
- Stripe is a small fake object with only the methods the server calls
  (`checkout.sessions.create/retrieve/expire`,
  `subscriptions.list/retrieve/update/cancel`, `paymentMethods.retrieve`,
  `invoicePayments.list`, `invoices.retrieve`, `charges.retrieve`,
  `refunds.create`, `billingPortal.sessions.create`,
  `webhooks.constructEventAsync`), holding
  subscriptions in memory, so a test can change "what Stripe says" and deliver
  events in any order.
- Every finding in Appendix A gets a regression test that fails on v2's
  behaviour (`server/test/findings.test.js`), and every finding in Appendix B
  one that fails on the first v3 draft (`server/test/review-findings.test.js`,
  plus `server/test/server-fixes.test.js` for the second pass, whose header
  maps every finding to its test, and `server/test/third-pass.test.js` for the
  third). The tests need Node 22.13 or newer
  (`node:sqlite` without a flag); `deploy.sh` checks for it.
- Before launch, in a sandbox: a trial purchase, a paid yearly purchase, a
  delayed-payment purchase if one is offered, a portal plan switch and cancel, a
  full refund, a partial refund, a dispute, an early fraud warning, a second
  checkout from a subscribed device and from a browser that bought on the
  site (expect 409 both times), and a second trial with the same email from a
  new browser (expect the trial to end at once).

---

## 19. Unchanged from v2

**Change-gating (client side, `src/framehash.js`).** Before spending a call, the
client compares an 8×8 average hash of each display with the previous check. If
every display is within a Hamming distance of 3 **and** the frontmost app is
unchanged **and** no alert is active, the check is skipped and the previous
verdict stands. A real check is forced at least every `forceCheckSec` (default
180). This roughly halves both the bill and the latency of an idle desk, and is
what makes $9.99 work.

**Self-hosting.** The repo is MIT. Setting `provider` to `anthropic` or
`openai` in `config.json`, with a key in the keychain, still works and bypasses
the service entirely. It is documented in the README, never in the product UI.

---

## Appendix A. The 29 confirmed review findings and what fixes them

| # | Finding | Fixed by |
|---|---|---|
| 1 | `invoice.payment_failed` turned a canceled license back into service | 7.3 (status only from a live read; invoices never set status), 7.4 |
| 2 | Subscription events applied in arrival order; parked status could cancel a paid license | 7.3 (live read on every event), 7.1 (no parking; issue then sync) |
| 3 | Redelivered `checkout.session.completed` overwrote newer status; no event dedupe | 7.1 step 5 (sync, never guess), 7.4 (`processed_events`) |
| 4 | Every checkout made a new Customer: endless trials, duplicate subscriptions | 6.5 (409, customer reuse, trial once), 14.1 one-subscription setting |
| 5 | Refunds and disputes not handled; `revokedAt` never written | 7.4 (`charge.refunded`, `charge.dispute.created`), 7.5 |
| 6 | Stale API version and SDK; webhook payload version mismatch | 9 and 13 (dahlia, stripe-node 22), 14.3 (endpoint pinned to dahlia), 17.22 |
| 7 | No tax collection | 1, 2, 10 (Managed Payments is merchant of record) |
| 8 | Runbook used `sk_` and shared test mode | 13 (`rk_`), 14 (sandboxes), 14.4 |
| 9 | Portal set-up did not enable plan switching or end-of-period cancel | 14.2 |
| 10 | Deploy with a public `whsec_placeholder`: forgeable webhooks | 13 (secret checks, fail closed), 14.3 (register first) |
| 11 | Stale events re-granted service; trial with null period never expired | 7.2 (time-bounded access, re-read before refusing), 7.3 |
| 12 | Free tier unlimited by rotating `deviceId`; no IP limit or budget; text/plain POSTs | 4.1 (server-minted devices), 11 (IP limits, global budget), 5 (JSON only, no CORS on `/v1/check`) |
| 13 | App defaulted to unowned `api.grayout.app` | 3 (deploy-time placeholder that is not a URL) |
| 14 | Unauthenticated requests wrote to KV and called Stripe | 11 (bindings, no writes), 6.6 (unknown session ids never reach Stripe), `RL_STRIPE_IP` |
| 15 | Unpaid async checkouts got an active license | 7.1 step 2 (`payment_status` gate), 7.4 async events |
| 16 | License keys and claim codes in GET query strings and logs | 5 (POST only, no query strings), 15 (log rules) |
| 17 | Concurrent `checkout.session.completed` could mint two keys | 4.2 (key derived from customer), 7.1 step 4 (UNIQUE, one batch) |
| 18 | Full secret key where a restricted key is enough | 13, 14.4 |
| 19 | Body read fully before the size check | 5 (count while streaming, 8 MiB / 1 MiB) |
| 20 | Replayed checkout event revived a canceled subscription | 7.1 step 5, 7.3, 7.4 dedupe |
| 21 | No ordering guard; late `payment_failed` or `updated` revived canceled; old subscription could overwrite new | 7.3 (live read, pick the best subscription of our prices), 7.4 |
| 22 | Paid user whose claim lapsed told to subscribe; second checkout double-charged | 6.5 (409), 6.7 (`/v1/restore`), 8 (`no_license` copy), 6.6 polling rules |
| 23 | KV free tier exhausted by about one subscriber | 12 (D1), 11 (bindings write nothing; Workers Paid) |
| 24 | 100-free-check gate keyed on a client-chosen id; racy counter | 4.1, 12.3 (atomic reserve before the model call, give back on failure), 11 |
| 25 | Success page gave up after 18 s and said "open the app" | 6.6 (synchronous issuance, 120 s polling, "reload this page") |
| 26 | Parking race lost `subscription.created`; 24 h TTL shorter than retries | 7.1 and 7.3 (no parking at all) |
| 27 | Unlimited 7-day trials | 6.5 step 3, `devices.trial_used_at`, customer reuse |
| 28 | Refunds and disputes never revoked access | 7.4, 7.5, 7.2 (`license_revoked`) |
| 29 | `active` / `past_due` trusted forever | 7.2 (paid period + 3 days, `period_start` for `past_due`), 14.1 (cancel after failed retries) |

## Appendix B. The 2026-10-08 review of v3 and what fixes it

An independent review of the first v3 server found these. Duplicates are
grouped. Each has a regression test in `server/test/review-findings.test.js`.

| # | Finding | Fixed by |
|---|---|---|
| B1 | Sandbox (`gry_test_`) licenses got real model service, during the sandbox phase and after go-live on the same database | 7.2 Mode (`loadLicense` refuses the other mode; `ALLOW_TEST_LICENSES` only on the sandbox Worker), 7.1 step 1, 13 (two Workers, two databases), 14.5 |
| B2 | Unlimited 7-day trials from fresh devices or private windows; two checkouts at once both got a trial | 6.5 steps 1 and 5 (lock; trial claimed at creation), 7.1 step 6 (one trial per email and card, `trial_end: "now"`), 2 (`TRIAL_CHECKS`), 14.1 Radar |
| B3 | Website buyers were never linked to their purchase, so a second checkout made a second subscription | 6.5 step 4 (`bought_license_id`), 7.1 step 7, 6.5 step 3 (older open sessions expired) |
| B4 | `past_due`, `unpaid` and `paused` customers were sent to a new checkout on the same customer | 6.5 step 4 (live read; any open subscription → 409 with the portal) |
| B5 | One network could take free checks forever and drain the global daily budget | 6.11 step 4 (`free_network`, 300 a month per `netKey`), 4 (`netKey` = IPv6 /56), 11 |
| B6 | Billed model failures gave the budget back, so the global budget no longer capped spend | 6.11 step 5 (give back only when not billed), 8 (`upstream_unavailable`) |
| B7 | Refund and dispute revocation only happened after a successful Stripe cancel | 7.4 (revoke first, then cancel; `cancel_failed` and a retry) |
| B8 | A failing Stripe read was not throttled; `RL_LICENSE` came after the access decision | 7.2 (`sync_tried_at`, `RL_STRIPE_IP` on re-reads), 6.11 step 3 |
| B9 | `/v1/check` parsed 8 MB bodies before any rate limit | 6.11 step 1, 11 (`RL_CHECK_IP`) |
| B10 | `radar.early_fraud_warning.created` was not handled | 7.4, 7.5, 14.3 (13 events), `revoked_reason = 'fraud'` |
| B11 | Changing price ids would lock out every existing subscriber | 7.3 step 2 (match on `STRIPE_PRODUCT`), 13 |
| B12 | `deploy.sh` filled the API address into CSP lines that did not have the placeholder, and reported nothing | 3 (Site CSP; `check-csp.js` stops the live deploy if a page would block the API) |

**Second pass (2026-10-08).** Re-checking the same review against the code
found these left open. Each has a regression test in
`server/test/server-fixes.test.js`, whose header maps all 21 items of the
second pass to their tests.

| # | Finding | Fixed by |
|---|---|---|
| B13 | The sandbox Worker (address guessable from the live one) served test-card keys up to 10,000 checks a month each on the real model key | 6.11 step 3 and 7.2 Mode (test-license checks share `FREE_DAILY_BUDGET`), 11 |
| B14 | One IPv6 /48 (256 networks, sometimes free) could still drain the day's free budget | 5 (`blockKey`), 6.11 step 4 (`free_block`, a twentieth of the budget a day), 11, 12 |
| B15 | Image size was unbounded, so one check could cost several times the budgeted $0.0007 | 6.11 step 1 (`MAX_IMAGE_*`, webcam at low detail), 2 (re-check `INCLUDED_CHECKS`), 13 |
| B16 | `deploy.sh` and the README accepted Node 22.0 to 22.12, where the tests cannot load `node:sqlite` | `deploy.sh` checks for 22.13, README step 2, 18 |
| B17 | A paid second session could still move a device onto a second subscription; an expire that failed was marked expired while Stripe still took payment | 7.1 step 3 (cancel and refund the duplicate, keep the device's license), 6.5 step 3 (stop when the expire fails), 14.4 (Refunds: Write) |

**Third pass (2026-10-08).** A further review of the code found these. Each
has a regression test in `server/test/third-pass.test.js`, whose header maps
all 8 items (two are the same bug) to their tests.

| # | Finding | Fixed by |
|---|---|---|
| B18 | The runbook's "delete a customer" SQL never cleared `devices.bought_license_id` (a foreign key), so the final `DELETE` always failed, after earlier statements had already run; it also left `trial_marks` | 14.6 (`server/scripts/delete-customer.js`, every reference cleared first, safe to run again) |
| B19 | An abandoned trial checkout lost the device's trial for good once the 30-day cleanup deleted its row; a claim that found the session expired never handed the claim back either | 12.4 (hand the claim back before the delete), 6.6 (an expired claim hands it back), 6.5 step 5 |
| B20 | A base64 image whose length is 1 more than a multiple of 4 made `atob` throw: `/v1/check` answered 500 and logged `internal_error`, even before the device was verified | 6.11 step 1 (malformed base64 is `400 bad_request`) |
| B21 | The webhook-secret check refused any real secret containing `xxx` (about 1 in 1,000), so every webhook got 503 for that owner | 13 (placeholders matched as whole words, never inside one) |
| B22 | A trial whose first charge failed, and a repeat trial whose immediate charge failed, got 3 days of `past_due` grace at the full 10,000-check allowance | 7.2 (no grace when the unpaid period began at the trial's end; `TRIAL_CHECKS` until a payment goes through), 2 |
| B23 | Checkout and fulfilment looked at only one license (`license_id`, else `bought_license_id`), so a pasted, ended key hid the device's own live subscription and a second one was sold, on the pasted key's customer | 6.5 step 4 (both licenses; customer reused only from the bought one), 7.1 step 3 |
| B24 | `/v1/device-code` had no per-device limit, so one device on many IPv6 /64s could write rows without end; `/v1/checkout` wrote its lock before any per-device limit or plan check | 6.4 (`RL_DEVICE`, at most 5 live codes per device), 6.5 step 1, 11, 12.3 |
