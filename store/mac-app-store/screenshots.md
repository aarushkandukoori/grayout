# Mac App Store screenshots

Apple's spec: Mac screenshots are required, 1 to 10 per size, 16:10, one of 1280x800, 1440x900, 2560x1600 or 2880x1800, as `.png`, `.jpg` or `.jpeg`, with no alpha channel or transparency.

## The rules

1. **Never capture Aarush's real screen.** Make a separate macOS user called **Demo** and take every shot there: default wallpaper, Do Not Disturb on, only Apple apps in the Dock, no personal menu bar items, no real names, email addresses, messages, files or browser history (guideline 2.3.9: fictional data only).
2. **No prices anywhere in the screenshots or captions** (guideline 2.3.7). Skip the plan screen, because it shows $9.99.
3. **Show the real app doing the real thing** (guideline 2.3.3). Never paint the gray or the red border in with an image editor.
4. **No real brands or copyrighted content on screen** (guidelines 5.2.1 and 2.3.9). For "leisure", use a locally hosted mock video feed with generic thumbnails, never YouTube, TikTok, Instagram or a real game. For "work", use a sample code project and a sample document written for the shots.
5. Synthetic history only: for the dashboard shot, write a made-up `verdicts.jsonl` into the Demo user's Grayout folder (`~/Library/Containers/com.aarushkandukoori.grayout/Data/Library/Application Support/Grayout/` for the store build).
6. Use the Mac App Store build (or a TestFlight build) running in the Demo user, so the shots show what a buyer gets.

## Capturing

- Use 2880x1800. On a Retina Mac, `screencapture -x -R0,0,1440,900 shot.png` makes a 2880x1800 file.
- Flatten to RGB before uploading, for example `sips -s format jpeg shot.png --out shot.jpg`.
- **What a capture can see.** The red border window uses `setContentProtection(true)`, so it never appears in a screenshot. The overlay helper's gray windows appear in captures by default and are hidden only when the helper runs with `--hide-from-capture`. Take one test capture of the gray state before staging the rest. If the border or the gray is missing, the gray-state shots need a development-only screenshot mode that leaves both capturable and forces the alert state (in the spirit of `scripts/dev-shots.js`). That mode must never ship in the store binary (guideline 2.3.1), and nothing may be faked afterwards.

## Shot list (6)

Captions are optional overlays (allowed by 2.3.3). Keep them short and price-free.

| # | Shows | Caption |
|---|---|---|
| 1 | The mock video feed full screen, gray with the red border, menu bar icon in its alert state | Drift off task and your Mac goes gray |
| 2 | Sample code editor and document in color, the Grayout menu open: status line, I'm working, Pause submenu, Check now | Pause, I'm working, or Quit, one click away |
| 3 | Dashboard "The day": on-task percentage, the check strip, "Everything it flagged" with the synthetic history | See your day. History stays on your Mac |
| 4 | The consent screen that names OpenAI and lists what is sent, with Allow and continue | Asks before any screenshot leaves your Mac |
| 5 | Settings: check interval, the never-trigger and never-capture lists, the camera switch off, Send screenshots for checks | Video calls never trigger it |
| 6 | Onboarding "See what it does", just after Preview the gray, over a staged desktop | See exactly what it does before you start |

An app preview video is optional; skip it at launch.
