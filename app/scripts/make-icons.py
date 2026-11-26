"""Draw the app icons (PNG) and the SVG favicon. Run: ~/.venvs/finanzas/bin/python -I scripts/make-icons.py public/icons"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(sys.argv[1])
INK = (11, 11, 12)  # the app's black and white style (Style B); no teal
WHITE = (255, 255, 255)
COIN = (196, 196, 202)


def draw(size, safe=1.0):
    """Black square, three rising white bars and a light gray coin. `safe` shrinks the art for maskable icons."""
    s = size * 4  # draw large, then shrink for smooth edges
    img = Image.new("RGB", (s, s), INK)
    d = ImageDraw.Draw(img)
    unit = s * safe / 100
    off = (s - s * safe) / 2
    bars = [(24, 58, 36, 76), (42, 44, 54, 76), (60, 30, 72, 76)]
    for x0, y0, x1, y1 in bars:
        d.rounded_rectangle([off + x0 * unit, off + y0 * unit, off + x1 * unit, off + y1 * unit], radius=3 * unit, fill=WHITE)
    cx, cy, r = 70, 22, 8
    d.ellipse([off + (cx - r) * unit, off + (cy - r) * unit, off + (cx + r) * unit, off + (cy + r) * unit], fill=COIN)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
draw(192).save(OUT / "icon-192.png", optimize=True)
draw(512).save(OUT / "icon-512.png", optimize=True)
draw(512, safe=0.72).save(OUT / "icon-maskable-512.png", optimize=True)
draw(180).save(OUT / "apple-touch-icon.png", optimize=True)
(OUT / "icon.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    '<rect width="100" height="100" rx="22" fill="#0b0b0c"/>'
    '<rect x="24" y="58" width="12" height="18" rx="3" fill="#fff"/>'
    '<rect x="42" y="44" width="12" height="32" rx="3" fill="#fff"/>'
    '<rect x="60" y="30" width="12" height="46" rx="3" fill="#fff"/>'
    '<circle cx="70" cy="22" r="8" fill="#c4c4ca"/></svg>\n'
)
print("icons written to", OUT)
