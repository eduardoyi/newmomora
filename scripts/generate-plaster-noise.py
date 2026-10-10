#!/usr/bin/env python3
"""Regenerates assets/textures/plaster-noise.png, the tiling grain behind the
artwork gallery wall (src/components/artwork/gallery-wall.tsx).

128x128 greyscale noise. Every pixel is independent, so the tile is seamless
by construction. The mean is close to the plaster color's luminance so the
overlay (drawn at ~9% opacity) adds grain without darkening the wall.

Usage: python3 scripts/generate-plaster-noise.py   (needs Pillow)
"""
import random
from pathlib import Path

from PIL import Image

SIZE = 128
MEAN = 225
SIGMA = 38

rng = random.Random(20261010)
pixels = [max(0, min(255, round(rng.gauss(MEAN, SIGMA)))) for _ in range(SIZE * SIZE)]
image = Image.new("L", (SIZE, SIZE))
image.putdata(pixels)

out = Path(__file__).resolve().parent.parent / "assets" / "textures" / "plaster-noise.png"
image.save(out, optimize=True)
print(f"wrote {out} ({out.stat().st_size} bytes)")
