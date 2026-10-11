#!/usr/bin/env python3
"""Regenerates the app icon, Android adaptive layers and launch-screen mark.

The mark: the "m." logo printed on ivory album paper, held by four black
photo-album corner mounts with gold-foil edges.

Sources in assets/brand/:
  paper-source.jpg         ivory cotton paper texture (GPT Image, 2026-10-11)
  photo-corner-source.png  one TOP-LEFT corner mount, transparent (GPT Image)
  logo-m-dot-source.png    the original "m." icon (white m + blush dot on
                           raspberry); the glyph and dot are lifted from it so
                           the logo stays exact

Layout rule: Android masks adaptive icons to a circle (and shows only the
middle 72dp of a 108dp layer), so the corner tips are kept inside that circle
-- CORNER_INSET is the smallest inset that keeps them clear on every launcher.

Outputs (assets/images/): icon.png, icon-512.png, favicon.png,
android-icon-foreground.png, android-icon-background.png,
android-icon-monochrome.png, splash-icon.png.

Usage: python3 scripts/generate-app-icons.py   (needs Pillow)
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
BRAND = os.path.join(ROOT, 'assets', 'brand')
OUT = os.path.join(ROOT, 'assets', 'images')

S = 1024  # icon canvas
PAPER = (245, 239, 230)  # #F5EFE6 -- also the launch-screen background (app.json)
INK = (44, 36, 24)  # colors.ink
RASPBERRY = (214, 62, 120)  # colors.primary
CORNER_INSET = 176  # tip distance from center = (512-176)*sqrt2 = 475 < 512
CORNER_LEG = 196
LOGO_WIDTH = 430  # "m." width on the 1024 icon


def paper(size):
    """Paper texture normalized to PAPER, tiled by mirroring to any size."""
    src = Image.open(os.path.join(BRAND, 'paper-source.jpg')).convert('RGB')
    mean = src.resize((1, 1), Image.BOX).getpixel((0, 0))
    gains = [t / m for t, m in zip(PAPER, mean)]
    src = Image.merge('RGB', [ch.point(lambda v, g=g: min(255, round(v * g))) for ch, g in zip(src.split(), gains)])
    out = Image.new('RGB', (size, size))
    w, h = src.size
    for ty in range(0, size, h):
        for tx in range(0, size, w):
            tile = src
            if (tx // w) % 2:
                tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
            if (ty // h) % 2:
                tile = tile.transpose(Image.FLIP_TOP_BOTTOM)
            out.paste(tile, (tx, ty))
    return out


def logo_masks():
    """(m_mask, dot_mask) lifted from the original raspberry icon, cropped to
    the logo's bounds. m coverage comes from the green channel (raspberry 62 ->
    white 255); the dot is re-drawn as a clean circle (it sits on top)."""
    old = Image.open(os.path.join(BRAND, 'logo-m-dot-source.png')).convert('RGB')
    g = old.getchannel('G').point(lambda v: max(0, min(255, round((v - 62) * 255 / 193))))
    dot_c, dot_r = (746.5, 650.5), 53.5  # measured from the solid blush pixels
    k = 4  # supersample the dot
    dot = Image.new('L', (S * k, S * k), 0)
    ImageDraw.Draw(dot).ellipse(
        ((dot_c[0] - dot_r) * k, (dot_c[1] - dot_r) * k, (dot_c[0] + dot_r) * k, (dot_c[1] + dot_r) * k), fill=255
    )
    dot = dot.resize((S, S), Image.LANCZOS)
    m = ImageChops.subtract(g, dot)  # the dot is drawn separately, on top
    box = (224 - 4, 424 - 4, 800 + 4, 704 + 4)
    return m.crop(box), dot.crop(box)


def corner_pieces(leg):
    src = Image.open(os.path.join(BRAND, 'photo-corner-source.png')).convert('RGBA')
    src = src.crop(src.getchannel('A').point(lambda v: 255 if v > 40 else 0).getbbox()).resize((leg, leg), Image.LANCZOS)
    # top-left, top-right, bottom-right, bottom-left (PIL rotates counter-clockwise)
    return [src, src.rotate(270, expand=True), src.rotate(180, expand=True), src.rotate(90, expand=True)]


def mark_layer(size, scale, ink_on=None):
    """Corners + shadows + logo on a transparent `size` canvas, laid out at
    `scale` x the 1024 icon and centered. If `ink_on` (an RGB paper image of the
    same size) is given, the logo ink is multiplied into it like print."""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    off = (size - S * scale) / 2
    leg = round(CORNER_LEG * scale)
    inset = CORNER_INSET * scale
    pieces = corner_pieces(leg)
    spots = [
        (off + inset, off + inset),
        (off + S * scale - inset - leg, off + inset),
        (off + S * scale - inset - leg, off + S * scale - inset - leg),
        (off + inset, off + S * scale - inset - leg),
    ]
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for piece, (x, y) in zip(pieces, spots):
        shadow.paste((60, 40, 20, 80), (round(x), round(y + 5 * scale)), piece.getchannel('A'))
    layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(7 * scale)))
    for piece, (x, y) in zip(pieces, spots):
        layer.alpha_composite(piece, (round(x), round(y)))

    m_mask, dot_mask = logo_masks()
    lw = round(LOGO_WIDTH * scale)
    lh = round(m_mask.height * lw / m_mask.width)
    m_mask, dot_mask = m_mask.resize((lw, lh), Image.LANCZOS), dot_mask.resize((lw, lh), Image.LANCZOS)
    lx, ly = round((size - lw) / 2), round((size - lh) / 2 + 6 * scale)
    for color, mask in ((INK, m_mask), (RASPBERRY, dot_mask)):
        if ink_on is not None:
            region = ink_on.crop((lx, ly, lx + lw, ly + lh))
            printed = ImageChops.multiply(region, Image.new('RGB', (lw, lh), tuple(min(255, c + 18) for c in color)))
            tile = printed.convert('RGBA')
        else:
            tile = Image.new('RGBA', (lw, lh), color + (255,))
        tile.putalpha(mask)
        layer.alpha_composite(tile, (lx, ly))
    return layer


def main():
    # iOS / store icon: opaque paper + mark.
    base = paper(S)
    icon = base.convert('RGBA')
    icon.alpha_composite(mark_layer(S, 1, ink_on=base))
    icon = icon.convert('RGB')  # no alpha (App Store requirement)
    icon.save(os.path.join(OUT, 'icon.png'))
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon-512.png'))
    icon.resize((48, 48), Image.LANCZOS).save(os.path.join(OUT, 'favicon.png'))

    # Android adaptive: paper background layer + mark foreground at 2/3 scale
    # (the visible 72dp of the 108dp layer == the iOS icon).
    paper(S).save(os.path.join(OUT, 'android-icon-background.png'))
    mark_layer(S, 72 / 108).save(os.path.join(OUT, 'android-icon-foreground.png'))

    # Themed (monochrome) icon: flat silhouettes of the corners and the "m.".
    mono_src = mark_layer(S, 72 / 108)
    alpha = mono_src.getchannel('A').point(lambda v: 255 if v > 110 else 0)
    mono = Image.new('RGBA', (S, S), (255, 255, 255, 0))
    mono.putalpha(alpha)
    mono.resize((432, 432), Image.LANCZOS).save(os.path.join(OUT, 'android-icon-monochrome.png'))

    # Launch screen: the same mark, transparent, on a flat PAPER background.
    # app.json imageWidth 200 keeps the corner tips inside Android 12+'s
    # 192dp splash circle (tips at 0.46 x imageWidth from center).
    mark_layer(S, 1).save(os.path.join(OUT, 'splash-icon.png'))

    print('paper #%02X%02X%02X' % PAPER)


if __name__ == '__main__':
    main()
