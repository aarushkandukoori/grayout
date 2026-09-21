#!/usr/bin/env python3
"""Generate the menu-bar template icons (black + alpha only; macOS recolors them).

  assets/trayTemplate.png / @2x         watching: circle with a quarter wedge cut out
  assets/trayAlertTemplate.png / @2x    off task: filled circle inside a square outline
  assets/trayPausedTemplate.png / @2x   paused:   ring
  assets/trayBlockedTemplate.png / @2x  blocked:  ring with a diagonal slash

16x16 at 1x, 32x32 at 2x. Strokes are 1 px at 1x and 2 px at 2x. Shapes are drawn
on an 8x supersampled mask and downsampled with Lanczos, so every edge is
antialiased. Requires Pillow (pip3 install --user pillow). Run from anywhere:
    python3 scripts/make-tray-icons.py [--out assets]
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.stderr.write('make-tray-icons: Pillow is missing (pip3 install --user pillow)\n')
    sys.exit(1)

SS = 8  # supersampling factor
SCALES = [(1, ''), (2, '@2x')]
BASE = 16


def _canvas(size):
    n = size * SS
    mask = Image.new('L', (n, n), 0)
    return mask, ImageDraw.Draw(mask)


def _box(x0, y0, x1, y1, k):
    """Bounding box covering pixel columns x0..x1-1 and rows y0..y1-1 at scale k."""
    s = k * SS
    return (round(x0 * s), round(y0 * s), round(x1 * s) - 1, round(y1 * s) - 1)


def watching(d, k):
    # Disc on pixels 1..15 (14 px wide) with the top-right quarter removed.
    b = _box(1, 1, 15, 15, k)
    d.ellipse(b, fill=255)
    d.pieslice(b, start=270, end=360, fill=0)


def alert(d, k):
    # 1 px square outline on pixels 1..15, filled 8 px disc centered inside.
    d.rectangle(_box(1, 1, 15, 15, k), outline=255, width=k * SS)
    d.ellipse(_box(4, 4, 12, 12, k), fill=255)


def paused(d, k):
    d.ellipse(_box(1, 1, 15, 15, k), outline=255, width=k * SS)


def blocked(d, k):
    paused(d, k)
    # Diagonal slash, upper-left to lower-right, meeting the ring on both ends.
    s = k * SS
    d.line([(3.3 * s, 3.3 * s), (12.7 * s, 12.7 * s)], fill=255, width=k * SS)


ICONS = {
    'trayTemplate': watching,
    'trayAlertTemplate': alert,
    'trayPausedTemplate': paused,
    'trayBlockedTemplate': blocked,
}


def render(fn, k):
    size = BASE * k
    mask, d = _canvas(size)
    fn(d, k)
    alpha = mask.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.putalpha(alpha)
    return out


def main(argv):
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    out_dir = os.path.join(root, 'assets')
    if '--out' in argv:
        out_dir = argv[argv.index('--out') + 1]
    os.makedirs(out_dir, exist_ok=True)
    for name, fn in ICONS.items():
        for k, suffix in SCALES:
            img = render(fn, k)
            path = os.path.join(out_dir, f'{name}{suffix}.png')
            # dpi metadata mirrors the scale (72 / 144) like Xcode-produced assets.
            img.save(path, 'PNG', optimize=True, dpi=(72 * k, 72 * k))
            # Self-check: RGBA, expected size, RGB all black.
            chk = Image.open(path)
            assert chk.mode == 'RGBA' and chk.size == (BASE * k, BASE * k), path
            assert chk.getchannel('R').getextrema() == (0, 0), path
            # A 1 px antialiased curve never fully covers a pixel; just make sure ink is there.
            peak = chk.getchannel('A').getextrema()[1]
            assert peak >= 160, (path, peak)
            print(f'{os.path.relpath(path, root)}  {chk.size[0]}x{chk.size[1]} RGBA  peak alpha {peak}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
