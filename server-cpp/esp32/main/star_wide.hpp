// The star beside the title, design 2 of 3: wide, the earlier one (as first
// shown, before the tall one replaced it), kept to compare. Chosen in
// menuconfig, Hub; the others are star_tall.hpp and star_burst.hpp.
//
// In thin lines, as wide as it is tall (7 pixels each way): a hollow
// four-pointed star, out of which four diagonal rays grow and fall back, so
// that for a moment it is an eight-pointed compass star; a dotted diamond, as
// wide as it is tall, opens around it as the rays peak, and a spark twinkles at
// its right. One cycle takes 64 frames, about five seconds at 80 ms a frame.
#pragma once

#include <cmath>

#include "canvas.hpp"

inline void draw_star_wide(Canvas &c, int cx, int cy, unsigned frame) {
  const float pi = 3.14159265f, t = static_cast<float>(frame % 64) / 64.0f;
  auto at = [&](float r, float a, int &x, int &y) {
    x = cx + static_cast<int>(std::lround(r * std::sin(a)));
    y = cy - static_cast<int>(std::lround(r * std::cos(a)));
  };
  for (int i = 0; i < 8; i++) { // the outline: tips at 7 pixels, the waist at 2.6
    int x0, y0, x1, y1;
    at(i % 2 ? 2.6f : 7.0f, static_cast<float>(i) * pi / 4, x0, y0);
    at((i + 1) % 2 ? 2.6f : 7.0f, static_cast<float>(i + 1) * pi / 4, x1, y1);
    c.line(x0, y0, x1, y1);
  }
  c.set(cx, cy);
  const float grow = std::sin(pi * t);
  if (grow > 0.1f) for (int i = 0; i < 4; i++) { // the rays, between the points
    int x0, y0, x1, y1;
    const float a = pi / 4 + static_cast<float>(i) * pi / 2;
    at(3.2f, a, x0, y0);
    at(3.2f + 3.2f * grow, a, x1, y1);
    c.line(x0, y0, x1, y1);
  }
  if (t > 0.4f && t < 0.7f) { // the diamond, opening
    const int r = 5 + static_cast<int>(20.0f * (t - 0.4f));
    for (int i = 0; i <= r; i += 2) { c.set(cx + i, cy - (r - i)); c.set(cx - i, cy + (r - i)); c.set(cx + (r - i), cy + i); c.set(cx - (r - i), cy - i); }
  }
  const unsigned spark = frame % 40; // a pixel, a small cross, a pixel
  for (int k = 0; k < 2; k++) {
    const unsigned s0 = k ? 20 : 0;
    const int sx = cx + 7, sy = k ? cy + 6 : cy - 6;
    if (spark >= s0 && spark < s0 + 4) c.set(sx, sy);
    if (spark == s0 + 1 || spark == s0 + 2) { c.set(sx - 1, sy); c.set(sx + 1, sy); c.set(sx, sy - 1); c.set(sx, sy + 1); }
  }
}
