# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: https://github.com/aarushkandukoori/grayout/security/advisories/new. It reaches the maintainer without creating a public issue. An email address for reports will be added here once a support address exists.

Please include the Grayout version (About Grayout in the menu bar), your macOS version, and steps to reproduce. If the report is about the service, include the `X-Grayout-Request-Id` header from the response and the time, not a packet capture full of your own screen.

Do not include screenshots of your own screen, your license key, your API key, or the contents of `secrets.bin`. A license key in a report is treated as compromised. (There is no way to replace a single key yet; the maintainer will contact you about what to do.)

You can expect an acknowledgement within a few days. App fixes ship as a patch release with a note in `CHANGELOG.md`; service fixes are deployed and noted in the changelog under the date they went out. Credit is given if you want it.

## Supported versions

Only the latest release is supported. Update the direct download by downloading the current DMG, and the Mac App Store edition (not listed yet) through the App Store. The service runs one version, the deployed one.

## Threat model

Grayout runs as your user, captures your screen, and, once you have allowed it in onboarding, sends the captures to the Grayout service (the address in `src/config.js`), which forwards them to OpenAI under Grayout's own key and returns a verdict. A self-hosted install (direct download and source builds only) replaces that hop with a direct call to Anthropic or OpenAI under your key. The Mac App Store edition is the same code with some features switched off by `src/channel.js`, running inside Apple's App Sandbox. The model below is what the design defends against and what it does not.

### Assets

- The contents of your screen, at each check, on your Mac and in transit.
- Your Grayout license key (and Canvas token, or an Anthropic or OpenAI key when self-hosting).
- The shared model key the service uses on everyone's behalf. It is the single highest-value secret in the system.
- The Stripe API key (the documented setup is a restricted `rk_` key with only the permissions the service uses; a full `sk_` key works but logs a warning), the webhook signing secret, and the two server secrets that make device tokens and license keys (`DEVICE_SECRET`, `LICENSE_SECRET`).
- Webcam frames, if the camera is on.
- Control of the display: the ability to put your Mac in grayscale.
- The integrity of the billing state: nobody should get checks they did not pay for, and nobody who paid should be locked out.

### Adversaries considered

- **A curious housemate** with physical access to your unlocked Mac, or a glance at the menu bar.
- **Malware running as the same user**, which can read anything your user can read.
- **A malicious web page, Canvas assignment, or task-file line** that tries to steer the verdict through text the model sees.
- **Someone trying to use the service without paying**: a stolen or shared license key, a replayed free taste, a forged webhook, or a client that simply asks for more than its allowance.
- **Someone attacking the service to reach the shared model key**, which would let them spend Grayout's money and read whatever they could induce the service to forward.
- **A network attacker** between your Mac and the service.
- **An outage, rate limit, or broken response**, from the service or from OpenAI, which must not leave your screen gray.

### Mitigations on your Mac

- A build whose service address was never filled in (`DEFAULT_API_BASE` in `src/config.js` is still the placeholder `__GRAYOUT_API_BASE__`, which is deliberately not a URL) never contacts any service. It never falls back on a guessed address such as a domain nobody owns.
- Every file in `~/Library/Application Support/Grayout/` is created with mode 0600 inside a 0700 directory.
- The license key and the device token are encrypted with Electron `safeStorage`, backed by a macOS Keychain item, with no plaintext fallback. It is never written to `config.json`, the verdict log, or the app log; the logger redacts anything matching a license or API key shape, and the UI shows the license only as `gry_live_…` plus its last four characters.
- Screenshot files live in a per-process temp directory and are deleted right after encoding. Webcam frames are never written to disk.
- Canvas titles and task-file lines are fenced and labeled as untrusted data; both the app and the service tell the model never to follow instructions found there or on the screen.
- The verdict is coerced: anything not exactly `off_task: true` is on task, and confidence outside the allowed set becomes `low`.
- Two consecutive high-confidence off-task verdicts are required before the screen reacts. An error, a refusal, an HTTP failure, or any billing state that is not "you may check" resets the count to zero, and two consecutive failed checks clear an existing alert. Nothing about money can gray your screen.
- A watchdog restores color after 20 minutes regardless of state; color is also restored on every launch, on quit, on crash, on SIGINT and SIGTERM, on system shutdown, and from an always-enabled menu item.
- A daily cap (1,200 checks), change-gating, and exponential backoff on rate limits and outages bound both the request rate and, when self-hosting, the spend from a runaway loop.
- Renderer windows run with `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict Content Security Policy, and no remote content. Pages reach the main process only through the preload bridges in `ui/preload/`. Links opened from the app are limited to an allowlist of hosts, which now includes the Stripe checkout and billing-portal hosts.
- No Automation, Accessibility, or Full Disk Access permission is ever requested. Frontmost-app detection uses `lsappinfo` on the direct download and the bundled overlay helper's `NSWorkspace` call on the Mac App Store edition.
- No screenshot is captured and no check is sent until you allow it on the consent screen, which names who receives the screenshots. The permission is stored in `state.json` with its date and version, and turning off Send screenshots for checks in Settings withdraws it and pauses the loop.
- The Mac App Store edition runs in Apple's App Sandbox: it can't read files outside its own container, its helper inherits the same sandbox, and which edition a build is comes only from Electron's `process.mas` in a packaged app, never from an environment variable or `config.json`. It has no self-update check, no own-key mode, no Claude CLI engine and no `apiBase` override, and its bundle does not contain the private-API grayscale helper.
- The menu-bar tooltip shows status only, never the activity phrase, so a glance at the menu bar reveals nothing about what was on screen.

### Mitigations in the service

- **The shared model key lives only in the Worker secret store.** It is never sent to a client, never returned in a response, never written to a log, and is not in this repository. A client cannot make the service call anything but the model, with the service's own prompt, on the pixels it sent.
- **The app never holds a model key.** The worst a stolen license key gets an attacker is somebody else's check allowance, which is capped and revocable.
- **No credential ever travels in a URL.** Every endpoint except the health check is a `POST` with a JSON body; license keys, device tokens, device codes and Checkout Session ids go in the body. Query strings are ignored. Logs never carry a license key, a device token or a request body; a session id that has to be logged is cut to its last four characters.
- **License keys are never stored.** The database keeps only a SHA-256 hash of each key and looks keys up by that hash, so a copy of the database holds no working key. A key is derived again from the customer when it has to be shown (a claim, a restore).
- **The service mints device identities.** A device id only counts if it comes with a token the service made (an HMAC with `DEVICE_SECRET`), checked in constant time. Tokens are never stored.
- Revoking a license is a single write, and the next check fails closed. A full refund, a card dispute and a card-fraud warning from the bank each revoke the license and cancel the subscription automatically.
- **Images are never stored, never logged, and never written to disk by the service.** They exist for the length of one request. Neither are the work description, task titles, or the returned activity phrase. What persists is listed field by field in `PRIVACY.md`: the device record, the license record (Stripe customer id and subscription state, never the key), monthly counters, checkout bookkeeping, and keyed hashes used only for abuse limits (network addresses, and the email and card that started a trial).
- All traffic is HTTPS, so the images are in transit under TLS between your Mac and the service, and between the service and OpenAI. There is no plaintext fallback and no configurable way to turn it off. Pointing `apiBase` at a non-HTTPS host is a self-hosting decision and is yours to make safely.
- **Stripe webhooks are verified before anything is believed**: signature checked with Stripe's own `constructEventAsync` against the signing secret held in the Worker secrets, on the raw body. The endpoint fails closed (503) while the signing secret is missing or still a placeholder. Events are de-duplicated by id, and unknown event types return 200 and are ignored rather than guessed at.
- **Billing state is read from Stripe, never taken from the client or from an event's contents.** Every verified subscription, invoice, refund or dispute event makes the service read the customer's subscriptions from Stripe and write what it finds, so events arriving late or out of order cannot revive a canceled plan. Access ends 3 days after the paid period, whatever the stored status says, and the service re-reads Stripe before it turns anyone away. The app reports nothing about its own plan that the service trusts.
- **Sandbox and live never mix.** A key bought with a Stripe test card (`gry_test_`) never gets service from the live Worker, which has its own database.
- Rate limits: per network address on every route except the health check and the Stripe webhook, 40 requests a minute per device and 20 checks a minute per license (about 1,200 an hour), with bodies cut off as they stream in at 8 MiB for a check and 1 MiB for everything else. These bound both a leaked key and a client bug.
- **The free taste is bounded several ways:** 100 checks per device, device registration limited per network, 300 free checks per network a month however many devices it registers, and a global daily budget for everyone. The device counter is server-side and reserved atomically before the model is called. It is a taste, not a security boundary: someone with many networks can still get more free checks, and the daily budget caps what that can cost.
- Every response carries `X-Grayout-Request-Id`, which is what a bug report needs instead of a screenshot.

### Residual risks, disclosed

- The verdict log (`verdicts.jsonl`) is a plaintext list of timestamps, category phrases (for example "social media feed"), and frontmost app names, kept for 30 days on your Mac. Anyone who can read your files can read it. Delete it from Settings, shorten `historyDays`, or set `logVerdicts` to `false`.
- Malware running as your user can read the same files you can, including the encrypted `secrets.bin`, and can prompt the Keychain the same way the app does. Grayout does not defend against a compromised user account.
- The never-capture list applies to the frontmost app only. Other windows on the same display are in the capture.
- Your screenshots pass through the Grayout service and reach OpenAI. We do not store or log them; OpenAI's handling is governed by its own policy, linked from `PRIVACY.md`. If that arrangement is not acceptable, self-host: `provider` set to `anthropic` or `openai` removes the service from the path completely.
- Cloudflare operates the service and sees connection metadata, as any host does.
- A license key is a bearer credential. Anyone who has it can spend your allowance from any machine until you ask for it to be rotated. It is not a password and it protects no data of yours.
- A license key is derived from the Stripe customer, so the same customer always gets the same key. Replacing one leaked key is not built yet: until it is, a leaked key can only be revoked by hand, which also ends that subscription's service.
- Two other values are bearer credentials of a narrower kind. The device code the app makes before it opens checkout lives one hour and only works together with the device token of the Mac that made it. The Stripe Checkout Session id in the `success.html` link can be exchanged for the license that one purchase bought, and for nothing else, for 30 days; `success.html` removes it from the address bar at once. The service only answers for session ids it created itself, and both are rate limited.
- The service is a single Cloudflare Worker and a single D1 database with one maintainer. An outage stops checks; it never grays a screen.
- The direct download is ad-hoc signed and not notarized. Verify downloads against `SHA256SUMS.txt` on the release page, or build from source.
- On the direct download, grayscale is global system state (macOS's Color Filters setting). If the helper cannot run, the escape hatches in the README restore color by hand. On the Mac App Store edition the gray is a window owned by a helper process that exits when its pipe to Grayout closes or Grayout stops being its parent, so it cannot outlive the app.

### Out of scope

- Bypassing Grayout. It is not a lock. Quit is one click in the menu bar by design, and reports that a user can turn it off are not vulnerabilities.
- Getting free checks by reinstalling. The free taste is a taste; see above.
- Self-hosted deployments of `server/`. Your Worker, your secrets, your configuration.
- Monitoring other people. There is no remote view and there will not be one.
