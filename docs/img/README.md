# docs/img — site images

Every image on the site must be a real capture of the real app.

## Real captures shipped

| File | Used by | How it was made |
|---|---|---|
| `dashboard.png` | `index.html`, "You can check its work"; `og:image` on every page | A real render of the real dashboard window (`npx electron scripts/dev-shots.js`), filled from `tests/fixtures/verdicts.sample.jsonl`. No personal data. |
| `onboarding-welcome.png` | `install.html` step 4 | A real render of the real welcome window, same script. |

## Placeholders, no longer referenced

The v2 landing page draws its own animated mock in inline SVG, so the two hero
placeholders are not used by any page and not linked from the repository README.
They are kept on disk only so an old social-card cache does not 404.

| File | State |
|---|---|
| `hero-color.svg` | Unused. Delete once nothing outside this repository links it. |
| `hero-gray.svg` | Unused. Delete once nothing outside this repository links it. |

The `dashboard.png` capture predates the subscription and its cost line still
shows dollars. A fresh capture would let `index.html` drop the caveat it carries
about that.


## Still to capture (no placeholder; nothing on the site references them yet)

| File | Where it will go |
|---|---|
| `gatekeeper-1.png` | `install.html` step 2 — the "Apple could not verify" dialog with Done / Move to Trash. |
| `gatekeeper-2.png` | `install.html` step 3 — Privacy & Security with the "was blocked to protect your Mac" line and Open Anyway. |
| `screen-recording.png` | `install.html` step 4 — Screen Recording list with Grayout toggled on. |

Capture these on a fresh macOS user account so no personal data is in frame.

## How to add or replace a capture

1. Save it as PNG, 2x retina, landscape, roughly 1600 × 1000 px, under 500 KB
   (`sips -Z 1600 in.png --out out.png`, then run it through an optimizer).
   Nothing personal on screen: use a scratch project, a public document, and a
   throwaway work description.
2. Point the `src` at it and set `width`/`height` to the PNG's pixel size so the
   layout does not jump while loading.
3. Write `alt` text that describes what is actually in the frame.
4. If it replaces `dashboard.png`, the `og:image` on every page points at that
   filename, so keep the name or change all of them in the same edit.

No image on this site is ever loaded from another domain, and no image may
contain a real person's face, name, message, or URL.
