# Changelog

All notable changes to Grayout are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Planned for 2.0.0. Not released yet: the latest release is still 1.0.1, which runs on your own API key.

Grayout becomes a subscription product. It used to ask every person for their own Anthropic or OpenAI API key; it now sells a plan and makes the model calls itself.

### Breaking

- **Bring your own key is no longer the product.** A fresh install runs on the Grayout service and a subscription. There is no key screen in onboarding, no key to get, and nothing to paste on first launch. The free, key-shaped version of Grayout that 1.x was does not exist any more.
- **Release builds are pay-only.** Every public 2.0 build (the direct download, Homebrew and the Mac App Store edition) runs only on the Grayout service: 100 free checks, then the 7-day trial or Grayout Pro. Own-key mode (Anthropic or OpenAI) and the Claude CLI engine are not in any public build, and `config.json` or environment variables can't turn them on there. The code stays in the MIT source.
- **Updating from 1.x moves the Mac onto the Grayout service.** A key saved by 1.x is no longer used, and the Mac starts with the 100 free checks like a new install. Updating charges nothing on its own.

### Added

- **A Mac App Store edition (United States storefront only), built from the same code. Not listed yet.** `src/channel.js` decides which edition a build is (Electron's `process.mas` when packaged; `GRAYOUT_CHANNEL=mas` only when running unpackaged) and what it may do. The Mac App Store edition runs in Apple's App Sandbox and switches off what App Review or the sandbox does not allow: the GitHub update check (updates come from the App Store), the `apiBase` override, the LaunchAgent login-item fallback, Move to Applications, the `tccutil` hint, the Sponsor link, and Canvas and the task file. It grays the screen with a new helper, `helper/grayout-overlay`: one click-through window per display, just below the red border, whose layer uses the `saturationBlendMode` Core Animation blend mode to desaturate what is beneath it. No display setting changes, and the helper exits when its stdin closes or its parent dies, so the gray cannot outlive the app. The direct download keeps the Color Filters helper. Grayout Pro is still bought on the web through Stripe in both editions (the App Store listing uses the United States link-out rule, with no Apple in-app purchase), and screen capture still uses `/usr/sbin/screencapture`. The listing is "Grayout: Back to Work", because "Grayout" is taken on the App Store; in the app it stays Grayout. The paste-ready listing, privacy-label answers, review notes, screenshot plan and owner checklist are in `store/mac-app-store/`.
- **Grayout asks before any screenshot leaves your Mac, in both editions.** A consent step before the Screen Recording step names who receives the screenshots (OpenAI, through the Grayout service), lists what is sent at each check, and says the service keeps none of it. Nothing is captured until you click Allow and continue; Not now means setup can't finish. An install that finished setup before this asks once at its next launch. Send screenshots for checks in Settings withdraws consent and pauses the loop, and Erase this Mac's Grayout data deletes every file Grayout keeps on the Mac and restarts it fresh.
- A support page (`docs/support.html`) with contact details, the stuck-gray escape hatches for both editions, and billing, refund and privacy links. It is the App Store listing's Support URL.
- **Subscription: $9.99 a month or $79 a year**, with a 7-day free trial on monthly, and **100 free checks first** with no card and no account. The free taste is bound to the install, not to an identity.
- **The Grayout service** (`server/`, a Cloudflare Worker on `workers.dev` until a domain is bought): it holds the model key, owns the prompt, checks the license, counts the checks, and returns the verdict. The app never sees a model key. Endpoints and payloads are fixed in `docs/API-CONTRACT.md`.
- **Sign-in with no sign-in.** Click Subscribe, pay on Stripe's page, and the app unlocks itself by polling for the license attached to a short-lived device code. Nothing to copy, no password to invent. Pasting a license key still works for a second Mac or a reinstall.
- A purchase that starts on the website is claimable too: `POST /v1/claim` with the Checkout Session id in the JSON body reads the session back and hands over the license it bought, so `success.html` can show the key to somebody who bought before they installed the app.
- Stripe billing portal from Settings > Manage subscription, for changing the card, switching plans, or cancelling.
- A license key format (`gry_live_` plus 24 Crockford base32 characters), stored with `safeStorage` beside the Canvas token, masked everywhere it is shown and never logged.
- A device identity that the service makes (`POST /v1/device`): a random id kept in `state.json` and a token kept encrypted in `secrets.bin`. It scopes the free taste; an id the service did not make counts for nothing. Nothing about the machine is hashed into it.
- **Change-gating.** Before spending a check, the app compares an 8×8 average hash of each display against the previous one; if no display changed, the frontmost app is the same, and no alert is running, the call is skipped and the previous verdict stands. A real check is forced at least every `forceCheckSec` (180 by default) so a deliberately still screen is still caught. This roughly halves both the bill and the latency of an idle desk, and it is what makes $9.99 work. Turn it off with `"changeGating": false`.
- New config keys: `changeGating` and `forceCheckSec`.
- A billing issue template, and a license question path in the install template. Neither asks for anything secret.

### Changed

- **Privacy policy and terms, effective 2026-10-15.** Both cover the Mac App Store edition (Apple is not a party; Apple's standard EULA covers the app; Grayout Pro is never cancelled or refunded through Apple), the consent step, that OpenAI may keep API inputs for up to 30 days for abuse monitoring while the Grayout service stores none, that the free checks follow the same path as Pro, a commitment to use only service providers bound by written data-protection terms, how to revoke the camera, and a minimum age of 13 (under 18 with a parent or guardian's permission). Refunds and account pages say what changes, and what doesn't, for Mac App Store users.
- **The site offers no own-key option once the service is on.** The own-key plan card, the comparison column, the footer link and the `api-key.html` guide show only in the service-off state, while 1.0.1 (own key only) is the latest release. With the service on, the site says Grayout runs on the Grayout service and needs the free checks, the trial or Grayout Pro, and `api-key.html` says own keys were a 1.x feature. The privacy policy and terms scope the own-key path to 1.x and drop the Claude CLI engine.
- After a checkout started in the app, `success.html` leads with "You can close this tab. Grayout in your menu bar is already unlocked." and shows the key only as a key for another Mac. A cancelled checkout from the app (`pricing.html?canceled=1&from=app`) says nothing was charged and to go back to Grayout, instead of offering the download.
- **What leaves your Mac and to whom.** Screenshots now go to the Grayout service, which forwards them to OpenAI under Grayout's key and returns a verdict. The service does not store the images and does not log them; it stores a license record, a device record, a monthly check count, and a Stripe customer id. `PRIVACY.md` and `docs/privacy.html` are rewritten around this and are the authority on it.
- The prompt lives on the service, so judgement improves without an app update. The client sends pixels and context, never prompt text.
- Failing closed now covers billing: an expired trial, a lapsed subscription, an exhausted free taste, a revoked license, a rate limit, or an unreachable service all stop checks and reset the strike counter. No billing state can gray a screen.
- Past the monthly allowance the service stretches the interval rather than cutting anyone off.
- `SECURITY.md` gains the service in its threat model: the shared model key in Worker secrets, license keys as bearer credentials, images in transit, webhook signature verification, and the rate limits.
- Release builds show checks used against the allowance instead of a per-check cost, because the per-check price is ours to worry about, not yours.
- `notes/hosted-plan.md` became the operator notes. It moved out of `docs/`, so GitHub Pages no longer publishes it. Parts of it still describe the v2 design (KV, `api.grayout.app`); `docs/API-CONTRACT.md` v3 is the authority.

### Fixed

- **An invalid config.json no longer switches settings.** While running, Grayout keeps the last good settings; at launch it pauses checks until the file parses, and Settings won't overwrite it with defaults. Running on the defaults would have sent checks to the Grayout service over one misplaced comma.

### Removed

- The API-key onboarding screen, the key test, and the bring-your-own-key framing throughout the app's first run and the site. Own-key mode and the Claude CLI engine are out of every public build (see Breaking), and the README no longer documents how to turn them on.
- The hosted-plan waitlist. The hosted plan is the product.

## [1.0.1] - 2026-09-22

### Fixed

- **The screen never actually turned gray.** The helper used the private
  `CGDisplayForceToGray`, which on macOS 26 still sets and reports its own flag
  while the display keeps rendering in color, so every alert looked like it
  worked and did nothing. The helper now drives the same switch as System
  Settings > Accessibility > Display > Color Filters, which does work.
  Screenshots do not show color filters, which is why the app's own
  verification could not catch this.

### Added

- Grayout will not take the Color Filters switch from someone who already uses
  it: if the filter is on at launch and Grayout did not leave it that way, the
  red border becomes the only consequence and the menu bar says so.
- If a crash leaves the screen gray, the next launch recognises its own doing
  and restores color.
- Seven tests covering that ownership logic, against a stub helper so the suite
  can never change the display of the machine running it.

## [1.0.0] - 2026-09-21

First public release. Grayout is the packaged successor to the author's private "Screen Monitor" tool, which ran every workday for six weeks (12,650 checks) before this build.

### Added

- Packaged DMGs for Apple Silicon and Intel (`Grayout-arm64.dmg`, `Grayout-x64.dmg`) with a `SHA256SUMS.txt`, built and published by GitHub Actions on every `v*.*.*` tag. Ad-hoc signed with an identifier-based designated requirement so permission grants are meant to survive updates.
- Five-screen onboarding: how it works, Screen Recording with a relaunch step and stale-grant detection, API key with a live test against a synthetic frame, setup (work description, check interval with cost estimates, camera, start at login), and a gray preview before the loop is armed.
- OpenAI keys (gpt-5-mini by default) alongside Anthropic (claude-haiku-4-5). The provider is read from the key, so there is nothing to configure; `provider` in config.json overrides it. OpenAI requests go through the Responses API with `store: false`.
- Bring your own key: the Anthropic or OpenAI API key is stored with Electron `safeStorage` in the macOS Keychain (`Grayout Safe Storage`), never in plaintext, never in logs, and shown only masked in Settings. An in-memory session key is offered when secure storage is unavailable.
- Cost meter: every verdict logs the provider's token usage and a local price estimate for both providers' models; the dashboard shows spend today, checks today, and a monthly projection. `dailyCheckCap` (1,200) pauses checks for the day.
- **I'm working** in the menu bar and a **Wrong call?** button per flag on the dashboard: color comes back, the check is logged as disputed, and nothing fires for ten minutes.
- Video-call allowlist (`alwaysAllowedApps`): Zoom, FaceTime, Microsoft Teams, Webex, Google Meet, and Discord in front never trigger and clear an alert.
- Never-capture list (`neverCaptureApps`): password managers in front are never captured at all.
- Lock-screen and sleep pause (`pauseWhenLocked`) with a 45-second grace after wake.
- Watchdog (`maxAlertMinutes`): color always comes back after 20 minutes of gray, with a generic notification.
- Always-visible **Restore color now** menu item, enabled in every state.
- Update check against GitHub Releases once a day (anonymous, switchable, no auto-download).
- Settings section in the dashboard: interval, strikes, work description, grayscale and red-border toggles, camera, start at login, update check, allowlists, API key change, data folder, delete history.
- Permissions menu: Screen Recording, Camera, and Login item status, deep links to the right System Settings panes, and a copyable `tccutil reset` command for stale grants.
- Repository documents: README, PRIVACY, SECURITY, CONTRIBUTING, issue forms, a hosted-plan document, and a stranger-test checklist.

### Changed

- Renamed from Screen Monitor to Grayout. Bundle id `com.aarushkandukoori.grayout`, data folder `~/Library/Application Support/Grayout/`.
- Frontmost app detection uses `lsappinfo` instead of AppleScript, so no Automation permission is ever requested.
- All renderer windows run with `contextIsolation`, `sandbox`, and no `nodeIntegration`; pages talk to the main process only through a small preload surface.
- Default check interval is 45 seconds (was 30). Camera is off by default (was on).
- Screenshot frames are written to a per-process temp directory and deleted right after encoding; webcam frames never touch the disk.
- The app log no longer contains prompt text, images, task titles, or the work description, and redacts anything that looks like an API key.
- The verdict log is pruned to `historyDays` (30) at launch and once a day.
- The prompt names only the category of what is on screen, never on-screen text, and treats video calls and screen shares as work.

### Removed

- The LaunchAgent-based install and the `claude` CLI engine as a user-facing option. Start at login is a checkbox; the product speaks to Anthropic's or OpenAI's API only, under your key.

[Unreleased]: https://github.com/aarushkandukoori/grayout/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/aarushkandukoori/grayout/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/aarushkandukoori/grayout/releases/tag/v1.0.0
