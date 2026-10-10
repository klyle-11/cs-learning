// The star beside the title, design 3 of 3: the burst, the first draft (never
// on a board before), kept to compare. Chosen in menuconfig, Hub; the others
// are star_tall.hpp and star_wide.hpp.
//
// Two stars, in thin lines: the main one, points up, down and to the sides,
// breathing a little larger and smaller; a second, smaller one, turned by an
// eighth, grows out of it and shrinks back, so that for a moment it is an
// eight-pointed star; a dotted diamond ring opens around them as the two meet,
// and two sparks twinkle at opposite corners. One cycle takes 64 frames, about
// five seconds at 80 ms a frame.
#pragma once

#include <cmath>

#include "canvas.hpp"

inline void draw_star_burst(Canvas &c, int cx, int cy, unsigned frame) {
  const float pi = 3.14159265f, t = static_cast<float>(frame % 64) / 64.0f;
  auto star = [&](float outer, float inner, float turn) {
    int xs[8], ys[8];
    for (int i = 0; i < 8; i++) {
      const float a = turn + static_cast<float>(i) * pi / 4, r = i % 2 ? inner : outer;
      xs[i] = cx + static_cast<int>(std::lround(r * std::sin(a)));
      ys[i] = cy - static_cast<int>(std::lround(r * std::cos(a)));
    }
    for (int i = 0; i < 8; i++) c.line(xs[i], ys[i], xs[(i + 1) % 8], ys[(i + 1) % 8]);
  };
  const float grow = std::sin(pi * t);                  // 0 -> 1 -> 0
  const float breathe = 7.0f + 0.6f * std::cos(2 * pi * t);
  star(breathe, 1.8f, 0);                               // the main star
  if (grow > 0.15f) star(5.2f * grow, 1.4f, pi / 4);   // the diagonal one
  if (t > 0.35f && t < 0.65f) {                         // the ring, opening while both are large
    const int r = static_cast<int>(4.0f + 16.0f * (t - 0.35f));
    for (int i = 0; i <= r; i += 2) {                   // dotted, so it reads as light rather than a frame
      c.set(cx + i, cy - (r - i)); c.set(cx - i, cy + (r - i)); c.set(cx + (r - i), cy + i); c.set(cx - (r - i), cy - i);
    }
  }
  c.set(cx, cy);
  const unsigned spark = frame % 32;                    // two sparks, each lit briefly in turn
  if (spark < 3) { c.set(cx + 7, cy - 6); c.set(cx + 8, cy - 6); c.set(cx + 7, cy - 7); }
  if (spark >= 16 && spark < 19) { c.set(cx - 7, cy + 6); c.set(cx - 8, cy + 6); c.set(cx - 7, cy + 7); }
}
