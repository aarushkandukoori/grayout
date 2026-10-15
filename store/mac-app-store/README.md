# Mac App Store package

Everything App Store Connect asks for, for the Mac App Store edition of Grayout ("Grayout: Back to Work", United States storefront only). Nothing here is live: the app is not on the App Store yet.

| File | What it is |
|---|---|
| `listing.md` | Name, subtitle, promotional text, keywords, description, URLs, categories, age rating (with the 13+ override), Digital Goods questionnaire, pricing and availability, export compliance, the EU trader answer |
| `privacy-labels.md` | The App Privacy answers, with the two judgment calls marked |
| `review-notes.txt` | Paste-ready App Review notes. Replace `<REVIEWER_LICENSE_KEY>` only inside App Store Connect, never here |
| `screenshots.md` | The shot list and the rules (a separate Demo macOS user, no prices, nothing faked) |
| `owner-checklist.md` | The ordered steps only Aarush can do, from enrollment to release |
| `check-lengths.js` | `node store/mac-app-store/check-lengths.js` checks every field against Apple's limits and the folder for em and en dashes. `npm test` runs it too |

How the edition is built is in `docs/BUILD-SPEC.md`, section 27.
