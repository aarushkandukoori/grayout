# Grayout privacy policy

Effective 2026-10-15. Covers this website and Grayout for Mac however you got it (GitHub, Homebrew or the Mac App Store), with the Grayout service (the 100 free checks and Grayout Pro) or on your own API key (today's 1.x release, and the direct download and source builds after it). This is the same text as the [privacy page on the site](https://aarushkandukoori.github.io/grayout/privacy.html).

Grayout looks at your screen, so this page is specific about where every byte goes.

## The short version

- **Grayout asks first.** Before anything leaves your Mac, the app shows what it sends at each check and who receives it, and asks for your permission. Nothing is captured until you click Allow and continue, and you can withdraw it any time in Settings.
- **Screenshots are judged and dropped.** Each check sends a resized screenshot for a one-line verdict. Nothing in the chain we run stores it or logs it.
- **With the Grayout service** (the free checks and Grayout Pro, in either edition), the screenshot goes to the Grayout service, which passes it to OpenAI under Grayout's key and returns the verdict. OpenAI doesn't train on it and may keep it for up to 30 days to check for abuse. The service keeps device and license records and counts of checks. It does not keep the image.
- **On your own key** (direct download and source builds only), the screenshot goes straight from your Mac to OpenAI or Anthropic under your account. We are not in the path at all.
- **Payments** are handled by Stripe and sold through Link. Grayout never sees your card number and never stores your email address. To give one free trial per person, the service reads your email and your card's fingerprint from Stripe when a trial starts and keeps only keyed hashes of them.
- **This website** sets no cookies and runs no analytics.

## Asking first

The first time Grayout starts, and once after updating from a version that did not ask, it shows a screen before anything is captured. That screen says:

- what is sent at each check: a screenshot of each display, resized; the name of the app in front; your work description and task titles if you add them; and one webcam frame, only if you turn the camera on;
- who receives it: OpenAI, through the Grayout service, or the provider you chose if you run on your own key or the Claude CLI engine;
- that the Grayout service keeps none of it.

**Not now** means nothing is captured or sent, and setup can't finish. **Allow and continue** records your permission, with the date, on your Mac only. To withdraw it, turn off **Send screenshots for checks** in Settings: checks stop at once, and nothing more is sent until you turn it back on. If what Grayout sends or who receives it ever changes, the app asks again.

## What the app sends, and to whom

| What | Goes to | When |
|---|---|---|
| A screenshot of each display (up to three), resized to 1366 px wide and compressed | The Grayout service and then OpenAI on the free checks and Pro; your provider on your own key | At each check, while you are at your Mac and Grayout is not paused |
| One webcam frame, 640 by 480 | Same place as the screenshot | Only if you turned the camera on. It is off by default |
| Your one-line work description | Same place as the screenshot | At each check, if you wrote one |
| Titles of your Canvas to-dos, or unchecked lines of your task file | Same place as the screenshot | Only if you set one of them up. Direct download only |
| The name of the app in front (for example "Code") | Same place as the screenshot | At each check |
| Your license key, device id and device token | The Grayout service only | On the free checks and Pro, with each check and when the app checks your plan |
| A request for the latest version number | api.github.com | Direct download only, once a day. Carries no identifier. Switch it off in Settings. The Mac App Store edition never makes this request |
| Your Canvas token, to fetch your to-do list | Your own Canvas host | Every 10 minutes, only if you set up Canvas. Direct download only |

The prompt asks the model for three fields: whether you are off task, a short activity phrase, and a confidence. It tells the model to name only a category of what it sees, such as "code editor and terminal," and never on-screen text, names, message contents, links or personal details. Task titles and your work description are marked as untrusted, and the model is told to ignore any instructions inside them.

Screenshot files are written to a private temporary folder and deleted right after they are encoded. Webcam frames never touch the disk.

The camera is used only for the optional webcam check. macOS asks for permission the first time you turn it on. Turn it off in Settings, or revoke the permission any time in System Settings > Privacy & Security > Camera, and no frame is taken. The Mac App Store edition asks for the camera only for this option.

Direct download and source builds only: with `engine: "cli"` in config.json (an advanced setting with no switch in the app), neither the Grayout service nor a model provider is contacted by Grayout for checks, and no license key or device token is sent with them. Instead Grayout starts the local `claude` CLI at each check and passes the frames, the work description, task titles and app name on its standard input (the frames are not written to disk for it); the CLI sends them to Anthropic under your own Claude subscription login. It runs with no tools, no MCP servers, no hooks, no auto-memory and no saved session, with only a short allowlist of environment variables (no API keys), and with Claude Code's non-essential traffic (telemetry, error reports, auto-update) turned off. An `@` in your task titles or work description is sent as `＠`, so the CLI never attaches a local file named there. Anthropic's terms for your Claude plan govern those requests.

## What the Grayout service stores

This applies to Grayout Pro and the 100-check free taste, in either edition, once the service opens. Not stored, anywhere in the service: screenshots, webcam frames, prompts, verdicts, activity phrases, your work description, task titles, names, email addresses, card details, IP addresses in clear, or license keys. They exist for the length of one request and are dropped.

What is stored, in a Cloudflare D1 database:

- **For each device** (a Mac running Grayout, or a browser that clicked Subscribe): a random id, when it was created and last seen, how many free checks it used, whether it started a trial, and which license it uses. For 48 hours only, a keyed hash of its IP address, used only to limit how many devices one network can create. The rest of the device record has no end date yet.
- **For each license:** a one-way hash of the key, the Stripe customer id, the subscription state copied from Stripe (status, plan, period dates), and monthly check counts. The record is kept while the license exists, and each month's count for 13 months.
- **For each network, free checks only:** a keyed hash of the network address and how many free checks it used this month, deleted when the month ends. On IPv6, also a keyed hash of its /48 block (a wider address range that can hold many networks) and how many free checks the block used each day, deleted after 7 days. This is what stops one network from using up everyone's free checks.
- **For each trial, for one year:** keyed hashes of the buyer's email address and card fingerprint, only to give one free trial per person. Deleted after a year. A keyed hash can't be turned back into the email or the card.
- **For each checkout:** the Stripe Checkout Session id, the device that started it, the plan, whether it came with a trial, and whether it was paid. Deleted after 30 days. A purchase started in the app also has a short code that links it to that Mac, deleted a day after the code expires.
- **Webhook bookkeeping:** the ids of Stripe events already handled, so none is processed twice. Deleted after 30 days.

Every keyed hash here is an HMAC made with a secret that only the service holds.

Requests are also rate limited by network address. Those limits count requests in memory and write nothing down. Cloudflare runs the service's infrastructure and sees each connection the way any host does; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).

## The AI model, and who else handles your data

With the Grayout service, the service sends the screenshot and the rest of the check to OpenAI's API under Grayout's API key, with no identifier of yours attached, and asks OpenAI not to store the response. OpenAI does not use data sent through its API to train its models. Under its API data policy it may keep API inputs, which here include the images, for up to 30 days to monitor for abuse, and then deletes them unless the law requires it to keep them longer. See [OpenAI's enterprise privacy commitments](https://openai.com/enterprise-privacy/), which cover its API, and [how OpenAI handles API data](https://developers.openai.com/api/docs/guides/your-data).

On your own key (direct download and source builds), your Mac sends the screenshot to OpenAI or Anthropic under your account, and your own terms with that provider apply: see the OpenAI pages above or [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). With the Claude CLI engine, it goes to Anthropic under your Claude plan's terms.

Apart from a provider you choose yourself, the app's data goes to three service providers only: OpenAI (the AI model), Cloudflare (which runs the Grayout service) and Stripe (payments, through Link). We only use service providers that are bound by written data-protection terms giving your data the same or equal protection as this policy. Each one gets only what its part needs and may use it only to provide that service to us. Stripe, as the merchant of record, also handles your payment details under its own privacy policy. We don't sell your data and we don't share it for advertising.

## Payments

Grayout Pro is sold through Link, Stripe's checkout, and Stripe is the merchant of record. When you subscribe, you are on Stripe's page under Stripe's terms. Stripe collects your email, card and the billing address it needs for tax, calculates and collects sales tax or VAT, sends receipts from Link, and answers payment questions. Your statement shows LINK.COM*.

Grayout never sees your card number and never stores your email address. From Stripe, the service learns a customer id, a subscription id, the plan and its status. Stripe's record of a purchase also carries your email address, and when a trial starts the service reads your card's fingerprint (Stripe's id for a card, which can't be used to charge it). It uses the two only to make the keyed hashes described above, at once, and keeps neither. See [Stripe's privacy policy](https://stripe.com/privacy) and [Link's privacy policy](https://link.com/privacy).

## This website

The site is hosted on GitHub Pages, which sees your IP address and browser details when you load a page; see [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Fonts and scripts are served from the same place. There are no cookies, no analytics, no ads and no third-party scripts.

Once subscriptions open, the site talks to the Grayout service in four cases only: a status check for the footer, registering this browser when you click a subscribe button (kept in your browser's local storage as `grayout.device`), fetching your key on the page Stripe returns you to (kept for that tab in session storage as `grayout.claim`), and opening the billing portal if you paste a license key on the account page. Clearing your browser's site data removes both.

A link to the Mac App Store, where the site shows one, is a plain link served from this site. Nothing loads from Apple until you click it, and on apps.apple.com [Apple's privacy policy](https://www.apple.com/legal/privacy/) applies.

## If you got Grayout from the Mac App Store

Apple distributes and reviews this edition, but Apple is not a party to this policy, and Grayout sends Apple nothing about your checks. Apple's own [privacy policy](https://www.apple.com/legal/privacy/) covers your download and anything you choose to share with developers through Apple, such as crash reports.

- It asks first, sends the same things to the same places, and the Grayout service keeps the same records, all as described above.
- It always uses the Grayout service. It has no own-key mode and no Claude CLI engine, and it does not read Canvas or a task file.
- Grayout Pro is still bought on Stripe's checkout page in your browser, not through Apple, so Apple doesn't see or handle that payment.
- It gets updates from the App Store and never contacts GitHub.
- It runs in Apple's App Sandbox and keeps its files in `~/Library/Containers/com.aarushkandukoori.grayout/Data/Library/Application Support/Grayout/`.

## What stays on your Mac

Everything lives in `~/Library/Application Support/Grayout/` (in the Mac App Store edition, the container folder above), readable only by your user account.

- **config.json:** your settings, including the work description.
- **secrets.bin:** your license key or API key, your device token, and any Canvas token, encrypted with a key held in your macOS Keychain. There is no plain-text copy.
- **verdicts.jsonl:** one line per check with the time, the verdict, the category phrase, the app in front and the number of displays. No screenshots and no on-screen text. Kept for 30 days and deletable any time from Settings. This file never leaves your Mac.
- **state.json:** your device id, setup progress, whether and when you allowed checks to be sent, and update-check bookkeeping.
- **logs/grayout.log:** short status lines, capped at a few megabytes. Never images, prompts, task titles, your work description or any key.

## Other people on your screen

A screenshot can include other people: a call, a shared screen, a chat. Two defaults reduce that, and both are yours to change. When a video-call app such as Zoom, FaceTime, Teams or Webex is in front, no check happens. When a password manager such as 1Password, Bitwarden or Passwords is in front, nothing is captured at all. Both rules look at the app in front only, so a window left open behind it can still appear in a later capture. Pause Grayout when that matters.

## Your controls

- **Send screenshots for checks** in Settings. Off withdraws your permission and stops all checks until you turn it back on.
- **Pause** for 15 minutes, an hour, until tomorrow, or until you resume. Nothing is captured while paused.
- **I'm working** clears the gray and holds off for ten minutes.
- **Never capture** and **never trigger** lists in Settings.
- **The camera** is off unless you turn it on, and macOS lets you revoke it in System Settings > Privacy & Security > Camera.
- **Delete all history** in Settings empties the log.
- **Erase this Mac's Grayout data** in Settings deletes Grayout's settings, history, license key and device token on this Mac and restarts it fresh. It does not cancel a subscription or delete what the service holds; see below.
- **Quit** stops everything and restores color.
- **Cancel** any time from Manage subscription or at link.com. A lapsed plan stops the checks. It does not gray your screen.

## Retention and deletion

- Screenshots and webcam frames: not kept by us. OpenAI (with the Grayout service) may keep them for up to 30 days for abuse monitoring, as described above. On your own key, your provider handles them under its own policy.
- Device records: kept with no end date (there is no automatic deletion yet). They hold a random id and counters, nothing that names you, and the IP address hash in them is cleared after 48 hours.
- License records: kept while the license exists. Monthly check counts: 13 months.
- Free-check counts per network: until the month ends. Per IPv6 /48 block: 7 days. Trial hashes: one year. Checkout records and webhook ids: 30 days. App purchase codes: a day after they expire.
- Stripe's records: kept by Stripe as its terms and tax law require. We can't delete an invoice.
- Everything on your Mac: yours. It is gone when you delete the folder above or use Erase this Mac's Grayout data in Settings.

To have your license record deleted, ask Link to delete your data at link.com. Stripe then cancels the subscription and tells us, and we delete your license record, its monthly check counts and your trial hashes. Your device records are unlinked from it and kept, holding only a random id and counters. Or email the support address listed on the [privacy page](https://aarushkandukoori.github.io/grayout/privacy.html#deletion), once there is one, from the address you paid with. Please don't post your email address or license key in a public GitHub issue.

## Not for watching other people

Grayout is built for one person watching their own screen. It has no remote view, no team plan and no way to share what it saw, and it never will. Don't install it on a computer you don't own or on someone else's account.

## Children

Grayout is not directed at children under 13, and we don't knowingly collect personal information from them. You must be at least 13 to use Grayout, and anyone under 18 needs a parent or guardian's permission (see the [terms](https://aarushkandukoori.github.io/grayout/terms.html#age)). If you think a child under 13 has used the Grayout service, contact us (below) and we will delete what the service holds about that install.

## Why macOS warns you about the direct download

The direct download is signed ad hoc and not yet notarized by Apple, so its first launch shows a warning. Every release is built by GitHub Actions from a tagged commit in the public repository, with SHA-256 checksums on the release page. Apps from the Mac App Store are signed by Apple and open without this warning.

## Changes and contact

Changes are dated at the top of this page and recorded in the repository's history. Anything that sends something new off your Mac, or stores something new, is called out in the release notes. If what the app sends or who receives it changes, it asks for your permission again.

Questions: the support address listed on the [privacy page](https://aarushkandukoori.github.io/grayout/privacy.html#changes) (once there is one), [GitHub issues](https://github.com/aarushkandukoori/grayout/issues), or the [support page](https://aarushkandukoori.github.io/grayout/support.html). Security reports: the repository's private vulnerability reporting, described in [SECURITY.md](https://github.com/aarushkandukoori/grayout/blob/main/SECURITY.md).
