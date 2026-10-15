# Mac App Store listing: Grayout: Back to Work

Paste-ready App Store Connect copy for the Mac App Store edition. Nothing here is live: the app is not on the App Store yet. Every block marked `field` is checked against Apple's length limits by `node store/mac-app-store/check-lengths.js` (also run by `npm test`). Keep the copy free of em and en dashes.

Facts behind the copy: check intervals `ui/onboarding.html`, strikes and idle pause `src/config.js`, prices `src/pricing.js` and `server/src/config.js`. If any of those change, change this file too.

## App information

### Name (30 characters at most)

"Grayout" alone is taken on the App Store (a 2015 iOS game by Mrgan LLC). The bundle display name inside the app stays "Grayout". Before launch, Aarush searches tmsearch.uspto.gov for GRAYOUT.

<!-- field: name, max: 30, unit: chars -->
```text
Grayout: Back to Work
```

Alternatives if it is refused: "Grayout - Stay On Task" (22). Avoid "Grayout: Focus Guard": several existing apps use "Focus Guard".

### Subtitle (30 characters at most)

<!-- field: subtitle, max: 30, unit: chars -->
```text
Your Mac goes gray off task
```

### Other fields

| Field | Answer |
|---|---|
| Bundle ID | `com.aarushkandukoori.grayout` |
| SKU | `GRAYOUT-MAC-001` |
| Primary language | English (U.S.) |
| Primary category | Productivity (matches `LSApplicationCategoryType` `public.app-category.productivity`) |
| Secondary category | Utilities. Not Education, so the listing does not pull in children. |
| Content Rights | Yes, it contains, shows or accesses third-party content, and I have the necessary rights (it calls OpenAI's API under OpenAI's terms) |
| License Agreement | Apple's standard EULA. Subscription terms live on the website (`terms.html`). |
| Made for Kids | No |
| Sign-in required | No |
| Regulated medical device | Not applicable |
| Accessibility Nutrition Labels | Voluntary for now; skip at launch |
| Copyright | `2026 Aarush Kandukoori` (App Store Connect adds the copyright symbol) |
| Version | Must equal the build's `CFBundleShortVersionString`, e.g. `2.0.0` |
| Version release | Manual, so it goes live together with the live Worker and Stripe |

### URLs

| Field | URL | Must be true before submitting |
|---|---|---|
| Support URL | https://aarushkandukoori.github.io/grayout/support.html | Live on GitHub Pages, with `supportEmail` set in `docs/config.js` so the page shows a real email address |
| Marketing URL | https://aarushkandukoori.github.io/grayout/ | Live |
| Privacy Policy URL | https://aarushkandukoori.github.io/grayout/privacy.html | The 2026-10-15 version is live (today the live site still serves the 1.x page) |
| Privacy Choices URL (optional) | https://aarushkandukoori.github.io/grayout/privacy.html#deletion | Live |
| Terms (linked in the description) | https://aarushkandukoori.github.io/grayout/terms.html | Live (it returns 404 until the v2 site is merged to `main`) |

## Version page copy

### Promotional text (170 characters at most; can change without a new build)

<!-- field: promotional, max: 170, unit: chars -->
```text
Drift to a feed or a video and your Mac turns gray with a red border until you get back to work. It never blocks or closes anything. Try 100 checks free.
```

### Keywords (100 bytes at most, comma separated, no spaces needed)

No app or company names. Left out on purpose: "blocker" and "pomodoro" (misleading), "adhd" (a health claim). "work" is already in the name.

<!-- field: keywords, max: 100, unit: bytes -->
```text
focus,distraction,procrastination,study,grayscale,accountability,homework,attention,on task
```

### Description (4,000 characters at most)

<!-- field: description, max: 4000, unit: chars -->
```text
Grayout helps you notice when you drift. Every 45 seconds it looks at your screen and asks one question: is this person clearly not working? Two clear yeses in a row and your whole Mac turns gray with a red border. Get back to work and the color comes back.

It never blocks, closes or locks anything. Gray just makes the feed a lot less fun, and it makes you notice.

HOW IT WORKS
- Every 30, 45 or 90 seconds (you pick), Grayout takes a screenshot of each display and sends it to the Grayout service, which asks an AI model from OpenAI for a one-line verdict.
- Only clear, obvious leisure counts: social feeds, entertainment video, games, shopping. Code, documents, email, research, lectures and anything ambiguous count as work.
- Two off-task checks in a row turn every display gray with a red border. One on its own is forgiven.
- Color returns at the next check after you get back to work, or right away when you click I'm working in the menu bar. That also tells Grayout to back off for ten minutes.
- Pause or Quit always restores color.

YOU STAY IN CONTROL
- Grayout asks for your permission before it sends anything, and tells you who receives it. Turn it off any time in Settings.
- Pause for 15 minutes, an hour, until tomorrow, or until you resume. Nothing is captured while paused.
- Video-call apps like Zoom and FaceTime never trigger it, and password managers are never captured. Add your own apps to either list.
- Checks pause after 10 minutes away from your keyboard and mouse.
- Optional: describe your work in one line so Grayout knows what counts.
- Optional, off by default: let the webcam notice a phone in your hand.
- The dashboard shows your day: how much of it was on task, and everything Grayout flagged. That history stays on your Mac.

PRIVACY
- Screenshots are resized, sent for one verdict, and deleted from your Mac right after each check. The Grayout service does not store them.
- OpenAI does not use them to train its models. It may keep them for up to 30 days to check for abuse.
- No ads, no analytics, no tracking.
- Full details: https://aarushkandukoori.github.io/grayout/privacy.html

PRICING
- Try 100 checks free on this Mac. No card, no account, no sign-in. Free checks are also limited per network and per day, so they can pause on a busy day.
- Grayout Pro is $9.99 a month or $79 a year, plus tax where it applies, for up to 10,000 checks a month. The monthly plan starts with a 7-day free trial for new subscribers (up to 1,000 checks). A card is needed, and you are charged when the trial ends unless you cancel.
- Grayout Pro is bought on the web through Stripe's checkout, not through the App Store. Cancel any time from Manage subscription in the app or at link.com.

Grayout needs macOS 13 or later and Screen Recording permission. You must be 13 or older to use it. It is made for one person watching their own screen, never for monitoring someone else.

Support: https://aarushkandukoori.github.io/grayout/support.html
Terms: https://aarushkandukoori.github.io/grayout/terms.html
```

What this copy depends on (all must be true in the submitted build):
- "asks for your permission before it sends anything": the consent step (both editions).
- "Turn it off any time in Settings": the Send screenshots for checks switch.
- No Canvas, task file, own key, update check or start-at-login claims: those are off or optional in this edition, so the copy does not mention them.

## Age rating

Answer the questionnaire honestly, then override upward.

| Section | Answer |
|---|---|
| In-App Controls: Parental Controls, Age Assurance | None, None |
| Capabilities: Unrestricted Web Access | No (no embedded browser; links open the default browser) |
| Capabilities: User-Generated Content, Social Media, Messaging and Chat, Advertising | No, No, No, No |
| Mature Themes: Profanity, Horror or Fear, Alcohol, Tobacco or Drugs | None for each |
| Medical or Wellness: Medical or Treatment Information, Health or Wellness Topics | None, None |
| Sexuality or Nudity (all) | None |
| Violence (all) | None |
| Chance-Based: Gambling, Simulated Gambling, Contests, Loot Boxes | No, None, None, No |

- The calculated rating is 4+.
- **Override the age rating to 13+.** The terms (`terms.html#age`) set a minimum age of 13, with a parent or guardian's permission under 18, and OpenAI's terms require users to be 13 or older. Apple: if your EULA's minimum age is higher than the calculated rating, you must override. Do this only once the 2026-10-15 terms are live.

## Digital Goods and Services questionnaire

- "Can customers consume digital goods and services in this app?" **Yes.**
- Payment options: not Apple In-App Purchase. For the **United States**, choose the option for an external purchase link to your website.
- Select nothing for the European Union (those answers lock for 12 months).

## Pricing and availability

- Price: **Free** (USD 0.00). No In-App Purchase.
- Availability: Specific Countries or Regions, **United States only**. Leave the box that adds new countries or regions automatically **unchecked**. The Stripe link-out is allowed only in the United States storefront (guideline 3.1.1(a)); never add a region without Apple In-App Purchase.
- No pre-order.

## Agreements, tax and compliance

- A free app with no In-App Purchase needs only the Apple Developer Program License Agreement. No Paid Apps Agreement, no tax forms, no banking.
- **EU Digital Services Act** - Business > Agreements > Compliance > Digital Services Act > **"This is not a trader account."** Apple asks for a trader status even when nothing is distributed in the EU; with no EU availability nothing is published. If the app ever goes to the EU as a trader, the address, phone and email shown must be a P.O. box and a business line, never a home address.
- Small Business Program: not needed now (it requires the Paid Apps Agreement). Watch item: Apple has proposed a commission on United States link-out purchases (15%, or 5% in the program). It is not in effect; if a court approves it, revisit agreements and reporting.

## Export compliance

- `ITSAppUsesNonExemptEncryption` = `NO` in the Mac App Store Info.plist, so App Store Connect asks nothing per build.
- The only cryptography is standard: HTTPS/TLS (Chromium's BoringSSL inside Electron, and Node), Electron `safeStorage` backed by the macOS Keychain, and SHA-1 used only to hash frames for de-duplication. No proprietary algorithms.
- If asked by hand: "Standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system", and available in France: **No**. Result: no documents. Revisit if availability ever goes beyond the United States and Canada. This is not legal advice.

## App Review information

- Contact name, email and phone (international format, +1...) go in App Store Connect's App Review contact fields. They are not public.
- Sign-in required: No.
- Notes: paste `review-notes.txt` after replacing `<REVIEWER_LICENSE_KEY>` with a real key (see `owner-checklist.md`). Keep it under 4,000 bytes; `check-lengths.js` checks the version with a 33-character key in place.
- Optional: attach a short screen recording of the flow made in the Demo user account (`screenshots.md`).
