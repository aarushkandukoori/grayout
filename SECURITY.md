# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: https://github.com/aarushkandukoori/grayout/security/advisories/new. It reaches the maintainer without creating a public issue. An email address for reports will be added here once a support address exists.

Please include the Grayout version (About Grayout in the menu bar), your macOS version, and steps to reproduce. Do not include screenshots of your own screen, your API key, or the contents of `secrets.bin`.

You can expect an acknowledgement within a few days. Fixes ship as a patch release with a note in `CHANGELOG.md`; credit is given if you want it.

## Supported versions

Only the latest release is supported. Update by downloading the current DMG.

## Threat model

Grayout runs as your user, captures your screen, and sends the captures to Anthropic or OpenAI, whichever your key belongs to, under your key. The model below is what the design defends against and what it does not.

### Assets

- The contents of your screen, at each check.
- Your Anthropic or OpenAI API key (and Canvas token, if configured).
- Webcam frames, if the camera is on.
- Control of the display: the ability to put your Mac in grayscale.

### Adversaries considered

- **A curious housemate** with physical access to your unlocked Mac, or a glance at the menu bar.
- **Malware running as the same user**, which can read anything your user can read.
- **A malicious web page, Canvas assignment, or task-file line** that tries to steer the verdict through text the model sees.
- **A provider outage, rate limit, or a broken response**, from Anthropic or OpenAI, which must not leave your screen gray or drain your balance.

### Mitigations

- Every file in `~/Library/Application Support/Grayout/` is created with mode 0600 inside a 0700 directory.
- The API key is encrypted with Electron `safeStorage`, backed by a macOS Keychain item, with no plaintext fallback. It is never written to `config.json`, the verdict log, or the app log; the logger redacts anything matching `sk-ant-…`.
- Screenshot files live in a per-process temp directory and are deleted right after encoding. Webcam frames are never written to disk.
- Canvas titles and task-file lines are fenced in the prompt and labeled as untrusted data; the prompt tells the model never to follow instructions found there or on the screen.
- The verdict is coerced: anything not exactly `off_task: true` is on task, and confidence outside the allowed set becomes `low`.
- Two consecutive high-confidence off-task verdicts are required before the screen reacts. An error or refusal resets the count to zero, and two consecutive failed checks clear an existing alert.
- A watchdog restores color after 20 minutes regardless of state; color is also restored on every launch, on quit, on crash, on SIGINT and SIGTERM, on system shutdown, and from an always-enabled menu item.
- A daily cap (1,200 checks) and exponential backoff on rate limits and outages bound the spend from a runaway loop.
- Renderer windows run with `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict Content Security Policy, and no remote content. Links opened from the app are limited to an allowlist of hosts.
- No Automation, Accessibility, or Full Disk Access permission is ever requested. Frontmost-app detection uses `lsappinfo`.
- The menu-bar tooltip shows status only, never the activity phrase, so a glance at the menu bar reveals nothing about what was on screen.

### Residual risks, disclosed

- The verdict log (`verdicts.jsonl`) is a plaintext list of timestamps, category phrases (for example "social media feed"), and frontmost app names, kept for 30 days. Anyone who can read your files can read it. Delete it from Settings, shorten `historyDays`, or set `logVerdicts` to `false`.
- Malware running as your user can read the same files you can, including the encrypted `secrets.bin`, and can prompt the Keychain the same way the app does. Grayout does not defend against a compromised user account.
- The never-capture list applies to the frontmost app only. Other windows on the same display are in the capture.
- Screenshots are sent to Anthropic or OpenAI, whichever your key belongs to. Their handling is governed by that provider's terms, not by this project.
- The app is ad-hoc signed and not notarized. Verify downloads against `SHA256SUMS.txt` on the release page, or build from source.
- The grayscale flag is global system state. If the helper cannot run, the escape hatches in the README restore color by hand.

### Out of scope

- Bypassing Grayout. It is not a lock. Quit is one click in the menu bar by design, and reports that a user can turn it off are not vulnerabilities.
- Monitoring other people. There is no remote view and there will not be one.
