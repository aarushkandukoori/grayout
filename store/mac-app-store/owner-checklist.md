# Mac App Store launch: steps only Aarush can do

In order. Each step is something only Aarush can do: it pays, signs an agreement, holds a secret, or speaks for him. Code and docs work is done elsewhere and listed only where a step depends on it. Secrets are only ever typed into his own Terminal or a vendor's dashboard, never pasted into a chat, a file in the repo, or a commit.

## A. Decisions first

1. **Support email.** Pick a watched address that is not personal (an alias, never a phone number or home address). It goes in four places later: `docs/config.js` `supportEmail`, `SUPPORT_EMAIL` in `server/wrangler.jsonc` (both environments), Stripe's business details, and App Store Connect's App Review contact. Apple needs the Support URL (`support.html`) to show real contact information, and the site shows the email only once `supportEmail` is set.
2. **Privacy wording: approved by Aarush on 2026-10-15.** `docs/privacy.html#model` (and `PRIVACY.md`) says: "We only use service providers that are bound by written data-protection terms giving your data the same or equal protection as this policy" for OpenAI, Cloudflare and Stripe (Apple guideline 5.1.1(i)). Keep it true: if a processor is added or its terms change, revisit this sentence first.
3. **App Privacy judgment calls.** Keep or drop Browsing History and Payment Info in `privacy-labels.md`, and write down why if dropped.
4. **Name check.** Search tmsearch.uspto.gov for GRAYOUT before launch.
5. **Architecture.** arm64-only or universal for the first store build (the packaging report recommends arm64-only; the Intel DMG stays on the website).

## B. Make the website pages live

6. Done 2026-10-15: the v2 site is live on `main` (GitHub Pages) with the service off, including the 2026-10-15 `privacy.html`, `terms.html` and `support.html` that App Store Connect needs. Leave the API base placeholder, `checkoutLive: false` and `masUrl: ''` in `docs/config.js` until steps 26 and 38.

## C. Apple Developer Program

7. Enroll as an **Individual** ($99 a year, an Apple Account with two-factor authentication). The seller name shown on the App Store will be "Aarush Kandukoori".
8. Accept the latest Apple Developer Program License Agreement (developer.apple.com > Account, and App Store Connect > Business). Skip the Paid Apps Agreement, tax and banking: the app is free with no In-App Purchase.
9. Do **not** register `com.aarushkandukoori.grayout` under the free Personal Team (for example through Xcode automatic signing); it could block the paid team from using it.
10. Certificates, Identifiers and Profiles:
    - an **Apple Distribution** certificate and a **Mac Installer Distribution** certificate (for the `.pkg`);
    - optionally an **Apple Development** certificate, for repeated local sandbox tests with a stable signature;
    - the explicit App ID `com.aarushkandukoori.grayout` (macOS);
    - a **Mac App Store** distribution provisioning profile for that App ID. Keep it in the gitignored build folder; never commit it.
11. App Store Connect > Users and Access > Integrations: create a Team API key (App Manager) for uploads. Keep the `.p8` file in `~/.appstoreconnect/private_keys/` with mode 600. Never commit it.
12. Put your Team ID where the Mac App Store packaging needs it (`electron-builder.mas.cjs` and `ElectronTeamID`; see `docs/BUILD-SPEC.md` section 27).

## D. App Store Connect record

13. Business > Agreements > Compliance > Digital Services Act: **"This is not a trader account."**
14. Apps > (+) > New App: platform macOS, name **Grayout: Back to Work**, primary language English (U.S.), bundle ID `com.aarushkandukoori.grayout`, SKU `GRAYOUT-MAC-001`, user access Full.
15. App Information, from `listing.md`: subtitle, categories (Productivity, Utilities), content rights, Privacy Policy URL, Privacy Choices URL, standard EULA, Digital Goods and Services (Yes; United States: link to an outside purchase), and the age rating questionnaire with the **override to 13+** (only once the 2026-10-15 terms are live, step 6).
16. Before App Privacy, check the sandbox Worker: Workers invocation logs are now off in `server/wrangler.jsonc`, so verify that its stored log lines carry no client IP. If they do, declare it and keep the policy in step. Finishing the sandbox (`server/README.md` steps 5 to 8) makes its webhook with the Stripe CLI, and as of 2026-10-15 the CLI's login on this Mac is not authorized: run `stripe login` first, or add the webhook in the Stripe Dashboard (step 6 there).
17. App Privacy: "Yes, we collect data", tick the types in `privacy-labels.md`, answer linked / not tracking / App Functionality for each, then **Publish**.
18. Pricing and Availability: price **Free**; availability **United States only**, with the box that adds new regions automatically **unchecked**.

## E. Payments and the live service

19. Stripe: activate the account for live payments and turn on **Managed Payments**. In live mode, set what the sandbox has: business details with the support email; Checkout settings with the terms and privacy URLs and "limit customers to one subscription" (redirecting to the portal); failed-payment retries then cancel; disputes cancel at once; the customer portal (cancel at period end with a reason, card updates, prorated monthly and yearly switching, the login link, and `trial_update_behavior` "continue_trial"); Radar's free-trial abuse protection.
20. Create the live product and its two prices ($9.99 a month, $79 a year, tax exclusive) and put their ids, and the support email, in `server/wrangler.jsonc`.
21. Cloudflare: switch the account to **Workers Paid** before going live and before App Review (the free plan's CPU limit can cut off a three-display check).
22. Deploy the live Worker: `bash server/scripts/deploy.sh live`. It writes the live address into `src/config.js` for the app and leaves `docs/config.js` alone; the site gets it in step 26.
23. Set the live secrets **in your own Terminal**: `bash server/scripts/set-secrets.sh live`. Use a restricted `rk_live_` Stripe key, the live webhook secret (check it starts with `whsec_` before it is stored), a capped OpenAI key, and new random device and license secrets. Save the license secret in your password manager; lost license keys can't be re-sent without it. It makes the live webhook with the Stripe CLI, so it needs the same fresh `stripe login` as step 16, or the Dashboard.
24. Run `bash server/scripts/deploy.sh live` once more, then check `/v1/health` on the live Worker shows `"mode":"live"` with every flag true.
25. **Publish the 2.x direct download as GitHub's latest release.** Commit the live address in `src/config.js`, tag that commit on `main` as `v2.0.0` and push the tag; `release.yml` builds and publishes the release. Check that the repository's releases/latest page shows 2.0.0, not 1.0.1: every Download button follows it.
26. **Fill the site and open checkout.** Run `bash server/scripts/deploy.sh live --fill-site` (it stops while the latest release is still 1.x), set `supportEmail` and `checkoutLive: true` in `docs/config.js`, then commit and publish. Check that `support.html` shows the email and that `pricing.html`, `success.html` and `account.html` no longer say subscriptions are not open. Steps 30 and 35 need this.
27. **Make the live site the default without JavaScript.** Once step 26 is published, add `data-service="on"` to the `<html>` tag of every page in `docs/` (`docs/app.js` still sets it at runtime), or delete the `data-when="noservice"` blocks. Until then, visitors without JavaScript, and crawlers and link previews that do not run it, still see the 1.x own-key text: the "Use your own key today" buttons, the own-key plan card and "Today's release runs on your own key".

## F. Build, test, get the review key

28. Build the store package with `electron-builder.mas.cjs`, with `DEFAULT_API_BASE` filled with the live Worker URL, and run `scripts/verify-mas.sh` on it. Upload with Transporter or `xcrun altool` using the Team API key. `CFBundleVersion` must go up with every upload.
29. **TestFlight for Mac** (internal testers, no review needed): install the store-signed build in a clean **Demo** macOS user and run every step of `review-notes.txt`: the consent screen, Screen Recording and relaunch, the free checks, the gray and the red border, I'm working, Restore color now, Pause, Quit, Send screenshots for checks off and on, and Erase this Mac's Grayout data.
30. **One live purchase through the store build**, with your own card: click Subscribe in the TestFlight build, pay on Stripe, and confirm the app unlocks itself. The success page shows the license key under "Key for another Mac" (if it doesn't, `LICENSE_SECRET=... node server/scripts/license-key.js cus_...` rebuilds it). That key is the reviewer key. Keep it in your password manager and never commit it. Keep the subscription active until the app is approved, then cancel it (do not refund it: a refund revokes the key).
31. Replace `<REVIEWER_LICENSE_KEY>` in `review-notes.txt` with it **only in App Store Connect**, never in the repository. Confirm it works the way the notes say, in a second Demo user (the one that bought it is already unlocked, so the field is hidden there): Settings > Your plan > Connect an existing subscription, paste the key, click Activate.
32. Take the screenshots in the Demo user, following `screenshots.md` (no prices, no real brands, never your own screen).
33. Optional: accept Apple's Marketing Artwork License Agreement and download the official "Download on the Mac App Store" badge (see `docs/img/README.md`). Until then the site uses a plain text link.

## G. Submit and release

34. Version page: screenshots, promotional text, description, keywords, Support and Marketing URLs, version, copyright, App Review contact (name, email, phone in +1 format), sign-in not required, the review notes with the real key, and Version Release **Manual**.
35. Right before submitting, confirm all of these are live: the privacy, terms and support pages (with the email); the filled-in site with checkout open; the live Worker with OpenAI and Stripe live; the build pointed at the live API; the reviewer key working.
36. Select the build, Add for Review, **Submit for Review**.
37. After approval (Pending Developer Release), click **Release**.
38. Once the listing opens in a signed-out browser: set `masUrl` in `docs/config.js` to its exact `https://apps.apple.com/us/app/...` URL and publish. That turns on the site's App Store links and Apple's trademark credit. Then update the README's "coming soon" Mac App Store section with the link (and the badge and credit line, if you downloaded the badge), and cancel the review subscription.
