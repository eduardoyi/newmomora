#!/usr/bin/env python3
"""Regenerates assets/images/splash-icon.png, the native launch-screen mark.

The launch screen is the app icon, grown: the same white "m." with the blush
dot, on the same magenta (app.json splash backgroundColor == colors.primary).
The glyph and dot are lifted straight from assets/images/icon.png, so the two
never drift apart, and centered with no padding in a transparent square --
app.json `imageWidth` therefore equals the mark's width in dp. Keep
imageWidth <= ~150 so the mark stays inside Android 12+'s 192dp splash circle.
The in-app hand-off (src/components/brand-splash.tsx) draws this same file at
the same size.

Usage: python3 scripts/generate-splash-icon.py   (needs Pillow)
"""
import os

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ICON = os.path.join(ROOT, 'assets', 'images', 'icon.png')
OUT = os.path.join(ROOT, 'assets', 'images', 'splash-icon.png')

MAGENTA = (214, 62, 120)  # icon background == colors.primary
WHITE = (255, 255, 255)
BLUSH = (251, 211, 226)  # the dot


def main():
    icon = Image.open(ICON).convert('RGB')
    w, h = icon.size
    src = icon.load()
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            # Coverage over the magenta background, from the green channel
            # (magenta 62 -> white 255). The blush dot reads as ~77% coverage
            # of white, so un-premultiply to recover its color too.
            a = max(0.0, min(1.0, (g - MAGENTA[1]) / (WHITE[1] - MAGENTA[1])))
            if a <= 0:
                continue
            color = tuple(
                max(0, min(255, round((c - m * (1 - a)) / a))) for c, m in zip((r, g, b), MAGENTA)
            )
            dst[x, y] = color + (round(a * 255),)
    bbox = out.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    mark = out.crop(bbox)
    side = max(mark.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.alpha_composite(mark, ((side - mark.width) // 2, (side - mark.height) // 2))
    square.resize((1024, 1024), Image.LANCZOS).save(OUT)
    print('mark bbox in icon', bbox)


if __name__ == '__main__':
    main()
