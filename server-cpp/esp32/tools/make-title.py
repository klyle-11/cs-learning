#!/usr/bin/env python3
"""Draws the screen's title, "Learner-servr", as pixels and writes main/title.hpp.

    python3 tools/make-title.py [font.ttf] [size]      (needs Pillow: pip install pillow)

The default is DejaVu Serif at 15 px: of the free serif fonts tried, it is the
one whose "rn" does not run together into "m" at this size. Each letter is
placed by hand with one extra pixel after every "r" for the same reason. The
title must stay within 108 x 16 pixels: the star takes the right 20.
DejaVu fonts: Bitstream Vera license, free to use and to embed drawn from.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

TEXT = 'Learner-servr'
font = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'
size = int(sys.argv[2]) if len(sys.argv) > 2 else 15
f = ImageFont.truetype(font, size)
img = Image.new('1', (200, 24), 0)
d = ImageDraw.Draw(img)
d.fontmode = '1'  # no grey: the screen has none
x = 0
for i, ch in enumerate(TEXT):
    d.text((x, 0), ch, font=f, fill=1)
    x += round(f.getlength(ch)) + (1 if ch == 'r' and i + 1 < len(TEXT) else 0)
left, top, right, bottom = img.getbbox()
img = img.crop((left, top, right, bottom))
w, h = img.size
if w > 108 or h > 16:
    sys.exit(f'{w}x{h} is larger than the 108x16 the title may take')
px = img.load()
cols = [sum(1 << y for y in range(h) if px[x, y]) for x in range(w)]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'main', 'title.hpp')
with open(out, 'w') as o:
    o.write('// The screen\'s title, drawn by tools/make-title.py (%s, %d px). Do not edit by hand.\n' % (os.path.basename(font), size))
    o.write('// One 16-bit column per pixel across, bit 0 at the top.\n#pragma once\n#include <cstdint>\n\n')
    o.write('static const int TITLE_W = %d, TITLE_H = %d;\n' % (w, h))
    o.write('static const uint16_t TITLE[TITLE_W] = {\n')
    for i in range(0, w, 12):
        o.write('    ' + ', '.join('0x%04x' % c for c in cols[i:i + 12]) + ',\n')
    o.write('};\n')
print(f'{out}: {w}x{h}')
