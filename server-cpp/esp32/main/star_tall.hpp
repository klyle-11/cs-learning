// The star beside the title, design 1 of 3: tall and narrow (the one in use;
// the others are star_wide.hpp and star_burst.hpp, chosen in menuconfig, Hub).
//
// In thin lines, it reaches 7 pixels up and down and under 4 to the sides: a
// hollow four-pointed star, out of which four short diagonal rays grow and fall
// back; a dotted diamond, tall like the star, opens around it as the rays peak,
// and a spark twinkles at its right. It stays upright: turned, an outline this
// small stops looking like a star. One cycle takes 64 frames, about five
// seconds at 80 ms a frame.
#pragma once

#include <cmath>

#include "canvas.hpp"

inline void draw_star_tall(Canvas &c, int cx, int cy, unsigned frame) {
  const float pi = 3.14159265f, t = static_cast<float>(frame % 64) / 64.0f;
  const float up = 7.4f, side = 3.6f, waist = 1.9f, narrow = 0.7f; // narrow: how much the waist and rays are pulled in sideways
  auto at = [&](float r, float a, float sx, int &x, int &y) {
    x = cx + static_cast<int>(std::lround(r * std::sin(a) * sx));
    y = cy - static_cast<int>(std::lround(r * std::cos(a)));
  };
  int xs[8], ys[8];
  for (int i = 0; i < 8; i++) {
    const float a = static_cast<float>(i) * pi / 4;
    if (i % 2) at(waist, a, narrow, xs[i], ys[i]);
    else at(i % 4 == 0 ? up : side, a, 1, xs[i], ys[i]);
  }
  for (int i = 0; i < 8; i++) c.line(xs[i], ys[i], xs[(i + 1) % 8], ys[(i + 1) % 8]);
  c.set(cx, cy);
  const float grow = std::sin(pi * t);
  if (grow > 0.1f) for (int i = 0; i < 4; i++) { // the rays, between the points
    int x0, y0, x1, y1;
    const float a = pi / 4 + static_cast<float>(i) * pi / 2;
    at(waist + 1.0f, a, narrow, x0, y0);
    at(waist + 1.0f + 2.4f * grow, a, narrow, x1, y1);
    c.line(x0, y0, x1, y1);
  }
  if (t > 0.4f && t < 0.7f) { // the diamond, opening: as tall as it is twice wide
    const int r = 5 + static_cast<int>(20.0f * (t - 0.4f));
    for (int i = 0; i <= r; i += 2) {
      const int dx = i / 2, dy = r - i;
      c.set(cx + dx, cy - dy); c.set(cx - dx, cy + dy); c.set(cx + dx, cy + dy); c.set(cx - dx, cy - dy);
    }
  }
  const unsigned spark = frame % 40; // a pixel, a small cross, a pixel
  for (int k = 0; k < 2; k++) {
    const unsigned s0 = k ? 20 : 0;
    const int sx = cx + 6, sy = k ? cy + 5 : cy - 5;
    if (spark >= s0 && spark < s0 + 4) c.set(sx, sy);
    if (spark == s0 + 1 || spark == s0 + 2) { c.set(sx - 1, sy); c.set(sx + 1, sy); c.set(sx, sy - 1); c.set(sx, sy + 1); }
  }
}
