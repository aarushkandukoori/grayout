# Grayout hosted API — the contract (v2)

Everything in this file is binding for the app (`src/`), the service (`server/`)
and the site (`docs/`). If you need to change it, change it here first.

## What changed in v2

Grayout used to ask every person for their own Anthropic or OpenAI key. It now
sells a subscription and makes the model calls itself. The app never sees a
model key; it holds a Grayout license key and talks only to the Grayout API.

Self-hosting stays possible because the repo is MIT: setting `provider` to
`anthropic` or `openai` in `config.json` with a key in the keychain still works
and bypasses the service entirely. It is documented in the README, never in the
product UI.

## Pricing (decided from measured unit costs, 2026-09-22)

| Plan | Price | What you get |
|---|---|---|
| Free taste | $0, no card, no account | 100 checks, device-bound, about a working day |
| Pro monthly | **$9.99 / month**, 7-day free trial | 15,000 checks a month |
| Pro yearly | **$79 / year** (34% off) | same |

Measured cost of goods: a check on `gpt-5-mini` costs $0.00070 (2,122 input +
~90 output tokens at one display). A typical month at the 45-second default is
about 8,100 checks, so $5.67. Change-gating (below) removes roughly half of
those calls, putting COGS near $2.85 and gross margin near 70% at $9.99.
The 15,000 check allowance is well above typical use; past it the service
stretches the interval instead of cutting anyone off.

## Base URL

`https://api.grayout.app` — overridable with `GRAYOUT_API_BASE` (unpackaged only)
and by `apiBase` in `config.json`. Until DNS exists, the workers.dev URL that
`wrangler deploy` prints works as a drop-in.

## License keys

`gry_live_` + 24 characters of base32 (Crockford, uppercase, no I/L/O/U).
Example shape: `gry_live_7KQ2R9XW4M0ZT8VN3HJ5CB6D`. Stored with `safeStorage`
in `secrets.bin` under `grayoutLicense`. Never logged; masked as `gry_live_…CB6D`.

## Device identity

A random 128-bit id generated once per install, stored in `state.json` as
`deviceId`. It scopes the free taste and lets someone see their seats. It is
not a fingerprint: nothing about the machine is hashed into it.

## Endpoints

All requests and responses are JSON. Errors are
`{ "error": { "code": "<snake_case>", "message": "<one plain sentence>" } }`
with a sensible HTTP status. Every response carries `X-Grayout-Request-Id`.

### `POST /v1/check`
The only endpoint the watch loop calls.

```jsonc
// request
{
  "deviceId": "…",
  "license": "gry_live_…",          // omitted while on the free taste
  "displays": [ "<base64 jpeg>" ],   // 1-3, already resized to 1366px wide
  "webcam": "<base64 jpeg>|null",
  "context": {
    "workDescription": "…",          // ≤ 500 chars, may be ""
    "frontApp": "Code",              // may be null
    "canvasTasks": ["…"],            // ≤ 20, untrusted
    "fileTasks": ["…"]               // ≤ 20, untrusted
  }
}
// 200
{
  "verdict": { "off_task": false, "activity": "code editor and terminal", "confidence": "high" },
  "usage":   { "checksUsed": 412, "checksIncluded": 15000, "periodEnd": "2026-10-22T00:00:00Z", "resetsAt": "2026-10-01T00:00:00Z" },
  "plan":    "free|trialing|active|past_due|canceled"
}
```

`plan` and `status` are the same lifecycle value wherever both appear, so they
can never contradict each other; the monthly/yearly question is a separate
`interval` field on `/v1/activate` and `/v1/status`. `usage.periodEnd` is the
billing date; `usage.resetsAt` is when the meter itself resets, which is the
first of the next calendar month because the key is `use:<license>:<YYYY-MM>`.
On the free taste both are `null`: it never comes back.

The **server owns the prompt**. The client sends pixels and context, never
prompt text: that is what lets the judgement improve without shipping an app
update, and it keeps the model key on the server. The server applies the same
fencing rules for untrusted task text that `src/analyzer.js` documents.

Failure codes the client must handle by name: `no_license`, `license_invalid`,
`license_revoked`, `trial_expired`, `subscription_inactive`, `free_exhausted`,
`quota_exceeded`, `rate_limited`, `upstream_unavailable`, `payload_too_large`.
Anything that is not a clean verdict is treated as on-task, exactly as before.

`no_license` means something specific: this device has a license on file and
turned up without it. A device that has never paid gets `free_exhausted`.

### `POST /v1/checkout`
`{ deviceId, plan: "monthly"|"yearly", deviceCode? }` → `{ url }`
Creates a Stripe Checkout Session in `subscription` mode. Monthly carries
`subscription_data.trial_period_days: 7`. `client_reference_id` is the device
code so the app can claim the license without anyone copying a key.

### `POST /v1/device-code`
`{ deviceId }` → `{ deviceCode, expiresIn }` — a short code the app creates
before opening the browser.

### `GET /v1/claim?deviceCode=…`
`{ status: "pending" }` until checkout completes, then `{ status: "ready", license }`.
The app polls this every 2 s for 15 minutes. This is the whole sign-in flow:
click, pay, the app unlocks itself.

Two codes here are permanent and **must stop the poll rather than be retried**:
`code_expired` (404 — the code expired or never existed) and `bad_request`
(400). Retrying either spends the whole 15-minute window on ~450 requests that
cannot succeed, and ends in a timeout message instead of a useful one.

### `GET /v1/claim?sessionId=cs_…`
The same endpoint, for a purchase that **started on the website** rather than in
the app. A browser checkout has no device code to attach the license to, so
without this the person pays and has no way to reach their key at all. The
service reads the Checkout Session back from Stripe and answers
`{ status: "pending" }` until it is both complete and has a license issued
against its customer, then `{ status: "ready", license }`. A trial checkout
completes with `payment_status: "no_payment_required"`, which counts.

The session id is a bearer credential of the same weight as a device code:
whoever holds it can read the license that session bought, and nothing else. It
is rate limited to 20 a minute. `success.html` asks a handful of times over
about twenty seconds, because the webhook can land after the redirect.

### `POST /v1/activate`
`{ deviceId, license }` → `{ plan, status, interval, usage }` — for someone
pasting a key they already have, and to re-validate on launch.

### `GET /v1/status?license=…&deviceId=…`
→ `{ plan, status, interval, usage, portalUrl }`. Cached by the app for 10 minutes.
`portalUrl` is `null` unless the request carries `&portal=1`: a portal session is
a live Stripe call and a single-use link, and the app polls status every ten
minutes. Use `POST /v1/portal` when a portal link is actually wanted.

### `POST /v1/portal`
`{ license }` → `{ url }` — a Stripe billing portal session for managing or
cancelling.

### `GET /v1/health`
`{ ok: true }`. No auth, no side effects.

### `POST /v1/stripe/webhook`
Verified with `constructEventAsync` (Workers has no sync crypto). Handles
`checkout.session.completed` (issue the license, attach it to the device code),
`customer.subscription.created|updated|deleted` and `invoice.payment_failed`
(update status). Unknown events return 200 and are ignored.

## Change-gating (client side, `src/framehash.js`)

Before spending a call, the client compares an 8×8 average hash of each display
against the previous check. If every display is within a Hamming distance of 3
**and** the frontmost app is unchanged **and** no alert is active, the check is
skipped and the previous verdict stands. A real check is forced at least every
`forceCheckSec` (default 180) regardless. This roughly halves both the bill and
the latency of an idle desk, and it is what makes $9.99 work.

## Storage (Workers KV)

| Key | Value |
|---|---|
| `lic:<license>` | `{ customerId, subscriptionId, plan, status, periodEnd, createdAt, revokedAt }` |
| `dev:<deviceId>` | `{ freeUsed, firstSeen, lastSeen, license }` |
| `code:<deviceCode>` | `{ deviceId, createdAt, license? }`, 15-minute TTL |
| `use:<license>:<YYYY-MM>` | integer check count |
| `cus:<customerId>` | `<license>` |

Two operational key families sit outside that table: `rl:…` holds the rate-limit
windows (they expire within two windows), and `cus:pending:<customerId>` parks a
subscription event that arrived before its `checkout.session.completed` for 24 h,
because Stripe does not guarantee delivery order.

## Security rules

- The model key lives only in the Worker secret store. It is never returned.
- License keys are compared in constant time and never logged.
- Images are never stored, never logged, and never written to disk by the
  service. They go to the model provider and are dropped.
- The prompt fences untrusted task text and tells the model to ignore
  instructions found in it, exactly as `src/analyzer.js` does today.
- Rate limit: 40 checks per minute per device, 1,200 per hour per license.
- Request body cap: 8 MB.
