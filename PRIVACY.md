# Grayout privacy policy

Last updated 2026-09-22. This is the same text as the privacy page on the site. It applies to Grayout for Mac 2.0.0 and to the Grayout service at `api.grayout.app`.

## The short version

Grayout 2.0 sends a screenshot of your screen to **Grayout's own service**, which forwards it to **OpenAI**, gets back a one-line verdict, and returns it to your Mac. That is the change from version 1, where the app called your own provider under your own key and there was no service in the middle.

The service does not store your screenshots and does not log them. It stores what it needs to bill you and to count your checks: a license record, a device id, a monthly check count, and a Stripe customer id. It has no idea what was on your screen.

If you would rather nothing of yours passed through a machine of ours, the repository is MIT-licensed and the self-hosting path at the bottom of this page removes the service entirely.

## What the app sends, and to whom

| What | To | When | Kept where |
|---|---|---|---|
| A screenshot of each display, resized to 1366 px wide and compressed as a JPEG | `api.grayout.app`, under your license key; from there to OpenAI | At each check that is not skipped by change-gating, while you are active and the app is not paused | Deleted from this Mac within seconds of being sent. Not stored by the Grayout service. OpenAI's handling is governed by its own policy (below). |
| One webcam frame, 640 by 480 | The same service, and on to OpenAI | At each check, only if you turned the camera on | Never written to disk on this Mac, never stored by the service |
| Your one-line work description | The same service, and on to OpenAI | At each check, if you wrote one | In `config.json` on this Mac |
| Titles of your Canvas to-do items, or the unchecked lines of your task file | The same service, and on to OpenAI | At each check, only if you configured one of them | Canvas titles are cached in memory for 10 minutes; nothing is written to disk |
| Your license key and device id | `api.grayout.app` | With every check, and when the app validates your subscription | License encrypted in the macOS Keychain; device id in `state.json` |
| A request for the latest release number | `api.github.com` | Once a day, plus when you click Check for updates | Nothing identifying is sent; the request carries only the app's version string. Turn it off in Settings. |
| Your Canvas API token, in a request for your to-do list | Your Canvas host (`canvas.baseUrl`) | Every 10 minutes, only if you configured Canvas | Encrypted in the macOS Keychain |

The images never go to OpenAI under your name or your account. They go under Grayout's key, from Grayout's service, with no identifier of yours attached to them.

The prompt is written and held by the service, not by the app. It asks for a three-field answer, `off_task`, `activity`, and `confidence`, and instructs the model to name only the category of what it sees (for example "code editor and terminal"), never on-screen text, names, message contents, URLs, or personal details. Task titles and your work description are fenced and labeled as untrusted data, and the prompt tells the model to ignore instructions found inside them.

## What the Grayout service stores

Not your screenshots. Not your webcam frames. Not your work description, your task titles, or the activity phrase the model returned. None of those are written to disk or to a log anywhere in the service; they exist for the length of one request and are dropped.

What is stored, in Cloudflare Workers KV:

- **Your license record** — the license key, the Stripe customer and subscription ids, the plan, the status, the current period end, when it was created, and when it was revoked if it was.
- **Your device record** — the device id the app generated at install, how many free-taste checks it used, when it was first and last seen, and the license attached to it. The device id is a random 128-bit number made once on your Mac. Nothing about your machine is hashed into it and it is not a fingerprint.
- **A monthly check count** — one integer per license per calendar month, so the allowance can be enforced. It is a count, not a history: there is no record of when the checks happened or what they saw.
- **A short-lived device code** — created when you click Subscribe so the app can unlock itself after you pay. It expires in 15 minutes.
- **A Stripe customer id, mapped to your license**, so a payment webhook can find the right record.

There is no account, no password, no email address held by the service, and no analytics product anywhere in it. The service never receives your name unless you typed it into your own screen.

Cloudflare operates the service's infrastructure and therefore sees the connection itself (IP address, timing, size) the way any host does. Read [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/) for what that means.

## Payment, and what Stripe sees

Stripe is the payment processor. Clicking Subscribe opens Stripe's own checkout page in your browser; you are on Stripe's site, under Stripe's terms, from that click until you come back.

**Grayout never sees your card details.** They are entered on Stripe's page, held by Stripe, and never touch the app, the service, or this repository. What the service learns from Stripe is a customer id, a subscription id, a plan, and a status. Read [Stripe's privacy policy](https://stripe.com/privacy) for what Stripe itself collects.

Billing questions, receipts, and cancellation go through Stripe's billing portal, which Settings > Manage subscription opens.

## Retention, and deleting your data

- **Screenshots and webcam frames** — not retained by anyone in this chain except OpenAI under its own policy. The service drops them at the end of the request; the Mac deletes its temp file within seconds.
- **Device codes** — 15 minutes, then gone automatically.
- **License, device, and usage records** — kept while the license exists, because that is what the subscription is. Monthly counters are per-month keys and are not needed after the period they belong to.
- **Stripe's records** — kept by Stripe for as long as its terms and tax law require. Cancelling in the portal does not erase an invoice, and we cannot erase one for you.
- **Everything on your Mac** — yours, deleted when you delete `~/Library/Application Support/Grayout`.

Ask and your license, device, and usage records are deleted: open an issue at https://github.com/aarushkandukoori/grayout/issues, or use the contact path below, from the license you want removed. Deleting them ends the subscription's ability to run checks, so cancel in Stripe first unless you want both at once.

## What is stored on your Mac, and for how long

All of it is in `~/Library/Application Support/Grayout/`, readable only by your user account.

- `config.json` — your settings, including the work description. Kept until you delete it.
- `secrets.bin` — your Grayout license key and, if configured, your Canvas token, encrypted with Electron's `safeStorage`. The encryption key lives in your macOS Keychain under the item "Grayout Safe Storage". There is no plaintext fallback. Self-hosted installs keep their Anthropic or OpenAI key in the same place.
- `verdicts.jsonl` — one line per check with a timestamp, the verdict, the category phrase the model returned, the name of the frontmost app, and the number of displays. No screenshots, no on-screen text. Kept for 30 days (`historyDays`) and deletable at any time from Settings > Delete all history. This file never leaves your Mac.
- `state.json` — your device id, onboarding progress, the daily check counter, and update-check bookkeeping.
- `logs/grayout.log` — a rotating app log (1 MB, three files) of short status lines. It never contains prompt text, images, task titles, the work description, your license key, or an API key; anything that looks like a key is redacted before it is written.

Screenshot files are written to a temporary folder named `grayout-frames-<pid>` under your user's temp directory and deleted immediately after they are encoded. The folder is removed on exit, and leftovers from a force-killed instance are removed at the next launch.

## The complete list of outbound connections

1. `https://api.grayout.app` — the checks, and the subscription calls that go with them (starting checkout, claiming a license after payment, re-validating on launch, opening the billing portal). This is the only host that ever receives a screenshot.
2. `https://api.github.com` — once a day for the release check, if `checkForUpdates` is on.
3. Your Canvas host — only if you configured `canvas.baseUrl` and a token.
4. Pages you open yourself by clicking a link in the app, which open in your browser: this site, GitHub, and Stripe's checkout and billing portal.

That is all. No crash reporting, no usage statistics, no fonts or scripts fetched at runtime, no third-party SDK inside the app. A self-hosted install replaces line 1 with `api.anthropic.com` or `api.openai.com` under your own key.

## Camera

The camera is off by default. If you turn it on, macOS asks for permission at that moment, and Grayout captures one frame per check inside a sandboxed hidden window and sends it with the screenshot. Frames exist only in memory. The prompt treats an empty chair, a person looking away, or a person out of frame as not off task; the only webcam condition that counts against you is a phone clearly in hand while nothing is being worked on. Turn it off in Settings or revoke it in System Settings > Privacy & Security > Camera.

## Other people on your screen

A screenshot can include other people: a video call, a shared screen, a chat. Two defaults reduce that exposure, and both are yours to change:

- Video-call apps (Zoom, FaceTime, Microsoft Teams, Webex, Google Meet, Discord) in front never trigger a check; the frontmost app is read without a capture and the check is skipped.
- Password managers (1Password, Bitwarden, Passwords, Keychain Access) in front are never captured at all.

Both lists match the frontmost app only. Other windows on the same display are part of the capture, so a password manager left open behind a browser can appear in a screenshot. Pause Grayout when that matters.

## Your controls

- **Pause** from the menu bar, for 15 minutes, an hour, until tomorrow, or until you resume. Nothing is captured while paused.
- **I'm working** clears the gray and prevents any trigger for ten minutes.
- **Never capture** and **Never trigger in** lists in Settings.
- **Delete all history** in Settings empties the verdict log.
- **Quit** stops everything and restores color. A quit app captures nothing and sends nothing.
- **Cancel** in Stripe's billing portal, from Settings > Manage subscription. A cancelled or lapsed license makes every check fail closed, which means on task.
- **Uninstall**: cancel, quit, drag to the Trash, delete `~/Library/Application Support/Grayout`, turn off the login item.
- **Self-host**, below, if you want none of this to involve us.

## How OpenAI handles what we send it

Once a screenshot reaches OpenAI it is governed by OpenAI's terms, not by this page. Read it directly rather than relying on a paraphrase here: [OpenAI's API data usage policies](https://openai.com/policies/api-data-usage-policies). Nothing on this page is a guarantee about OpenAI's practices, and we cannot make commitments on their behalf.

What we can tell you is what we do: the images go under Grayout's API key with no identifier of yours attached, they are not stored on our side, and they are not logged on our side.

A self-hosted install sends to Anthropic or OpenAI under your own key instead; then [Anthropic's commercial terms](https://www.anthropic.com/legal/commercial-terms) and [privacy policy](https://www.anthropic.com/legal/privacy), or OpenAI's policy above, govern directly and we are not in the path at all.

## Self-hosting, if you would rather send us nothing

Grayout is MIT-licensed and the entire app and service are in the repository. Setting `provider` to `anthropic` or `openai` in `config.json`, with your own key, makes the app call that provider directly and never contact `api.grayout.app` at all. No license, no subscription, no device id sent anywhere, no Stripe. The README has the exact configuration.

The default, `provider: "auto"`, does this on its own when a model API key is already saved on the Mac, which is what happens to an install upgraded from Grayout 1.x. Such an install keeps sending to Anthropic or OpenAI under that key and never contacts us. Set `provider` explicitly if you would rather not have this depend on what is in your Keychain.

This is a real option, not a formality. It is the reason the source is public.

## Unsigned app status

Grayout is signed ad hoc and is not notarized by Apple, so the first launch shows the "Apple could not verify" dialog. The build is reproducible from the public source: every release is built by GitHub Actions from a tagged commit, and the release page carries SHA-256 checksums you can compare against your download. Notarization is the first item on the roadmap.

## Not for monitoring other people

Grayout is built for one person watching their own screen. It has no remote view, no shared dashboard, no team plan, no export to anyone else, and it never will. The service knows your license and a count of checks; it cannot tell you or anyone else what a person was doing. Do not install it on a machine you do not own or on someone else's account.

## Changes to this policy

Changes are dated at the top of this page, recorded in the repository's history, and summarized in `CHANGELOG.md`. A change that sends anything new off your Mac, or that starts storing something the service does not store today, will be called out in the release notes rather than edited in quietly.

## Contact

Open an issue at https://github.com/aarushkandukoori/grayout/issues. For a security problem, use the private reporting path in `SECURITY.md`. For a data deletion request, an issue is enough; do not paste your license key into it, say which email paid for it and the request will be matched through Stripe. A support email address will be listed here once one exists.
