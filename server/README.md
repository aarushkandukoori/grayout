# The Grayout API

A single Cloudflare Worker. It sells the subscription, issues license keys, and
makes the vision call on the app's behalf so that no one has to bring their own
model key.

The app sends pixels and context. This service owns the prompt, the model key
and the meter. `docs/API-CONTRACT.md` at the repo root is the specification;
this directory is the implementation, and the contract wins any argument
between them.

## What is in here

| File | What it does |
|---|---|
| `src/index.js` | The router. CORS, the request id, body limits, and the error envelope. |
| `src/license.js` | License key generation, shape, constant-time comparison, masking. |
| `src/store.js` | The JSON store over Workers KV, and the Map-backed one the tests use. |
| `src/quota.js` | The free taste, the monthly allowance, and the rate limits. |
| `src/stripe.js` | Checkout, the billing portal, and the webhook that turns a payment into a key. |
| `src/check.js` | The prompt and the call to the model provider. |
| `test/` | `node --test`, no network, no real Stripe, no real model call. |

## Endpoints

| Method | Path | Body or query | Answers |
|---|---|---|---|
| POST | `/v1/check` | `deviceId`, `license?`, `displays[1-3]`, `webcam?`, `context` | `{ verdict, usage, plan }` |
| POST | `/v1/checkout` | `deviceId`, `plan` (`monthly`/`yearly`), `deviceCode?` | `{ url }` |
| POST | `/v1/device-code` | `deviceId` | `{ deviceCode, expiresIn }` |
| GET | `/v1/claim` | `?deviceCode=` or `?sessionId=` | `{ status: "pending" }` or `{ status: "ready", license }` |
| POST | `/v1/activate` | `deviceId`, `license` | `{ plan, status, interval, usage }` |
| GET | `/v1/status` | `?license=&deviceId=&portal=1` | `{ plan, status, interval, usage, portalUrl }` |
| POST | `/v1/portal` | `license` | `{ url }` |
| POST | `/v1/stripe/webhook` | the raw Stripe event | `{ received: true, action }` |
| GET | `/v1/health` | — | `{ ok: true }` |

Three notes on shapes the contract leaves open.

- `plan` and `status` carry the same lifecycle value, one of `free`,
  `trialing`, `active`, `past_due`, `canceled`. `interval` is the separate
  question of which price is being paid, `monthly` or `yearly`, or `null`.
- `usage.periodEnd` is what the person is billed on. `usage.resetsAt` is when
  the check meter itself rolls over, which is the first of the next month,
  because the counter key is `use:<license>:<YYYY-MM>`. On the free taste both
  are `null`: 100 checks is a one-off and never comes back.
- `portalUrl` is `null` unless the request asks for it with `portal=1`. A Stripe
  portal link is a live API call and a short-lived link, and the app polls
  `/v1/status` every ten minutes, so it is minted only when someone is about to
  click it.

Beyond the contract's two limits, 40 checks a minute per device and 1,200 an
hour per license, the endpoints that are not the watch loop carry a ceiling of
their own: 30 a minute per device for `/v1/device-code`, `/v1/checkout`,
`/v1/activate` and `/v1/status`, 45 a minute per code for `/v1/claim`, which is
comfortably above the app's two-second poll, and 20 a minute per session id for
the `?sessionId=` form, which `success.html` asks a handful of times. They sit in a separate
window so they can never eat a subscriber's check budget.

Errors are always `{ "error": { "code", "message" } }`. The codes the app
handles by name are in the contract. Three more exist for the cases the contract
does not cover, and they arrive in the same envelope: `bad_request`,
`code_expired` (the 15-minute claim code is gone, so stop polling), and
`invalid_signature`.

## Deploying it, from nothing

You need Node 22 (`.nvmrc` at the repo root), a Cloudflare account, and a Stripe
account. Roughly twenty minutes.

### 1. Install

```bash
cd server
npm install
npx wrangler login
```

`wrangler login` opens a browser and asks you to authorize the CLI against your
Cloudflare account. If you do not have one, make it at
<https://dash.cloudflare.com/sign-up> first; the Workers free tier covers this
service until it has real traffic.

### 2. Make the KV namespace

```bash
npx wrangler kv namespace create GRAYOUT_KV
```

It prints something like:

```
{ "binding": "GRAYOUT_KV", "id": "0f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e" }
```

Open `wrangler.jsonc` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with that id.
That is the only edit the file needs.

### 3. Make the two Stripe prices

In the Stripe dashboard, under Product catalogue, add a product called
**Grayout Pro** with two recurring prices, **$9.99 per month** and **$79 per
year**. Or from the CLI:

```bash
stripe products create --name "Grayout Pro"
# note the prod_… id it prints, then:
stripe prices create -d "product=prod_REPLACE" -d "unit_amount=999"  -d "currency=usd" -d "recurring[interval]=month"
stripe prices create -d "product=prod_REPLACE" -d "unit_amount=7900" -d "currency=usd" -d "recurring[interval]=year"
```

Keep the two `price_…` ids. The 7-day trial is not part of the price; this
service asks for it on the monthly checkout session.

While you are in the dashboard, turn on the customer portal under Settings →
Billing → Customer portal and save a configuration. Without one,
`/v1/portal` fails with "No configuration provided" the first time someone
tries to cancel.

### 4. Set the five secrets

Each command prompts for the value and stores it encrypted. Nothing is written
to disk and nothing goes in `wrangler.jsonc`.

```bash
npx wrangler secret put STRIPE_SECRET_KEY      # sk_live_… (use sk_test_… first)
npx wrangler secret put STRIPE_PRICE_MONTHLY   # the price_… for $9.99 / month
npx wrangler secret put STRIPE_PRICE_YEARLY    # the price_… for $79 / year
npx wrangler secret put OPENAI_API_KEY         # the service's own model key
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # a placeholder for now: whsec_placeholder
```

The webhook secret does not exist until the endpoint does, which needs the
Worker's URL, which needs a deploy. Put anything in it now and set the real
value in step 6.

### 5. Deploy

```bash
npx wrangler deploy
```

It prints the URL, something like
`https://grayout-api.<your-subdomain>.workers.dev`. Check it:

```bash
curl https://grayout-api.<your-subdomain>.workers.dev/v1/health
# {"ok":true}
```

That URL is a working base URL for the app. `apiBase` in the app's
`config.json` overrides the default, and `GRAYOUT_API_BASE` does the same when
running from source. Point `api.grayout.app` at the Worker later, under Workers
& Pages → your Worker → Settings → Domains & Routes.

### 6. Register the webhook

In the Stripe dashboard, under Developers → Webhooks, add an endpoint at
`https://<your worker URL>/v1/stripe/webhook` and select exactly these events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Copy the signing secret it shows, `whsec_…`, and set it for real:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Secrets take effect immediately; there is no need to deploy again. Send a test
event from the dashboard and confirm it comes back 200.

### 7. Buy something in test mode

With `sk_test_…` and test prices, run the whole flow once: the app asks for a
device code, opens checkout, you pay with `4242 4242 4242 4242`, the webhook
issues a key, and the app claims it from `/v1/claim` and starts checking. If
`/v1/claim` stays `pending`, the webhook is not arriving — look at
Developers → Webhooks → your endpoint for the delivery attempts and the
response body, which carries the request id.

## Two ways to claim a license

`?deviceCode=` is the app's path: it makes a code, opens checkout with the code
as `client_reference_id`, and the webhook attaches the issued license to it.

`?sessionId=` is the website's path, and it exists because a purchase started in
a browser has no device code to attach anything to. The service reads the
Checkout Session back from Stripe and maps its customer id through
`cus:<customerId>` to the license. It answers `pending` until the session is
complete **and** the webhook has issued the key, so the success page retries for
about twenty seconds. A trial checkout completes with
`payment_status: "no_payment_required"`, and that counts as complete.

Both values are bearer credentials: whoever holds one can read the license that
purchase bought, and nothing else.

## Running it locally

```bash
cp .dev.vars.example .dev.vars   # then fill it in; .dev.vars is gitignored
npx wrangler dev
```

`wrangler dev` uses a local KV that starts empty and lives under `.wrangler/`.
To exercise webhooks locally, forward them:

```bash
stripe listen --forward-to http://localhost:8787/v1/stripe/webhook
```

That prints its own `whsec_…`, which is the one to put in `.dev.vars` while you
are forwarding.

## Tests

```bash
npm test
```

`node --test` over `test/**/*.test.js`. They cover the license key shape and the
constant-time comparison, the free taste running out, usage accounting and month
rollover, both rate limits, the device-code claim lifecycle end to end, webhook
routing for every handled event, the error envelope for every code in the
contract, the prompt's fencing of untrusted task text, and verdict coercion.

Nothing in the suite reaches the network. The store is a `Map`, Stripe is a
hand-written object with the three methods this service calls, and the model
provider is a stub `fetch` that records what it was asked for. If a test ever
needs a real key, the test is wrong.

A dry build, which needs no Cloudflare account:

```bash
npx wrangler deploy --dry-run
```

## Things worth knowing before you change it

- **The prompt is the product.** `src/check.js` carries the same rules as
  `src/analyzer.js` in the app, word for word. Read the "Never loosen the prompt
  for engagement" section of `CONTRIBUTING.md` before touching either.
- **Anything that is not a clean verdict is on task.** A malformed model
  response, a refusal, a timeout, a 500 from the provider: all of them end as an
  error the app treats as on task. The screen never goes gray because something
  broke.
- **A check is billed only when it produced a verdict.** The meter is
  incremented after the model answers, never before.
- **KV has no transactions.** `incr` is read-modify-write and can lose a racing
  increment, which is why only the usage meter and the rate limiters use it.
  Licenses and claims are plain writes.
- **Storage keys.** The contract's table is in `store.js` as `keys`. Two
  families are not in that table and are operational only: `rl:…`, the rate-limit
  windows, which expire within two windows, and `cus:pending:…`, where a
  subscription event that arrives before its checkout session parks its status
  for 24 hours.
- **Checkout returns people to the site.** `SITE_BASE` plus
  `CHECKOUT_SUCCESS_PATH` and `CHECKOUT_CANCEL_PATH` in `wrangler.jsonc` point
  at `docs/success.html` and `docs/pricing.html`. If those pages are renamed,
  change the vars in the same change, or a paying customer lands on a 404.
- **Self-hosting still works.** The repo is MIT, and setting `provider` to
  `anthropic` or `openai` in the app's `config.json` with a key in the keychain
  bypasses this service entirely. That stays documented in the app's README and
  nowhere in the product UI.
