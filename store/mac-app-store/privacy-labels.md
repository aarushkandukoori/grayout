# App Privacy answers (App Store Connect > App Privacy)

These answers must agree with the privacy policy (`docs/privacy.html` and `PRIVACY.md`, effective 2026-10-15). If either changes, change both. Two answers are judgment calls, marked **Judgment call**: they are the conservative reading, and Aarush decides whether to keep them. Under-disclosing is the rejection risk; over-disclosing only makes the label look heavier.

## The definition that decides it

Apple: data is "collected" when it leaves the device in a way that lets you or your partners access it "for a period longer than what is necessary to service the transmitted request in real time". The Grayout service drops every image after one request, but OpenAI, Grayout's processor, may keep API inputs for up to 30 days for abuse monitoring. So screenshot content counts as collected. Separately, the service's D1 database keeps identifiers and keyed hashes (`server/migrations/0001_init.sql`).

## First question

"Do you or your third-party partners collect data from this app?" **Yes.**

## Data types to tick

Every type: **Linked to the user: Yes. Used for tracking: No. Purpose: App Functionality only.** Never tick Analytics, Advertising, Product Personalization or Developer's Advertising. Onboarding says there is no analytics, and the policy says the data is never sold or used for advertising.

| App Store Connect type | What it is in Grayout | Why linked | Notes |
|---|---|---|---|
| User Content > Other User Content | The screenshot of each display, the work description, task titles | Requests carry the device id and license; screen content is personal data | Sent at each check after consent |
| User Content > Photos or Videos | The optional webcam frame | Same | Off by default. Still declared: Apple says data collected on an ongoing basis after an initial permission request must be disclosed |
| Browsing History | Screenshots show the sites and apps being viewed, and the frontmost app's name is sent each check | Same | **Judgment call.** Keep unless Aarush decides the screenshot is already covered by Other User Content and writes down why |
| Identifiers > Device ID | The server-issued `dev_...` id and token; for 48 hours a keyed hash of the IP address; network and /48 hashes for free-check limits | Tied to the license once there is one | Apple says to declare IP addresses by how they are used: here, as an identifier for abuse limits |
| Identifiers > User ID | The license key (stored as a SHA-256 hash), the Stripe customer and subscription ids | Yes | |
| Purchases > Purchase History | Plan, subscription status, period dates, trial; checkout records for 30 days | Yes | |
| Contact Info > Email Address | A keyed hash of the buyer's email, kept a year, one trial per person | Stored with the Stripe customer id | Apple counts a hashed email as an email address |
| Financial Info > Payment Info | A keyed hash of Stripe's card fingerprint, kept a year | Same table | **Judgment call.** Apple exempts payment data the developer never accesses, but the service does read the fingerprint. Keep unless Aarush decides otherwise and writes down why |
| Usage Data > Product Interaction | Check counts per device and license per month, last-seen time | Yes | App Functionality only |

## Not collected (leave unticked)

- Name, phone number, physical address. Stripe and Link collect these as merchant of record on their own web page, outside the app; the service never reads them.
- Health, fitness, financial info other than the row above, location, sensitive info, contacts, emails or text messages, audio, gameplay content, customer support, search history, other user content, advertising data, other usage data, crash data, performance data, other diagnostic data.
- Location: **only if** Cloudflare's Workers invocation logs do not keep client IP or location. `server/wrangler.jsonc` turns on `"observability"`. Before submitting, Aarush checks what those logs hold. If they keep IP or geolocation, either turn invocation logs off or declare Coarse Location, and fix the policy's "IP addresses in clear" line to match.
- Diagnostics: there is no crash reporter (no `crashReporter` or Sentry), and local logs never leave the Mac.

## Other answers

- Tracking: **No** for every type, so no App Tracking Transparency prompt.
- A privacy manifest (`PrivacyInfo.xcprivacy`) is not required for macOS apps.
- If OpenAI ever approves Zero Data Retention for Grayout's API account, screenshot content arguably becomes "not collected" (apart from the rare image flagged for child-safety review). Update both this label and the policy then, not before.

## Policy lines these answers rely on

- `privacy.html#consent`: nothing is sent before Allow and continue.
- `privacy.html#model`: OpenAI may keep inputs up to 30 days; the service keeps none; the processor commitment.
- `privacy.html#service`: what D1 stores and for how long.
- `privacy.html#app-store`: the Mac App Store edition sends the same things to the same places.
