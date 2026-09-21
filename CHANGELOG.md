# Changelog

All notable changes to Grayout are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/aarushkandukoori/grayout/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aarushkandukoori/grayout/releases/tag/v1.0.0
