# Stranger test

Run this on a fresh macOS user account before tagging a release. The goal: someone who has never seen Grayout goes from the landing page to a first verdict in under 10 minutes with zero questions, and from "free checks used up" to a working subscription in under two. Every stumble gets fixed before the tag, not documented around.

Version 2 changed what this test is about. There is no API key to paste any more, so the first run is shorter and the money is new. The two things being tested are: does an unpaid stranger reach a first verdict without help, and does a stranger who decides to pay get back to watching without touching a license key.

Print this page or keep it on a second device. Fill in the timing boxes as you go. The tester should have only the landing page URL and a payment card, and nothing else; the observer does not help.

## Before the test (owner, on the main account)

```bash
npm test && npm run check
npm --prefix server test
npm run dist
bash scripts/verify-dmg.sh dist/Grayout-arm64.dmg
npm run smoke:api
```

- [ ] `verify-dmg.sh` passes: `codesign --verify --deep --strict` clean, designated requirement contains `identifier "com.aarushkandukoori.grayout"`, helper is universal, the DMG mounts with an Applications link.
- [ ] `smoke:api` prints a verdict against the deployed service. This is the only production test of the check path; do not skip it.
- [ ] The service the DMG points at is deployed and healthy, and `apiBase` in the build is the one you mean. A build pointing at a workers.dev URL is fine for a rehearsal and wrong for a release.
- [ ] Stripe is in the mode you intend. **Rehearse in test mode with a test card, then do one live run with a real card and refund it.** A release goes out only after a real live charge has been made and refunded end to end.
- [ ] The two prices exist and read correctly on Stripe's checkout page: $9.99 a month with a 7-day trial, $79 a year. The product name on the page says Grayout, not a Stripe id.
- [ ] The webhook endpoint is live, subscribed to `checkout.session.completed`, `customer.subscription.created|updated|deleted`, and `invoice.payment_failed`, and its recent deliveries are all 200.
- [ ] The DMG the tester will download is the one CI built from the tag candidate, published as a draft or pre-release so the `releases/latest/download/` URL resolves. If testing a local build, upload it to a draft release rather than copying the file over, because the whole point is the quarantine flag Safari sets.
- [ ] `docs/index.html` and `docs/install.html` are live at the URL you will hand over, and the price on the site matches the price on Stripe's page. A mismatch here is the worst possible bug to ship.

## Fresh account

- [ ] System Settings > Users & Groups > Add User. Standard account, name it `stranger`, new password. Do not sign in to iCloud on it.
- [ ] Log in to that account. Do not open Terminal. Do not copy anything from the main account.
- [ ] Open Safari, and only Safari. Confirm `~/Library/Application Support/Grayout/` does not exist, so the free taste is genuinely fresh.
- [ ] Have a card ready for step 13. In test mode, Stripe's test card. In the live run, a real card, refunded afterwards.

## The run

Start the clock when the tester opens the landing page. Stop it at the first verdict in the menu bar. Record the wall-clock time at each box; compute elapsed at the end.

| Step | What the tester must do, unprompted | Start | End | Stumble (what, and what they said) |
|---|---|---|---|---|
| 1 | Open the landing page, understand what it costs, pick the right download (Apple Silicon or Intel) | __:__ | __:__ | |
| 2 | Open the DMG, drag Grayout to Applications, eject | __:__ | __:__ | |
| 3 | Double-click Grayout in Applications, see "Apple could not verify", click Done | __:__ | __:__ | |
| 4 | System Settings > Privacy & Security > Open Anyway, password or Touch ID, Open Anyway again | __:__ | __:__ | |
| 5 | Onboarding screen 1 reads, Continue (no Move to Applications bar should appear) | __:__ | __:__ | |
| 6 | Screen 2: Open System Settings, turn on Grayout under Screen Recording, come back, pill turns green | __:__ | __:__ | |
| 7 | Relaunch Grayout; app reopens on the next screen without going through 1 and 2 again | __:__ | __:__ | |
| 8 | Setup screen: leave defaults or type a work description, Continue | __:__ | __:__ | |
| 9 | Preview the gray (screen goes gray for 3 seconds and comes back), then **Start free** | __:__ | __:__ | |
| 10 | Menu bar flips from "starting" to "watching" with a "last check:" line | __:__ | __:__ | |

Total elapsed to first verdict: ______ minutes (target: under 10).

| Step | The paid half | Start | End | Stumble |
|---|---|---|---|---|
| 11 | Work and slack normally until the free checks run out (see the shortcut below). The tester notices on their own that checks stopped, without the screen doing anything alarming | __:__ | __:__ | |
| 12 | The tester finds the way to subscribe without being told where it is | __:__ | __:__ | |
| 13 | Stripe's checkout opens in the browser, the tester pays, and comes back to the app | __:__ | __:__ | |
| 14 | The app unlocks itself within a few seconds, with no license key ever shown to the tester, and goes back to watching | __:__ | __:__ | |

Elapsed from "out of checks" to "watching again": ______ minutes (target: under 2).
Questions the tester asked: ______ (target: zero).
Times the observer had to intervene: ______ (target: zero).

**Burning 100 checks in reasonable time.** At the 45-second default with change-gating on, the free taste lasts most of a working day, which is the point of it and useless for a test. Before step 11, have the tester open Settings and pick the 30-second interval, and set `changeGating` to `false` in `config.json` from the main account. 100 checks then take about 50 minutes of a genuinely varied screen. Do not fake the counter: the boundary condition is what is being tested.

Checks the observer makes during the run, without speaking:

- [ ] The landing page told the tester the price before they downloaded. Ask afterwards what they expected to pay; a wrong answer is a landing-page bug.
- [ ] The download actually carries quarantine. On the main account, later, this shows `com.apple.quarantine`:

  ```bash
  xattr -l /Users/stranger/Downloads/Grayout-arm64.dmg
  ```

- [ ] The first-launch dialog says "Apple could not verify", not "damaged and can't be opened". Damaged means the signature is broken; stop the test and fix the build.
- [ ] The Open Anyway button is present in Privacy & Security. If it is missing, note how long after the blocked attempt the tester looked.
- [ ] The Gatekeeper wording on install.html matches what appeared on screen, word for word.
- [ ] Screen 2's status pill updates on its own within a few seconds of the toggle, without the tester clicking Recheck.
- [ ] After the relaunch, the loop is still paused (tray says setup) until Start free.
- [ ] Onboarding never asks for a key, an email address, or a password, and never shows a license key.
- [ ] The first verdict arrives within about 10 seconds of Start free, not after a full interval.
- [ ] The app shows how many free checks are left somewhere the tester can find, and the number goes down.
- [ ] When the free checks run out, the menu bar says so in plain words, the screen does **not** go gray, and any existing gray clears. Note what the tester says out loud at that moment.
- [ ] Stripe's checkout page names Grayout, shows $9.99 a month and the 7-day trial, and does not ask for anything beyond payment.
- [ ] The tester never sees, copies, or types a license key at any point.
- [ ] After paying, the app unlocks without a relaunch. Time it: over 15 seconds feels broken even when it is working.
- [ ] The Keychain prompt names "Grayout Safe Storage" and the tester chose Always Allow, not Allow. Note if the prompt came back later.

## Packaged-app gates (owner, same account, after the run)

| Gate | How | Pass | Notes |
|---|---|---|---|
| Trigger | Open a social feed in Safari, full screen, and wait. Two consecutive high-confidence flags at the configured interval turn every display gray with a red border. Time from the second flag to gray: ______ s | [ ] | |
| Recovery by working | Switch to a document or code editor; the next verdict restores color. Time: ______ s | [ ] | |
| I'm working | Trigger again, click I'm working in the menu bar. Color returns at once; nothing fires for 10 minutes even on a feed; the dashboard row shows "disputed" | [ ] | |
| Restore color now | Trigger again, click Restore color now while gray, then while paused, then with Screen Recording turned off (blocked). Enabled and working in all three | [ ] | |
| Force kill | Trigger, then from the main account or Activity Monitor force quit Grayout (`kill -9` on the pid). The screen stays gray. Relaunch Grayout: color restored before the tray appears. Time: ______ s | [ ] | |
| Terminal one-liner | Trigger, then run the command below in Terminal on this account. Color restored | [ ] | |
| Color Filters fallback | Trigger, then System Settings > Accessibility > Display > Color Filters on, then off. Color restored | [ ] | |
| Watchdog | Set `maxAlertMinutes` to 1 in config.json (hot reload), trigger, wait. Color restored after about a minute with a generic notification that names no activity. Restore the value afterward | [ ] | |
| Pause and Quit | Trigger, then Pause: color restored. Trigger, then Quit: color restored | [ ] | |
| Change-gating | With `changeGating` back on, leave one still screen in front for five minutes. Checks are skipped, the app still reports a state, and a real check runs at least every `forceCheckSec` | [ ] | |
| Gating cannot hide slacking | Open a feed and leave it still. `forceCheckSec` forces a real check and the flag still lands | [ ] | |
| Service down fails closed | Trigger the gray, then break the connection (turn off Wi-Fi, or point `apiBase` at an unreachable host). Color comes back, no new alert fires, the menu bar says why, and nothing is gray when the connection returns | [ ] | |
| License survives a relaunch | Quit and reopen. No checkout, no re-entry, watching within seconds | [ ] | |
| License survives an update | Install a second build (bump the version, `npm run dist`) by dragging over the first. Relaunch. Still subscribed, Screen Recording still granted without a new prompt, captures not blank, Keychain not prompted again | [ ] | |
| Cancel | Settings > Manage subscription opens Stripe's portal; cancel there. The app keeps watching until the period ends and says so. Nothing goes gray because of it | [ ] | |
| Refund | Refund the live charge in Stripe. The webhook arrives, the license state follows, and the app reports it in plain words | [ ] | |
| Paste a license | On a second Mac or a wiped data folder, paste the license key in Settings. It activates without a second charge | [ ] | |
| Video-call allowlist | Open FaceTime in front while gray: the alert clears and the check is skipped | [ ] | |
| Never capture | Open Passwords in front: tray reads "not watching: Passwords", no check runs | [ ] | |
| Webcam in the packaged build | Turn the camera on in Settings, allow it, run Check now. The check succeeds and the app log shows no camera error. This is the electron-builder #9529 check | [ ] | |
| Lock screen | Lock the screen for a minute, unlock. Tray reads "just woke" for 45 s, then resumes | [ ] | |
| Stale grant fix | If the update gate shows blank captures: Permissions > Copy the fix command, run it, re-grant, relaunch. Captures work | [ ] | |
| Dashboard | Open dashboard: checks used against the allowance is right, flags table has Wrong call? buttons; Settings saves and hot-reloads without a relaunch | [ ] | |
| Logs | `logs/grayout.log` contains no prompt text, no base64, no `gry_live_`, no `sk-ant-`, no `sk-proj-`. `verdicts.jsonl` rows carry no license key and no screen content | [ ] | |
| Files | `ls -la ~/Library/Application\ Support/Grayout/` shows 0600 files in a 0700 directory. No `grayout-frames-*` directory survives in `$TMPDIR` after quit | [ ] | |

Check the log for secrets directly:

```bash
grep -riE 'gry_live_|sk-ant-|sk-proj-' ~/Library/Application\ Support/Grayout/logs/ ~/Library/Application\ Support/Grayout/verdicts.jsonl
```

That command must print nothing. A hit is a release blocker, not a bug report.

The Terminal one-liner for a stuck gray screen:

```bash
"/Applications/Grayout.app/Contents/Resources/helper/grayscale" off
```

The stale-grant fix:

```bash
tccutil reset ScreenCapture com.aarushkandukoori.grayout
```

## Self-hosting gate (owner, once per release)

Self-hosting is a documented promise, so it gets tested like one.

- [ ] Follow the README's Self-hosting section exactly, from a clean clone, without reading any other file.
- [ ] With `provider` set to `openai` or `anthropic`, checks run on the personal key, and a network monitor shows **no connection to `api.grayout.app` at all** — not for a license check, not for anything.
- [ ] Removing the license from that install changes nothing; it never needed one.
- [ ] Setting `provider` back to `grayout` returns to the subscription path.

## After the test

- [ ] Refund the live charge and cancel the test subscription. Confirm the refund landed in Stripe and the license state followed.
- [ ] Revoke or delete any test license issued to the `stranger` account.
- [ ] Every stumble above has an issue or a fix committed. Re-run the affected steps on a new fresh account (delete `stranger`, create it again) if the fix touched install, onboarding, permissions, or the subscribe flow.
- [ ] Copy the totals into the release PR description: elapsed minutes to first verdict, elapsed minutes from out-of-checks to watching again, questions asked, interventions, and which gates failed on the first pass.
- [ ] Delete the `stranger` account when the release is tagged, or keep it for the next run and clear its state so the free taste is fresh again:

```bash
tccutil reset ScreenCapture com.aarushkandukoori.grayout
tccutil reset Camera com.aarushkandukoori.grayout
rm -rf ~/Library/Application\ Support/Grayout
```
