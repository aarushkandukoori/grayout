# Grayout privacy policy

Last updated 2026-09-21. This is the same text as the privacy page on the site. It applies to Grayout for Mac 1.0.0.

## What Grayout collects about you

Nothing. There is no server, no account, no sign-in, and no analytics. The author has no way to know that you installed Grayout, how often it runs, or what it saw. Everything below is about what the app on your Mac does on your behalf.

## What the app sends, and to whom

| What | To | When | Kept where |
|---|---|---|---|
| A screenshot of each display, resized to 1366 px wide and compressed as a JPEG | `api.anthropic.com` or `api.openai.com`, whichever your key belongs to, under your own API key | At each check (every 45 seconds by default, only while you are active and the app is not paused) | Deleted from this Mac within seconds of being sent. The provider's handling is governed by its terms (below). |
| One webcam frame, 640 by 480 | The same API, under your key | At each check, only if you turned the camera on | Never written to disk on this Mac |
| Your one-line work description | The same API, under your key | At each check, if you wrote one | In `config.json` on this Mac |
| Titles of your Canvas to-do items, or the unchecked lines of your task file | The same API, under your key | At each check, only if you configured one of them | Canvas titles are cached in memory for 10 minutes; nothing is written to disk |
| A request for the latest release number | `api.github.com` | Once a day, plus when you click Check for updates | Nothing identifying is sent; the request carries only the app's version string. Turn it off in Settings. |
| Your Canvas API token, in a request for your to-do list | Your Canvas host (`canvas.baseUrl`) | Every 10 minutes, only if you configured Canvas | Encrypted in the macOS Keychain |

The prompt sent with each check is public: see `src/analyzer.js` in the repository. It asks for a three-field answer, `off_task`, `activity`, and `confidence`, and instructs the model to name only the category of what it sees (for example "code editor and terminal"), never on-screen text, names, message contents, URLs, or personal details.

## What is stored on your Mac, and for how long

All of it is in `~/Library/Application Support/Grayout/`, readable only by your user account.

- `config.json`: your settings, including the work description. Kept until you delete it.
- `secrets.bin`: your Anthropic or OpenAI API key and, if configured, your Canvas token, encrypted with Electron's `safeStorage`. The encryption key lives in your macOS Keychain under the item "Grayout Safe Storage". There is no plaintext fallback; if the Keychain is unavailable, the key can only be held in memory for the session.
- `verdicts.jsonl`: one line per check with a timestamp, the verdict, the category phrase the model returned, the name of the frontmost app, the number of displays, token counts, and the estimated cost. No screenshots, no on-screen text. Kept for 30 days (`historyDays`) and deletable at any time from Settings > Delete all history.
- `state.json`: onboarding progress, the daily check counter, and update-check bookkeeping.
- `logs/grayout.log`: a rotating app log (1 MB, three files) of short status lines. It never contains prompt text, images, task titles, the work description, or your key; anything that looks like a key is redacted before it is written.

Screenshot files are written to a temporary folder named `grayout-frames-<pid>` under your user's temp directory and deleted immediately after they are encoded. The folder is removed on exit, and leftovers from a force-killed instance are removed at the next launch.

## The complete list of outbound connections

1. `https://api.anthropic.com` at each check, under your key, when your key is an Anthropic key.
2. `https://api.openai.com` at each check, under your key, only when your key is an OpenAI key. Every request is sent with `store: false`, so responses are not saved to your OpenAI account's stored responses. Only one of these two hosts is ever contacted, the one your key belongs to.
3. `https://api.github.com` once a day for the release check, if `checkForUpdates` is on.
4. Your Canvas host, only if you configured `canvas.baseUrl` and a token.
5. Pages you open yourself by clicking a link in the app. Links are limited to `github.com`, `console.anthropic.com`, `aarushkandukoori.github.io`, `docs.anthropic.com`, `platform.claude.com`, `anthropic.com`, `platform.openai.com`, `openai.com`, and `developers.openai.com`, and open in your browser.

There is nothing else. No crash reporting, no usage statistics, no fonts or scripts fetched at runtime.

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
- **Quit** stops everything and restores color. A quit app captures nothing.
- **Revoke the key** at console.anthropic.com or platform.openai.com; a revoked key makes every check fail closed (on task).
- **Uninstall**: quit, drag to the Trash, delete `~/Library/Application Support/Grayout`, turn off the login item.

## Unsigned app status

Grayout is signed ad hoc and is not notarized by Apple, so the first launch shows the "Apple could not verify" dialog. The build is reproducible from the public source: every release is built by GitHub Actions from a tagged commit, and the release page carries SHA-256 checksums you can compare against your download. Notarization is the first item on the roadmap.

## Not for monitoring other people

Grayout is built for one person watching their own screen. It has no remote view, no shared dashboard, no export to anyone else, and it never will. Do not install it on a machine you do not own or on someone else's account.

## How Anthropic and OpenAI handle API inputs

Screenshots go to your provider's API under your key, so that provider's own terms govern what happens to them. Read them directly rather than relying on this page:

- Anthropic: https://www.anthropic.com/legal/commercial-terms and https://www.anthropic.com/legal/privacy
- OpenAI: https://openai.com/policies/api-data-usage-policies

Grayout sends every OpenAI request with `store: false`, which asks OpenAI not to keep the response in your account's stored responses; see their policy for what that does and does not cover. Nothing here is a guarantee about either provider's practices.

## Changes to this policy

Changes are recorded in the repository's history and summarized in `CHANGELOG.md`. A change that sends anything new off your Mac will be called out in the release notes.

## Contact

Open an issue at https://github.com/aarushkandukoori/grayout/issues. For a security problem, use the private reporting path in `SECURITY.md`. A support email address will be listed here once one exists.
