#!/usr/bin/env bash
# Regenerates every generated raster asset from source. Run as `npm run icons`.
#
#   build/icon.svg  -> build/icon.png (1024x1024, transparent corners)
#                   -> build/icon.iconset (16..1024 via sips) -> build/icon.icns (iconutil)
#   build/dmg-background.png (660x400) + build/dmg-background@2x.png (1320x800), Pillow
#   assets/tray*Template.png + @2x, via scripts/make-tray-icons.py, Pillow
#
# SVG rasterizer, first one that works:
#   1. rsvg-convert        (brew install librsvg)
#   2. python3 + cairosvg  (pip3 install --user cairosvg)
#   3. python3 + Pillow    redraws the same three shapes as icon.svg (what this Mac uses)
# qlmanage is deliberately NOT used: `qlmanage -t -s 1024` renders the SVG onto an opaque
# white background (verified 2026-09-21), which is wrong for an app icon.
# Pillow is required regardless for the DMG background and tray icons:
#   python3 -c "import PIL" || pip3 install --user pillow
set -euo pipefail
cd "$(dirname "$0")/.."

SVG=build/icon.svg
PNG=build/icon.png
ICONSET=build/icon.iconset
ICNS=build/icon.icns

python3 -c 'import PIL' 2>/dev/null || { echo "make-icons: Pillow missing: pip3 install --user pillow" >&2; exit 1; }

# ---------------------------------------------------------------- 1. SVG -> 1024 PNG
if command -v rsvg-convert >/dev/null 2>&1; then
  echo "make-icons: rasterizing $SVG with rsvg-convert"
  rsvg-convert -w 1024 -h 1024 -o "$PNG" "$SVG"
elif python3 -c 'import cairosvg' 2>/dev/null; then
  echo "make-icons: rasterizing $SVG with cairosvg"
  python3 -c 'import cairosvg,sys; cairosvg.svg2png(url=sys.argv[1], write_to=sys.argv[2], output_width=1024, output_height=1024)' "$SVG" "$PNG"
else
  echo "make-icons: rasterizing with Pillow (same geometry as $SVG)"
  python3 - "$PNG" <<'PY'
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
S = 4                      # supersample, then Lanczos down to 1024
N = 1024 * S
im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
# <rect x=100 y=100 width=824 height=824 rx=185 fill=#e8e8ea/>
d.rounded_rectangle((100 * S, 100 * S, 924 * S - 1, 924 * S - 1), radius=185 * S, fill=(232, 232, 234, 255))
# <circle cx=512 cy=512 r=272 fill=#86868b/>
cx = cy = 512 * S; r = 272 * S
disc = (cx - r, cy - r, cx + r - 1, cy + r - 1)
d.ellipse(disc, fill=(134, 134, 139, 255))
# top-right quarter wedge, fill #d03b3b (Pillow angles: 0 = 3 o'clock, clockwise)
d.pieslice(disc, start=270, end=360, fill=(208, 59, 59, 255))
im.resize((1024, 1024), Image.LANCZOS).save(out, 'PNG', optimize=True)
PY
fi

# Gate: 1024x1024, alpha channel, transparent corners.
python3 - "$PNG" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1])
assert im.size == (1024, 1024), im.size
assert im.mode == 'RGBA', im.mode
assert im.getpixel((2, 2))[3] == 0, 'corner is not transparent'
assert im.getpixel((512, 512))[3] == 255, 'center is not opaque'
print('make-icons: build/icon.png ok (1024x1024 RGBA, transparent corners)')
PY

# ---------------------------------------------------------------- 2. iconset -> icns
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  if [ "$d" -eq 1024 ]; then
    cp "$PNG" "$ICONSET/icon_${s}x${s}@2x.png"
  else
    sips -z "$d" "$d" "$PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"
file "$ICNS" | grep -q 'Mac OS X icon' || { echo "make-icons: $ICNS is not an icns" >&2; exit 1; }
echo "make-icons: $ICNS ok ($(stat -f %z "$ICNS") bytes)"

# ---------------------------------------------------------------- 3. DMG background
python3 - build/dmg-background.png build/dmg-background@2x.png <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont

out1, out2 = sys.argv[1], sys.argv[2]
W, H = 660, 400            # Finder window content size from package.json build.dmg.window
S = 4                      # draw at 2640x1600, then Lanczos to 1x and 2x
BG = (245, 245, 247)
INK = (29, 29, 31)
MUTED = (110, 110, 115)
ARROW = (142, 142, 147)

def font(size, weight='Regular'):
    for path in ('/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc'):
        try:
            f = ImageFont.truetype(path, size * S)
            try:
                f.set_variation_by_name(weight)
            except Exception:
                pass
            return f
        except OSError:
            continue
    return ImageFont.load_default()

im = Image.new('RGB', (W * S, H * S), BG)
d = ImageDraw.Draw(im)

def centered(text, y, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W * S - w) / 2, y * S), text, font=f, fill=fill)

centered('Drag Grayout to Applications', 48, font(22, 'Medium'), INK)

# Arrow between the two icon slots. Slots are 128 px icons centered at x=170 and
# x=490 (y=190), so the shaft runs from x=250 to x=410 clear of both icons.
y = 190 * S
x0, x1 = 250 * S, 410 * S
shaft = 3 * S
head = 14 * S
d.line([(x0, y), (x1 - head + shaft, y)], fill=ARROW, width=shaft)
d.polygon([(x1, y), (x1 - head, y - head * 0.62), (x1 - head, y + head * 0.62)], fill=ARROW)

small = font(13)
centered("First launch: macOS will say it can't verify the app.", 336, small, MUTED)
centered('Go to System Settings › Privacy & Security › Open Anyway.', 355, small, MUTED)

im.resize((W, H), Image.LANCZOS).save(out1, 'PNG', optimize=True, dpi=(72, 72))
im.resize((W * 2, H * 2), Image.LANCZOS).save(out2, 'PNG', optimize=True, dpi=(144, 144))
for p, size in ((out1, (W, H)), (out2, (W * 2, H * 2))):
    assert Image.open(p).size == size, p
print(f'make-icons: {out1} {W}x{H}, {out2} {W*2}x{H*2}')
PY

# ---------------------------------------------------------------- 4. tray template icons
python3 scripts/make-tray-icons.py
echo "make-icons: done"
