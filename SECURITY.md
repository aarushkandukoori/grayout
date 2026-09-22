# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: https://github.com/aarushkandukoori/grayout/security/advisories/new. It reaches the maintainer without creating a public issue. An email address for reports will be added here once a support address exists.

Please include the Grayout version (About Grayout in the menu bar), your macOS version, and steps to reproduce. If the report is about the service, include the `X-Grayout-Request-Id` header from the response and the time, not a packet capture full of your own screen.

Do not include screenshots of your own screen, your license key, your API key, or the contents of `secrets.bin`. A license key in a report is treated as compromised and revoked.

You can expect an acknowledgement within a few days. App fixes ship as a patch release with a note in `CHANGELOG.md`; service fixes are deployed and noted in the changelog under the date they went out. Credit is given if you want it.

## Supported versions

Only the latest release is supported. Update by downloading the current DMG. The service runs one version, the deployed one.

## Threat model

Grayout runs as your user, captures your screen, and sends the captures to the Grayout service at `api.grayout.app`, which forwards them to OpenAI under Grayout's own key and returns a verdict. A self-hosted install replaces that hop with a direct call to Anthropic or OpenAI under your key. The model below is what the design defends against and what it does not.

### Assets

- The contents of your screen, at each check, on your Mac and in transit.
- Your Grayout license key (and Canvas token, or an Anthropic or OpenAI key when self-hosting).
- The shared model key the service uses on everyone's behalf. It is the single highest-value secret in the system.
- The Stripe secret key and the webhook signing secret.
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

- Every file in `~/Library/Application Support/Grayout/` is created with mode 0600 inside a 0700 directory.
- The license key is encrypted with Electron `safeStorage`, backed by a macOS Keychain item, with no plaintext fallback. It is never written to `config.json`, the verdict log, or the app log; the logger redacts anything matching a license or API key shape, and the UI shows the license only as `gry_live_…` plus its last four characters.
- Screenshot files live in a per-process temp directory and are deleted right after encoding. Webcam frames are never written to disk.
- Canvas titles and task-file lines are fenced and labeled as untrusted data; both the app and the service tell the model never to follow instructions found there or on the screen.
- The verdict is coerced: anything not exactly `off_task: true` is on task, and confidence outside the allowed set becomes `low`.
- Two consecutive high-confidence off-task verdicts are required before the screen reacts. An error, a refusal, an HTTP failure, or any billing state that is not "you may check" resets the count to zero, and two consecutive failed checks clear an existing alert. Nothing about money can gray your screen.
- A watchdog restores color after 20 minutes regardless of state; color is also restored on every launch, on quit, on crash, on SIGINT and SIGTERM, on system shutdown, and from an always-enabled menu item.
- A daily cap (1,200 checks), change-gating, and exponential backoff on rate limits and outages bound both the request rate and, when self-hosting, the spend from a runaway loop.
- Renderer windows run with `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict Content Security Policy, and no remote content. Pages reach the main process only through the preload bridges in `ui/preload/`. Links opened from the app are limited to an allowlist of hosts, which now includes the Stripe checkout and billing-portal hosts.
- No Automation, Accessibility, or Full Disk Access permission is ever requested. Frontmost-app detection uses `lsappinfo`.
- The menu-bar tooltip shows status only, never the activity phrase, so a glance at the menu bar reveals nothing about what was on screen.

### Mitigations in the service

- **The shared model key lives only in the Worker secret store.** It is never sent to a client, never returned in a response, never written to a log, and is not in this repository. A client cannot make the service call anything but the model, with the service's own prompt, on the pixels it sent.
- **The app never holds a model key.** The worst a stolen license key gets an attacker is somebody else's check allowance, which is capped and revocable.
- License keys are compared in constant time and are never logged. Revoking one is a single write, and the next check fails closed.
- **Images are never stored, never logged, and never written to disk by the service.** They exist for the length of one request. Neither are the work description, task titles, or the returned activity phrase. What persists is the license record, the device record, a monthly counter, and a Stripe customer mapping.
- All traffic is HTTPS, so the images are in transit under TLS between your Mac and the service, and between the service and OpenAI. There is no plaintext fallback and no configurable way to turn it off. Pointing `apiBase` at a non-HTTPS host is a self-hosting decision and is yours to make safely.
- **Stripe webhooks are verified before anything is believed**: signature checked with Stripe's own `constructEventAsync` against the signing secret held in the Worker secrets, on the raw body. An unverified or replayed event changes nothing. Unknown event types return 200 and are ignored rather than guessed at.
- Billing state comes only from verified webhooks, never from the client. The app reports nothing about its own plan that the service trusts.
- Rate limits: 40 checks per minute per device and 1,200 per hour per license, with a request body cap of 8 MB. These bound both a leaked key and a client bug.
- The free taste is bound to a device record with a counter the client cannot decrement. It is a taste, not a security boundary: someone determined to reinstall repeatedly can get more free checks, and that is an accepted cost rather than a reason to fingerprint machines.
- Every response carries `X-Grayout-Request-Id`, which is what a bug report needs instead of a screenshot.

### Residual risks, disclosed

- The verdict log (`verdicts.jsonl`) is a plaintext list of timestamps, category phrases (for example "social media feed"), and frontmost app names, kept for 30 days on your Mac. Anyone who can read your files can read it. Delete it from Settings, shorten `historyDays`, or set `logVerdicts` to `false`.
- Malware running as your user can read the same files you can, including the encrypted `secrets.bin`, and can prompt the Keychain the same way the app does. Grayout does not defend against a compromised user account.
- The never-capture list applies to the frontmost app only. Other windows on the same display are in the capture.
- Your screenshots pass through the Grayout service and reach OpenAI. We do not store or log them; OpenAI's handling is governed by its own policy, linked from `PRIVACY.md`. If that arrangement is not acceptable, self-host: `provider` set to `anthropic` or `openai` removes the service from the path completely.
- Cloudflare operates the service and sees connection metadata, as any host does.
- A license key is a bearer credential. Anyone who has it can spend your allowance from any machine until you ask for it to be rotated. It is not a password and it protects no data of yours.
- Two short-lived values are bearer credentials of the same kind, and both are handed to the browser on purpose: the device code the app makes before it opens checkout (15 minutes), and the Stripe Checkout Session id in the `success.html` URL. Either one can be exchanged once for the license that purchase bought, and for nothing else. Both are rate limited; neither identifies you and neither can read a license it did not pay for.
- The service is a single Worker and a single KV namespace with one maintainer. An outage stops checks; it never grays a screen.
- The app is ad-hoc signed and not notarized. Verify downloads against `SHA256SUMS.txt` on the release page, or build from source.
- The grayscale flag is global system state. If the helper cannot run, the escape hatches in the README restore color by hand.

### Out of scope

- Bypassing Grayout. It is not a lock. Quit is one click in the menu bar by design, and reports that a user can turn it off are not vulnerabilities.
- Getting free checks by reinstalling. The free taste is a taste; see above.
- Self-hosted deployments of `server/`. Your Worker, your secrets, your configuration.
- Monitoring other people. There is no remote view and there will not be one.
