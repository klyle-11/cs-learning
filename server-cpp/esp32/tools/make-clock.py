#!/usr/bin/env python3
"""Draws the clock slide's characters as pixels and writes main/clock_font.hpp.

    python3 tools/make-clock.py [font.ttf] [big size] [small size]      (needs Pillow: pip install pillow)

The time is in the title's typeface, DejaVu Serif: large figures (0-9, ":" and
"-" for a time not known yet), and beside them small capitals for AM or PM
over EST or EDT. The sizes are the largest at which the widest time, "12:00",
and the small letters fit the screen's 128 pixels with the row below the
dotted line (34 rows) to stand in. Each character is cut to its own width.
DejaVu fonts: Bitstream Vera license, free to use and to embed drawn from.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

BIG, SMALL = '0123456789:-', 'ADEMPST'
font = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'
big_size = int(sys.argv[2]) if len(sys.argv) > 2 else 40
small_size = int(sys.argv[3]) if len(sys.argv) > 3 else 12


def draw(chars, size):
    """Each character as columns of bits (bit 0 at the top), all cut to the rows the set uses."""
    f = ImageFont.truetype(font, size)
    pics = []
    for ch in chars:
        img = Image.new('1', (size * 2, size * 2), 0)
        d = ImageDraw.Draw(img)
        d.fontmode = '1'  # no grey: the screen has none
        d.text((size // 2, 0), ch, font=f, fill=1)
        pics.append(img)
    boxes = [p.getbbox() for p in pics]
    top, bottom = min(b[1] for b in boxes), max(b[3] for b in boxes)
    out = []
    for p, (left, _, right, _) in zip(pics, boxes):
        px = p.load()
        out.append([sum(1 << (y - top) for y in range(top, bottom) if px[x, y]) for x in range(left, right)])
    return bottom - top, out


def table(o, name, kind, chars, height, glyphs):
    o.write('static const int %s_H = %d;\n' % (name, height))
    o.write('static const char %s_CHARS[] = "%s";\n' % (name, chars))
    o.write('static const %s %s_COLS[] = {\n' % (kind, name))
    starts, at = [], 0
    digits = 8 if kind == 'uint32_t' else 4
    for ch, cols in zip(chars, glyphs):
        starts.append(at)
        at += len(cols)
        o.write('    ' + ', '.join('0x%0*x' % (digits, c) for c in cols) + ',  // %s\n' % ch)
    starts.append(at)
    o.write('};\n')
    o.write('// Where each character\'s columns begin; one more entry than characters, so a width is the difference.\n')
    o.write('static const uint16_t %s_AT[] = {%s};\n\n' % (name, ', '.join(str(s) for s in starts)))


big_h, big = draw(BIG, big_size)
small_h, small = draw(SMALL, small_size)
width = lambda glyphs, chars, text, gap: sum(len(glyphs[chars.index(c)]) + gap for c in text) - gap
widest = max(width(big, BIG, t, 2) for t in ('12:00', '10:08', '12:44')) + 4 + max(width(small, SMALL, t, 1) for t in ('EST', 'EDT', 'AM', 'PM'))
if widest > 128 or big_h > 32 or small_h > 16 or 2 * small_h + 2 > 34:
    sys.exit(f'too large: {widest} px across, figures {big_h} and letters {small_h} px high')
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'main', 'clock_font.hpp')
with open(out, 'w', newline='\n') as o:
    o.write('// The clock slide\'s characters, drawn by tools/make-clock.py (%s, %d and %d px). Do not edit by hand.\n' % (os.path.basename(font), big_size, small_size))
    o.write('// One column per pixel across, bit 0 at the top; each character cut to its own width.\n#pragma once\n#include <cstdint>\n\n')
    table(o, 'CLOCK_BIG', 'uint32_t', BIG, big_h, big)
    table(o, 'CLOCK_SMALL', 'uint16_t', SMALL, small_h, small)
print(f'{out}: figures {big_h} px high, letters {small_h} px, the widest time {widest} px across')
