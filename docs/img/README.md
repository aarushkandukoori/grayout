# docs/img — site images

Every image on the site must be a real capture of the real app. Until Aarush
records them, the three `.svg` files here are **placeholders**: flat drawings
with the words "PLACEHOLDER — real screenshot coming" printed on them. They
must be replaced before the Show HN post (release gate 6 in BUILD-SPEC §24).

## Placeholders shipped now

| File | Used by | What the real capture shows |
|---|---|---|
| `hero-color.svg` | `index.html` hero, left | The desktop in full color: a code editor and a document open, menu bar visible with the Grayout item in its normal state. |
| `hero-gray.svg` | `index.html` hero, right; `og:image` on every page | The same desktop after two off-task checks: everything gray, the red border on, the Grayout menu open showing "Off task" and the "I'm working" item. |

## Real captures already shipped

| File | Used by | How it was made |
|---|---|---|
| `dashboard.png` | `index.html`, "It keeps the receipts" | A real render of the real dashboard window (`npx electron scripts/dev-shots.js`), filled from `tests/fixtures/verdicts.sample.jsonl`. No personal data. |
| `onboarding-welcome.png` | `install.html` step 4 | A real render of the real welcome window, same script. |


## Still to capture (no placeholder; nothing on the site references them yet)

| File | Where it will go |
|---|---|
| `gatekeeper-1.png` | `install.html` step 2 — the "Apple could not verify" dialog with Done / Move to Trash. |
| `gatekeeper-2.png` | `install.html` step 3 — Privacy & Security with the "was blocked to protect your Mac" line and Open Anyway. |
| `screen-recording.png` | `install.html` step 4 — Screen Recording list with Grayout toggled on. |

Capture these on a fresh macOS user account so no personal data is in frame.

## How to swap a placeholder for a real screenshot

1. Save the capture as PNG at the name above (`hero-color.png`, `hero-gray.png`,
   `dashboard.png`), 2x retina, landscape, roughly 1600 × 1000 px, under 500 KB
   each (`sips -Z 1600 in.png --out out.png`, then run it through an optimizer).
   Nothing personal on screen: use a scratch project, a public document, and a
   throwaway work description.
2. In the HTML, change `src="img/hero-color.svg"` to `.png` (the repo README.md
   also embeds `docs/img/hero-gray.svg` and must change at the same time) and update the
   `width`/`height` attributes to the PNG's pixel size so the layout does not
   jump while loading.
3. Rewrite the `alt` text: it currently starts with "Placeholder — real
   screenshot coming"; the site's own check script greps for that phrase.
4. Update `og:image` in the `<head>` of all four pages to `img/hero-gray.png`.
   Social previews do not render SVG, so the placeholder gives no preview image
   at all until this is done.
5. Delete the `.svg` placeholder once nothing references it.

No image on this site is ever loaded from another domain, and no image may
contain a real person's face, name, message, or URL.
