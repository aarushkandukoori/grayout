# Hosted plan (V2, not built)

Internal planning document. Linked nowhere on the site; no hosted price is printed anywhere public until the gates below pass. The pinned Discussions thread "Hosted plan (no API key needed) — reply to be notified" is the only public surface, and its reply count is the demand signal.

## Why

V1 is free, open source, and bring-your-own-key. That is right for the first users but wrong for most people: creating an Anthropic or OpenAI account, adding $5 of prepaid credit, and pasting a key is the single biggest stumble in the first ten minutes. A hosted tier removes that step and gives the project a way to pay for notarization, a domain, and the author's time.

## Rungs

| Rung | Name | Price | What you get |
|---|---|---|---|
| 1 | BYOK | Free, forever | The current app. Your own Anthropic or OpenAI key, your own bill. Never removed, never degraded. |
| 2 | Grayout Hosted | $15/month or $120/year; students $8/month with a verified .edu address | No API key. 14-day trial. 8,000 vision-equivalent checks a month, which is about 22 working days at the default 45-second setting. |
| 3 (year two, optional) | Lifetime BYOK license | $39 one time | Commitment mode and multi-Mac sync for BYOK users. Not a subscription. |

### Rung 2 details

- **Quota**: 8,000 vision-equivalent checks per calendar month. A text-only check (see the cascade below) counts as a fraction, set once the real token ratio is measured.
- **Soft cap**: past 8,000, checks degrade to text-only; past a second threshold, the app falls back to BYOK if a key is saved, otherwise pauses with a clear tray line. Nothing ever goes gray because of a billing state.
- **Overage**: $2 per 1,000 checks, opt-in, metered through the payment provider. Off by default.
- **What the proxy sees**: the same request the app sends to Anthropic today, no more. Screenshots pass through and are not stored. Only counts are logged: checks per user per month, and nothing about their content. The privacy page gets a new row for the proxy the day it exists.
- **What stays in the app**: all verdict logic, the strike counter, the watchdog, every escape hatch. Hosted changes who pays Anthropic, nothing else.

## Margin gate

The tier opens only when both of these are true:

1. **Change gating and a text-first cascade ship in the free app.** Change gating: an 8-by-8 average hash of each display plus the frontmost app name; if nothing changed since the last check, skip the call, with a forced vision check every 3 to 5 minutes. Text-first cascade: a cheaper text-only pass (frontmost app, window title, change signal) that only escalates to a vision call when it cannot decide. The dashboard shows "saved $X" so BYOK users benefit first.
2. **30 days of opt-in, counts-only usage exports** ("Copy my anonymised stats": checks per day, cost, interval, displays; counts only, nothing about content) show a cost of goods at or below **$5 per user per month** at the median and at the 90th percentile. Above that, the price is wrong or the cascade is not good enough, and the tier waits.

## Before hosted

Owner follow-ups. Only Aarush can do these. Roughly in order.

### Also needed for v1.0.0 itself

- Run `npm run smoke:api` with a real key before tagging. The API path has zero production verdicts until then.
- Run `scripts/stranger-test.md` on a fresh macOS user account and fix every stumble first.
- Capture the real screenshots for `docs/img/` (hero, dashboard, both Gatekeeper dialogs, Screen Recording pane) and replace the placeholders before the Show HN post.
- Enable Discussions, create and pin the waitlist thread, enable GitHub Pages from `main:/docs`, and check that the issue templates render.
- Enroll in GitHub Sponsors and add `.github/FUNDING.yml`. The Sponsor links in the README, About menu, and site footer stay hidden until that file exists.

### Before any money changes hands

1. **Enroll in the Apple Developer Program, $99 a year.** Developer ID certificate plus notarization removes the "Apple could not verify" dialog and the Open Anyway walk-through, which is the biggest install stumble. Switch `identity` from `-` to the Developer ID, set `hardenedRuntime: true`, use `build/entitlements.mac.plist`, add `notarize` to the build. Re-run the stranger test afterward: a notarized build changes the permission flow. Ship as v1.1.
2. **Buy `grayout.app`.** Unregistered as of 2026-09-21. Point it at GitHub Pages with a CNAME, keep the `aarushkandukoori.github.io/grayout/` URLs working. The `releases/latest/download/` URLs do not change.
3. **USPTO search.** Search TESS for "Grayout" in software classes before any filing or paid tier. Known collisions are minor (a dormant 2015 iOS text game, small GitHub utilities). If a real conflict surfaces, the fallback name is Pallor; rename before the first charge, not after.
4. **Payments: Stripe, or a merchant of record.** Stripe Billing is the default choice; a merchant of record (Paddle or Lemon Squeezy) handles sales tax and VAT in exchange for a larger cut and is the better fit for a one-person project selling internationally. Decide before writing the proxy, because the proxy validates whatever the provider issues. Either way: subscriptions, a 14-day trial without a card if the provider allows it, usage records for overage, and webhooks for created, renewed, past due, cancelled, and refunded.
5. **Cloudflare Workers proxy, design sketch.** One Worker in front of `api.anthropic.com`:
   - The app sends the same Messages request it sends today, to the Worker instead, with a Grayout license token in place of an Anthropic key. The Anthropic key lives in a Worker secret and is never sent to the client.
   - The Worker validates the token against a KV or D1 record kept current by the payment webhooks (active, trialing, past due, cancelled).
   - A per-user, per-month counter (Durable Object, or KV with the month in the key) enforces the quota and the soft cap. Over the cap, the Worker returns a small JSON status code the app understands ("text-only", "byok-fallback", "paused") rather than an error.
   - The Worker forwards the request body as-is, streams the response back, and logs a count per user per month. Request bodies are never written anywhere. Body size is capped at roughly three screenshots plus a webcam frame, and per-token rate limiting matches the app's minimum interval.
   - Tokens are rotated from the dashboard, revoked on refund or chargeback, and scoped so one leaked token cannot exceed one user's quota.
   - Overage, if opted in, is reported to the payment provider as usage records at month end.
   - The app keeps its BYOK path untouched; hosted is a second engine selected by the presence of a license token.
6. **.edu verification for the student price.** Simplest version: the user enters an `.edu` address, the Worker emails a one-time code through a transactional mail provider, the user pastes it, and the Worker stores a hash of the address with a verified-at date. Re-verify once a year. Store nothing else. A verification service (SheerID or similar) is the alternative if `.edu` addresses prove too easy to obtain. International student domains (`.ac.uk`, `.edu.au`, and so on) need an allowlist, not a suffix check.
7. **COGS gate.** Do not open the tier until the margin gate above passes: change gating and the text-first cascade shipped in the free app, plus 30 days of opt-in counts-only exports showing at or below $5 per user per month. Record the measured number here with the date.

## Not in this plan

Accounts beyond a license token, a web dashboard, team or employer features, telemetry of any kind, a locked mode, and any change to what BYOK users get. See "Explicitly out of v1" in the build spec for the rest.
