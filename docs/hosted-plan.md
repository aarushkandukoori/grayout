# Operator runbook (the hosted plan, shipped)

This used to be a plan. As of 2026-09-22 it is the product: Grayout 2.0 sells a subscription and the Grayout service makes the model calls. This document is what survives launch — why the price is what it is, what to watch, and the list of things only the owner can do.

Internal. Linked nowhere on the site. Numbers here are cost of goods and margin; the public pages say what it costs to buy, not what it costs to run.

The binding technical document is [API-CONTRACT.md](API-CONTRACT.md). Prices, endpoints, storage keys, and error codes are settled there. If this file and that file disagree, that file is right and this one needs fixing.

## What shipped

| Plan | Price | What they get |
|---|---|---|
| Free taste | $0, no card, no account | 100 checks, device-bound, about one working day |
| Pro monthly | $9.99 / month, 7-day free trial | 15,000 checks a month |
| Pro yearly | $79 / year (34% off monthly) | 15,000 checks a month |

The app holds a Grayout license key and talks only to `api.grayout.app`. Self-hosting on your own Anthropic or OpenAI key stays supported and documented in the README, because the repository is MIT and pretending otherwise would be dishonest.

## Why $9.99

Measured on 2026-09-22, on `gpt-5-mini`, one display:

- **One check costs $0.00070** — 2,122 input tokens and about 90 output tokens.
- **A month of watched work is about 8,100 checks** at the 45-second default, which is $5.67 of model calls.
- **Change-gating removes roughly half of those.** Identical displays plus an unchanged frontmost app plus no active alert means the call is skipped; a real check is forced every 180 seconds regardless. That puts a typical subscriber near **4,050 checks and $2.85 a month**.
- At $9.99 that is **about 70% gross margin before payment processing**. Subtract Stripe's cut to get the real number; it is a per-charge fee plus a percentage, so it hurts the monthly plan more than the yearly one in percentage terms.
- The yearly plan is $6.58 a month. Same $2.85 of goods, so roughly **57% gross before processing**. The discount is paid for out of margin, not out of a cheaper cost structure, and it buys a year of no churn and one charge instead of twelve.

$9.99 was chosen because it is the price of a thing people buy without a meeting, and because the measured COGS leaves room for the free taste, for refunds, and for the model getting more expensive before the price has to move.

### The numbers that decide when the price is wrong

- **Break-even is about 14,300 checks a month** at $9.99 ($9.99 ÷ $0.00070), a little under 13,500 once processing is taken out. The 15,000 allowance therefore sits *just past* break-even by design: a subscriber who somehow used every included check would cost about $10.50 and be slightly unprofitable, and that is acceptable because nobody reaching that number is a typical user. What caps the downside is that past the allowance the service **stretches the interval instead of cutting anyone off** — the bill flattens, the product keeps working, nobody gets an angry email.
- **A yearly subscriber at the full allowance is the worst case**: $10.50 of goods against $6.58 of revenue. One of those is fine. A pattern of them means the allowance is too generous or a license is being shared.
- **The free taste costs about $0.07 per install** (100 × $0.00070). A hundred people trying it costs $7. That is cheap enough to never gate and cheap enough to ignore until the install count is in the thousands.

## What to watch

Check these monthly. Write the number and the date in this file when you do; a runbook with no history is a guess.

| Signal | Where it comes from | Healthy | Act when |
|---|---|---|---|
| **COGS per subscriber** | OpenAI spend for the month ÷ active subscribers | at or under $3 | Over $5 for two months running. Either change-gating is not doing its job, or people are running many displays, or the model price moved. Look at the gating skip rate before touching the price. |
| **Median and 90th-percentile checks per subscriber** | `use:<license>:<YYYY-MM>` counters in KV | median near 4,000 | The 90th percentile approaching 15,000. The allowance is the shock absorber; if ordinary use is touching it, it is not sized right. |
| **Free-taste conversion** | device records with `freeUsed` at 100, against new subscriptions | unknown until there is data — establish the baseline in the first month, then watch the trend | It falls by half. Either the first 100 checks are not enough to show the product working, or the subscribe flow is broken. Test the flow yourself before concluding anything about the funnel. |
| **Free tastes started but never finished** | device records with `freeUsed` well under 100 and a stale `lastSeen` | — | Most people stop partway. That is an onboarding or permissions problem, not a pricing one. Re-run the stranger test. |
| **Trial-to-paid** | Stripe | — | Below a third. Seven days is long enough that people who keep it installed usually keep it. |
| **Refund and chargeback rate** | Stripe | near zero | Any chargeback. It costs a fee on top of the refund, and it usually means someone could not find the cancel button. |
| **Failed payments and involuntary churn** | `invoice.payment_failed` webhooks | — | It is more than a trickle. Stripe's retry settings are the first knob. |
| **Service errors** | Worker logs, by error code | — | `upstream_unavailable` rising means OpenAI trouble; the app fails closed, so the visible symptom is nobody being grayed out rather than complaints. |

### Refund policy

Refund anyone who asks, inside 30 days, without argument, and cancel the subscription at the same time. Do it in Stripe; the webhook handles the license. At this price arguing costs more than the refund, and the product is one that people stop needing when it works.

Do not refund a year in the eleventh month; offer the remaining months prorated instead. Revoke the license when a chargeback arrives, not before.

## Things only the owner can do

None of these can be done by a contributor, an agent, or from this repository. Roughly in order.

### Live now, and owned personally

1. **Stripe account.** The business, the bank details, the tax settings. Create the two prices ($9.99 monthly with a 7-day trial, $79 yearly) and keep their ids in the Worker's secrets, not in the repository. Changing a price means creating a new Price object and pointing the Worker at it — never editing an existing one, which silently changes what existing subscribers are charged.
2. **The webhook endpoint.** Stripe dashboard > Webhooks, pointed at `POST /v1/stripe/webhook`, subscribed to `checkout.session.completed`, `customer.subscription.created|updated|deleted`, and `invoice.payment_failed`. Its **signing secret** goes into the Worker secrets. The contract is clear that nothing is believed without a verified signature; if the secret is wrong, every event is rejected and licenses stop being issued, so test it with Stripe's CLI after any rotation.
3. **Cloudflare account.** The Worker, the KV namespace, the custom domain binding for `api.grayout.app`, and the secrets: the OpenAI key, the Stripe secret key, and the webhook signing secret. The OpenAI key is the highest-value secret in the system. It lives nowhere else.
4. **The `grayout.app` domain.** Registration, DNS, and the route to the Worker. The app ships `https://api.grayout.app` as its default `apiBase`, so losing the domain breaks every install that is not self-hosted. Renew it on autopay and do not let the registrar email go to a dead address.
5. **The OpenAI account** that the shared key belongs to, with a monthly budget set above expected COGS and an alert well below it. A budget that is hit takes the whole service down; an alert that is missed takes the bank account down.
6. **Support.** There is no support address yet. Issues and Discussions are the only path, and the billing issue template exists so people do not paste secrets into them. Get an address before the subscriber count makes GitHub embarrassing.

### Still outstanding

7. **Apple Developer Program, $99 a year.** Notarization removes the "Apple could not verify" dialog and the Open Anyway walk-through, which remains the biggest install stumble and now sits directly in front of a paid conversion. Switch `identity` from `-` to the Developer ID, set `hardenedRuntime: true`, use `build/entitlements.mac.plist`, add `notarize` to the build, then re-run the stranger test because a notarized build changes the permission flow.
8. **USPTO search.** Search TESS for "Grayout" in software classes. This mattered less when nothing was sold; money changing hands makes it matter. Known collisions are minor (a dormant 2015 iOS text game, small GitHub utilities). If a real conflict surfaces, rename before a renewal cycle, not after.
9. **Terms of service.** There is a privacy policy and there is no terms document. A subscription product needs one: what is sold, the refund policy above, acceptable use, and the disclaimer that Grayout is not a lock and not a monitoring tool.
10. **Sales tax and VAT.** Stripe Tax, or a merchant of record, or an accountant's answer. Selling internationally from a one-person project is the thing this decision is about; it does not get simpler by waiting.
11. **GitHub Sponsors and `.github/FUNDING.yml`**, if the sponsor links in the README, About menu, and site footer are ever meant to appear. They stay hidden until that file exists.

## Runbook

**Someone paid and the app did not unlock.** Check the Stripe event first: did `checkout.session.completed` fire and was it delivered? If Stripe says delivered and the license is missing, the webhook handler failed — look for the request id. The device code lives 15 minutes, so past that the fix is to read the license out of KV by customer id (`cus:<customerId>`) and give it to them to paste in Settings.

**A license is being shared.** The rate limits (40 checks per minute per device, 1,200 per hour per license) bound the damage, and the monthly counter makes it visible. Rotate the license: write a new record, set `revokedAt` on the old one, send the new key to the paying customer. Do not build seat management for this.

**A key leaked.** Rotate the Worker secret and redeploy. No client holds a model key, so no app update is needed, which is the point of the design.

**The model got more expensive.** Recompute COGS at the new price with the real measured token counts before touching the price of the product. Tightening change-gating (a larger Hamming threshold, a longer `forceCheckSec`) buys room without a price change, at the cost of a slower response to somebody switching to a feed.

**Everything is down.** The app fails closed, which means every check is treated as on task and nobody's screen goes gray because of it. An outage is embarrassing, not harmful. Say so on the repository, fix it, and do not add a retry storm.

## Not in this plan

Accounts beyond a license key, a web dashboard, team or employer features, telemetry of any kind, a locked mode, and any change that makes self-hosting harder than it is today. Those are out for the same reasons they were out at 1.0.
