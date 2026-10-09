# docs/img: site images

All site art is drawn in CSS and inline SVG inside the pages. This folder only
holds icons, the social card, and real captures of the real app.

| File | Used by | How it was made |
|---|---|---|
| `favicon.svg` | every page | The Grayout mark: a gray circle with one red quarter. |
| `favicon-32.png`, `apple-touch-icon.png` | every page | Rendered from the mark with headless Chrome. |
| `og.svg` | source of `og.png` | Hand-written SVG: headline, sky, and a desktop half in color and half gray. |
| `og.png` | `og:image` and `twitter:image` on every page | `og.svg` rendered at 1200x630 with headless Chrome and the site's own fonts. Re-render it after editing the SVG. |
| `onboarding-welcome.png` | source of the crop below | A real render of the 1.x welcome window (`npx electron scripts/dev-shots.js`). |
| `onboarding-welcome-crop.png` | `download.html`, shown only while the current release is 1.x | `onboarding-welcome.png` with its empty middle cut out (rows 582 to 986 removed with Pillow), so the text and the Continue button sit together. Nothing else is changed. Replace both when 2.0 ships. |
| `dashboard.png` | the repository README | A real render of the dashboard. Not used by the site: it shows the 1.x spend line. |
| `hero-color.svg`, `hero-gray.svg` | nothing | Old placeholders, kept so old social-card caches do not 404. Safe to delete. |
