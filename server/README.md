# The Grayout API

One Cloudflare Worker with a D1 database. It sells the subscription (through
Stripe, which is the merchant of record), issues license keys, and makes the
vision call for the app so nobody has to bring their own model key.

`docs/API-CONTRACT.md` (v3) is the specification. This folder implements it,
and the contract wins any disagreement.

## What is in here

| File | What it does |
|---|---|
| `src/index.js` | The front door: routes, JSON-only POSTs, body limits, CORS, per-IP limit, error envelope. |
| `src/http.js` | Error codes, responses, reading a body while counting bytes, the caller's IP key, safe logging. |
| `src/config.js` | Every constant, and the checks that refuse missing or placeholder secrets. |
| `src/ids.js` | Device ids and tokens, license keys (derived, never stored), device codes, hashes. |
| `src/db.js` | Every SQL statement, as small named functions. The atomic ones are commented. |
| `src/limits.js` | Workers Rate Limiting bindings. |
| `src/devices.js` | `/v1/device`, `/v1/device-code`, `/v1/restore`, and device verification. |
| `src/purchase.js` | `/v1/checkout` and `/v1/claim`. |
| `src/account.js` | `/v1/activate`, `/v1/status`, `/v1/portal`. |
| `src/check.js` | `/v1/check`, the watch loop's one call. |
| `src/model.js` | The prompt and the call to the model provider. |
| `src/stripe.js` | Checkout parameters, reading a customer from Stripe, issuing a license, refunds and disputes. |
| `src/webhook.js` | `/v1/stripe/webhook`. |
| `src/access.js` | Who gets checks served, and the account object. |
| `src/cleanup.js` | The daily cron that deletes expired rows. |
| `migrations/0001_init.sql` | The database tables. |
| `scripts/deploy.sh` | Every deploy step that needs no secret (`sandbox` or `live`, plus `--fill-site` once a 2.x release is latest), then a list of what is left. |
| `scripts/set-secrets.sh` | Sets the five secrets in one go. Only Aarush runs it, in his own Terminal (it refuses to run anywhere else). |
| `scripts/check-csp.js` | Checks every site page's CSP lets the browser reach the API (deploy.sh runs it). |
| `scripts/wrangler-var.js` | Prints one Worker's own setting from `wrangler.jsonc` (deploy.sh uses it). |
| `scripts/stripe-answer.js` | Checks a Stripe CLI answer, which can be an error with exit code 0 (set-secrets.sh uses it). |
| `scripts/license-key.js` | Re-derive a customer's key, to email it to a buyer who lost it. |
| `scripts/delete-customer.js` | Print the one command that deletes a customer's record, for a data deletion request. |
| `test/` | `node --test` against an in-memory SQLite, fake rate limiters and a fake Stripe. No network. |

## Endpoints

Everything except `GET /v1/health` is a `POST` with a JSON body. Nothing secret
ever goes in a URL. Full shapes are in the contract, section 6.

| Path | Needs | Answers |
|---|---|---|
| `GET /v1/health` | nothing | `{ ok, contract: 3, configured: {…} }` |
| `/v1/device` | nothing (IP-limited) | `{ deviceId, deviceToken }` |
| `/v1/device-code` | device | `{ deviceCode, expiresIn }` |
| `/v1/checkout` | device, `plan`, `deviceCode?` | `{ url, sessionId, trial }` or `409 already_subscribed` |
| `/v1/claim` | device + `deviceCode`, or `sessionId` | `{ status: pending \| ready \| failed }` |
| `/v1/restore` | device | `{ status: ready, license }` or `{ status: none }` |
| `/v1/activate` | device + license | the account object |
| `/v1/status` | device + license, `portal?` | the account object + `portalUrl` |
| `/v1/portal` | device + license | `{ url }` |
| `/v1/check` | device (+ license) | `{ verdict, usage, plan, service }` |
| `/v1/stripe/webhook` | Stripe signature | `{ received: true, action }` |

"device" means the body has a `deviceId` and `deviceToken` that this server
minted. "license" means `license` in the body or `Authorization: Bearer gry_…`.

## Deploying it, from nothing

About an hour the first time. Do it all in a Stripe **sandbox** first; going
live is step 9. You never paste a secret into a file or a chat: each one goes
straight into Cloudflare with `npx wrangler secret put`, which asks for it.

There are **two Workers, each with its own database** (`wrangler.jsonc`):
`grayout-api-sandbox` (Stripe sandbox, test cards, `gry_test_` keys) and
`grayout-api` (live). A key bought with a test card can never get real
service: the live Worker never sees the sandbox's rows, and it refuses
`gry_test_` keys anyway. Every `wrangler` command for the sandbox Worker
takes `--env sandbox`.

1. **Accounts.** Make a Cloudflare account at <https://dash.cloudflare.com/sign-up>
   and switch it to the **Workers Paid** plan ($5/month; the free plan's D1
   write limit runs out at a few hundred subscribers). You already have the
   Stripe sandbox "Kandukoori's Kreations sandbox" with Grayout Pro and both
   prices; their ids are already in `wrangler.jsonc`.

2. **Log in from your Mac.** You need Node 22.13 or newer (`node --version`;
   the tests need its built-in SQLite).
   ```bash
   cd server
   npm install
   npx wrangler login      # opens a browser; approve it
   ```

3. **Run the deploy script for the sandbox.**
   ```bash
   bash scripts/deploy.sh sandbox
   ```
   It runs the tests, then does these, skipping any that are already done:
   `npx wrangler d1 create grayout-sandbox` (and writes the database id into
   `wrangler.jsonc`), `npx wrangler d1 migrations apply grayout-sandbox
   --remote --env sandbox`, and `npx wrangler deploy --env sandbox`. It prints
   the sandbox address but **does not** write it into `src/config.js` or
   `docs/config.js`: the repo is public, and those must only ever point at the
   live Worker. Test the sandbox with the app (`apiBase` in its
   `config.json`) or a local copy of the site. It ends with a numbered list of
   what is left. Until the secrets are set, every endpoint answers
   `503 not_configured`, so nothing can be bought or forged in the meantime.

4. **Turn on Managed Payments** (Stripe is then the merchant of record: it
   charges, files and pays US sales tax and EU/UK VAT for you). In the Stripe
   Dashboard:
   - Settings → **Managed Payments** → activate.
   - Settings → **Business details**: a real support email you read. Put the
     same address in `SUPPORT_EMAIL` in `wrangler.jsonc`.
   - Settings → **Checkout**: add your terms and privacy page URLs. Turn on
     **Limit customers to one subscription**. (The service also refuses a
     second checkout itself; this is a second guard.)
   - **Radar**: turn on free-trial abuse protection
     (<https://docs.stripe.com/radar/free-trial-abuse>), if Managed Payments
     offers it. The service already gives one trial per email and card.
   - Billing → **Subscriptions and emails**: "If all retries for a payment
     fail" → **Cancel the subscription**. "Manage disputed payments" →
     **Cancel the subscription immediately**.
   - Settings → Billing → **Customer portal**: cancellations **at the end of
     the billing period** with a reason; payment method updates on; **switch
     plans** on, with Grayout Pro's monthly and yearly prices, prorated,
     downgrades immediately; **login link** on. Then in the sandbox, switch a
     test subscription monthly ↔ yearly. If switching fails, turn it off (the
     site then says "cancel and subscribe again").

5. **Make the restricted key** (never use the full `sk_` secret key). Developers
   → API keys → **Create restricted key**, with only these permissions:

   | Resource | Access |
   |---|---|
   | Checkout Sessions | Write |
   | Customer portal | Write |
   | Subscriptions | Write |
   | Invoices (and Invoice Payments, if listed separately) | Read |
   | Charges | Read |
   | Refunds | Write (to refund a second subscription bought by mistake) |
   | Payment Methods | Read (to recognise a card that already had a trial) |
   | Radar early fraud warnings | Read, if listed |
   | Everything else | None |

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY --env sandbox   # paste the rk_test_… key
   ```

6. **Register the webhook.** Developers → Webhooks → **Add destination**:
   - Endpoint URL: `https://grayout-api-sandbox.<your-subdomain>.workers.dev/v1/stripe/webhook`
     (live, in step 9: `https://grayout-api.<your-subdomain>.workers.dev/v1/stripe/webhook`)
   - **API version: `2026-08-26.dahlia`** (pick it explicitly; Stripe sends
     each endpoint events in that endpoint's version, and this code reads
     dahlia shapes).
   - Exactly these 13 events:
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `customer.subscription.paused`, `customer.subscription.resumed`,
     `invoice.paid`, `invoice.payment_failed`, `charge.refunded`,
     `charge.dispute.created`, `radar.early_fraud_warning.created`.

   Copy its signing secret (`whsec_…`) into Cloudflare:
   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET --env sandbox
   ```
   The webhook refuses everything (503) until a real `whsec_…` is set, and it
   refuses anything that looks like a placeholder.

7. **The other three secrets.**
   ```bash
   npx wrangler secret put OPENAI_API_KEY --env sandbox   # the service's own model key
   openssl rand -base64 48 | npx wrangler secret put DEVICE_SECRET --env sandbox
   openssl rand -base64 48 | tee /dev/tty | npx wrangler secret put LICENSE_SECRET --env sandbox
   ```
   Save the `LICENSE_SECRET` it shows in your password manager. **Never change
   it**: every customer's key is derived from it, and
   `scripts/license-key.js` needs it to re-send a lost key. Changing
   `DEVICE_SECRET` signs every Mac out of the service (they re-register).

   **Or steps 5 to 7 in one go**, typed by you in your own Terminal window:
   ```bash
   bash scripts/set-secrets.sh sandbox https://grayout-api-sandbox.<your-subdomain>.workers.dev
   ```
   It asks for the two keys, makes the webhook with the Stripe CLI (logged in
   with `stripe login`), makes the two random secrets and shows
   `LICENSE_SECRET` once. It checks every value before storing it (never an
   empty or malformed one), stops with a plain message if the Stripe CLI
   answers with an error (which it can do while still exiting 0), keeps
   every secret off command lines, and refuses to run without a terminal, so
   the license secret can never be stored unseen. Run it again after fixing
   a problem: secrets already set are skipped.

8. **Check and test.** Run `bash scripts/deploy.sh sandbox` again; its list should now
   be short. Open `https://grayout-api-sandbox.<subdomain>.workers.dev/v1/health`:
   every `configured` flag must be `true`. Then, in the sandbox, with
   `stripe logs tail` open (add any permission that shows a 403 to the key in
   step 5): a trial purchase from the app, a paid yearly purchase from the
   website, a portal plan switch and a cancel, a full refund (the key stops
   working), a partial refund (it keeps working), a dispute, and a second
   checkout from a subscribed Mac (expect "already subscribed").

9. **Go live.** In live mode, repeat step 4, make the live product and prices
   (tax code `txcd_10105003`, tax behavior **exclusive**), put the live
   `prod_…` and both live `price_…` ids in the **top-level** `vars` of
   `wrangler.jsonc` (and the live `SUPPORT_EMAIL`: each Worker has its own),
   and run `bash scripts/deploy.sh live`. That makes the live Worker's **own,
   empty** database (never copy sandbox rows into it), deploys it, and fills
   its address into `src/config.js` for the app. It leaves `docs/config.js`
   alone on purpose. Then repeat steps 5 to 7 **without** `--env sandbox`
   (or `bash scripts/set-secrets.sh live …`), with live keys (`rk_live_…`, a
   live endpoint and its `whsec_…`, new random `DEVICE_SECRET` and
   `LICENSE_SECRET`). Run `bash scripts/deploy.sh live` once more and commit
   `src/config.js`.

10. **Give the site the address, last.** Only after a 2.x release is the
    GitHub "latest" release (every Download button fetches whatever is
    latest, and a filled-in site promises free checks that 1.x cannot
    give), run `bash scripts/deploy.sh live --fill-site`. It checks the
    latest release first and stops while it is still 1.x, then fills the
    address into `docs/config.js` and stops if any page's CSP would block
    it. Commit and publish the site, then turn on `supportEmail` and
    `checkoutLive` in `docs/config.js`.

Things that need you by hand later are in contract section 14.6: clearing a
revocation, deleting a customer's record, and re-sending a lost key:
```bash
LICENSE_SECRET=… node scripts/license-key.js cus_…            # add --test for a sandbox customer
node scripts/delete-customer.js cus_…                         # prints the command to run; add --sandbox for the sandbox
```
Always delete a customer with the script, never with hand-written SQL: the
database refuses to delete a license that other rows still point at, and the
script clears every one of them first (a test checks it still does).

## Running it locally

```bash
cp .dev.vars.example .dev.vars        # then fill in real sandbox values
npx wrangler d1 migrations apply grayout-sandbox --local --env sandbox
npx wrangler dev --env sandbox        # the sandbox Worker's vars: test prices, gry_test_ keys allowed
stripe listen --forward-to http://localhost:8787/v1/stripe/webhook   # prints the whsec_ for .dev.vars
```

## Tests

```bash
npm test
```

`test/` runs against the real schema in an in-memory SQLite (`test/d1.js`, a
small D1 stand-in), fake rate-limit bindings and a fake Stripe that keeps
subscriptions in memory (`test/fakes.js`), so a test can change "what Stripe
says" and deliver signed webhook events in any order. `test/findings.test.js`
has one regression test for each of the 29 problems found in v2, and
`test/review-findings.test.js` one for each problem the 2026-10-08 review of
v3 found, `test/server-fixes.test.js` covers the second pass over that
review, and `test/third-pass.test.js` the third (each file's header maps every
finding to its test). `test/scripts.test.js` runs `set-secrets.sh` (on a real
pseudo-terminal, which needs `python3`) and `deploy.sh` end to end against
stub `npx`, `stripe`, `npm` and `curl` commands.

## Things worth knowing before you change it

- **Status only comes from Stripe.** `syncCustomer` in `src/stripe.js` is the
  only code that writes a subscription status, and it always reads Stripe
  live. Never set a status from an event payload: events arrive out of order.
- **Every limit that matters is one SQL statement** (`src/db.js`). Two
  requests at the same moment cannot both use the last free check.
- **A check is reserved before the model call.** It is given back only when
  the model provider certainly did not charge (no connection, an error
  status). A refusal, an incomplete or unreadable answer or a timeout was
  billed, so it stays counted; otherwise failing on purpose would spend the
  model key for free.
- **One device, one subscription.** `/v1/checkout` answers 409 when the
  device already has an open subscription and expires its older sessions
  first. If a second session is paid anyway, `fulfilSession` cancels and
  refunds it and leaves the device on its first license (contract 7.1 step 3).
- **The prompt is the product.** `src/model.js` carries the same rules as
  `src/analyzer.js` in the app. Read the "Never loosen the prompt for
  engagement" section of `CONTRIBUTING.md` before touching either.
- **Nothing secret is logged.** Log lines carry ids and codes only, and
  `scrub()` in `src/http.js` masks anything key-shaped as a second guard.
- **Self-hosting still works** in the direct download and source builds.
  Setting `provider` to `anthropic` or `openai` in the app's `config.json`
  bypasses this service entirely. The Mac App Store edition only talks to
  this service (contract 16.1).
