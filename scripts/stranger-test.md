# Stranger test

Run this on a fresh macOS user account before tagging a release. The goal: someone who has never seen Grayout goes from the landing page to a first verdict in under 10 minutes with zero questions. Every stumble gets fixed before the tag, not documented around.

Print this page or keep it on a second device. Fill in the timing boxes as you go. The tester should have only the landing page URL and nothing else; the observer does not help.

## Before the test (owner, on the main account)

```bash
npm test && npm run check
npm run dist
bash scripts/verify-dmg.sh dist/Grayout-arm64.dmg
ANTHROPIC_API_KEY=sk-ant-... npm run smoke:api
```

- [ ] `verify-dmg.sh` passes: `codesign --verify --deep --strict` clean, designated requirement contains `identifier "com.aarushkandukoori.grayout"`, helper is universal, the DMG mounts with an Applications link.
- [ ] `smoke:api` prints a verdict, usage, and a cost. This is the only production test of the API path; do not skip it.
- [ ] The DMG the tester will download is the one CI built from the tag candidate, published as a draft or pre-release so the `releases/latest/download/` URL resolves. If testing a local build, upload it to a draft release rather than copying the file over, because the whole point is the quarantine flag Safari sets.
- [ ] `docs/index.html` and `docs/install.html` are live at the URL you will hand over.

## Fresh account

- [ ] System Settings > Users & Groups > Add User. Standard account, name it `stranger`, new password. Do not sign in to iCloud on it.
- [ ] Log in to that account. Do not open Terminal. Do not copy anything from the main account.
- [ ] Open Safari, and only Safari. Confirm there is no Anthropic or OpenAI key anywhere on this account and that `~/Library/Application Support/Grayout/` does not exist.
- [ ] The tester needs an Anthropic or OpenAI account with credit. Either they bring their own, or hand them a key on paper created in a dedicated Anthropic workspace or OpenAI project with a $5 spend limit, and revoke it afterward. Note which provider and which.

## The run

Start the clock when the tester opens the landing page. Stop it at the first verdict in the menu bar. Record the wall-clock time at each box; compute elapsed at the end.

| Step | What the tester must do, unprompted | Start | End | Stumble (what, and what they said) |
|---|---|---|---|---|
| 1 | Open the landing page, pick the right download (Apple Silicon or Intel) | __:__ | __:__ | |
| 2 | Open the DMG, drag Grayout to Applications, eject | __:__ | __:__ | |
| 3 | Double-click Grayout in Applications, see "Apple could not verify", click Done | __:__ | __:__ | |
| 4 | System Settings > Privacy & Security > Open Anyway, password or Touch ID, Open Anyway again | __:__ | __:__ | |
| 5 | Onboarding screen 1 reads, Continue (no Move to Applications bar should appear) | __:__ | __:__ | |
| 6 | Screen 2: Open System Settings, turn on Grayout under Screen Recording, come back, pill turns green | __:__ | __:__ | |
| 7 | Relaunch Grayout; app reopens on screen 3 without going through 1 and 2 again | __:__ | __:__ | |
| 8 | Screen 3: paste key, Test key, see "Key works" naming the provider and model with a cost, Save and continue, Always Allow on the Keychain prompt | __:__ | __:__ | |
| 9 | Screen 4: leave defaults or type a work description, Continue | __:__ | __:__ | |
| 10 | Screen 5: Preview the gray (screen goes gray for 3 seconds and comes back), Start watching | __:__ | __:__ | |
| 11 | Menu bar flips from "starting" to "watching" with a "last check:" line | __:__ | __:__ | |

Total elapsed: ______ minutes (target: under 10).
Questions the tester asked: ______ (target: zero).
Times the observer had to intervene: ______ (target: zero).

Checks the observer makes during the run, without speaking:

- [ ] The download actually carries quarantine. On the main account, later, this shows `com.apple.quarantine`:

  ```bash
  xattr -l /Users/stranger/Downloads/Grayout-arm64.dmg
  ```

- [ ] The first-launch dialog says "Apple could not verify", not "damaged and can't be opened". Damaged means the signature is broken; stop the test and fix the build.
- [ ] The Open Anyway button is present in Privacy & Security. If it is missing, note how long after the blocked attempt the tester looked.
- [ ] The Gatekeeper wording on install.html matches what appeared on screen, word for word.
- [ ] Screen 2's status pill updates on its own within a few seconds of the toggle, without the tester clicking Recheck.
- [ ] After the relaunch, the loop is still paused (tray says setup) until Start watching.
- [ ] The Keychain prompt names "Grayout Safe Storage" and the tester chose Always Allow, not Allow. Note if the prompt came back later.
- [ ] Test key's success line names the provider and model, shows a real cost (about $0.0025 with Anthropic, about $0.0007 with OpenAI) and a category phrase.
- [ ] Screen 4's interval prices match the provider of the key just saved (about $0.90 a day at 45 s for Anthropic, about $0.26 for OpenAI), and the line under them names that provider and model.
- [ ] The first verdict arrives within about 10 seconds of Start watching, not after a full interval.

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
| Video-call allowlist | Open FaceTime in front while gray: the alert clears and the check is skipped | [ ] | |
| Never capture | Open Passwords in front: tray reads "not watching: Passwords", no check runs | [ ] | |
| Webcam in the packaged build | Turn the camera on in Settings, allow it, run Check now. `verdicts.jsonl` shows a higher `input_tokens` (about 414 more) and the app log shows no camera error. This is the electron-builder #9529 check | [ ] | |
| Lock screen | Lock the screen for a minute, unlock. Tray reads "just woke" for 45 s, then resumes | [ ] | |
| Update over the top | Install a second build (bump the version, `npm run dist`) by dragging over the first. Relaunch. Screen Recording still granted without a new prompt, captures not blank, Keychain not prompted again. This verifies the identifier-based designated requirement, which is inferred, not proven | [ ] | |
| Stale grant fix | If the update gate shows blank captures: Permissions > Copy the fix command, run it, re-grant, relaunch. Captures work | [ ] | |
| Dashboard | Open dashboard: cost line shows spend today and a monthly projection; flags table has Wrong call? buttons; Settings saves and hot-reloads without a relaunch | [ ] | |
| Logs | `~/Library/Application Support/Grayout/logs/grayout.log` contains no prompt text, no base64, no `sk-ant-` and no `sk-proj-`. `verdicts.jsonl` rows carry `usage`, `cost` and `model` and never the key | [ ] | |
| Files | `ls -la ~/Library/Application\ Support/Grayout/` shows 0600 files in a 0700 directory. No `grayout-frames-*` directory survives in `$TMPDIR` after quit | [ ] | |

The Terminal one-liner:

```bash
"/Applications/Grayout.app/Contents/Resources/helper/grayscale" off
```

The stale-grant fix:

```bash
tccutil reset ScreenCapture com.aarushkandukoori.grayout
```

## After the test

- [ ] Revoke the test key at console.anthropic.com or platform.openai.com if you handed one over.
- [ ] Every stumble above has an issue or a fix committed. Re-run the affected steps on a new fresh account (delete `stranger`, create it again) if the fix touched install, onboarding, or permissions.
- [ ] Copy the totals into the release PR description: elapsed minutes, questions asked, interventions, and which gates failed on the first pass.
- [ ] Delete the `stranger` account when the release is tagged, or keep it for the next run and clear `~/Library/Application Support/Grayout/` plus the Screen Recording and Camera grants on it:

```bash
tccutil reset ScreenCapture com.aarushkandukoori.grayout
tccutil reset Camera com.aarushkandukoori.grayout
rm -rf ~/Library/Application\ Support/Grayout
```
