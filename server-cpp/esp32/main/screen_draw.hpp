// What the screen shows, drawn from the server's status (status.hpp) and the
// board's own (BoardView). Kept apart from the driver so a computer can draw
// it too: tools/screen-preview.cpp.
//
//   Learner-servr           ✦     the title in serif, the star turning beside it
//   192.168.1.42:443              where to point a browser (alternating with hub.local)
//   ·························
//   ● Kai's iPhone   192.168.1.23 devices with a page open (●) or heard from lately (○)
//   ○ laptop         192.168.1.40
//
// While a pairing code is on offer it takes the lower part, large, with the
// start of the certificate fingerprint to compare. Messages from the board
// (starting up, no card, an update) take it otherwise; short notices ("Paired:
// …") cover the bottom line for a few seconds.
#pragma once

#include <cstdio>

#include "canvas.hpp"
#include "status.hpp"

struct BoardView {
  char say[3][22] = {"", "", ""};  // lines in place of the device list ("" for none)
  int progress = -1;               // 0 to 100 while an update downloads
  char alert[22] = "";             // stays on the bottom line until cleared (Wi-Fi lost, card removed)
  char name[24] = "";              // the name on the network, "hub.local", if it has one
};

// The star, in thin lines: a hollow four-pointed one, out of which four
// diagonal rays grow and fall back, so that for a moment it is an eight-pointed
// compass star; a dotted diamond opens around it as the rays peak, and a spark
// twinkles at its right. It stays upright: turned, an outline this small
// stops looking like a star. One cycle takes 64 frames, about five seconds at
// 80 ms a frame.
inline void draw_star(Canvas &c, int cx, int cy, unsigned frame) {
  const float pi = 3.14159265f, t = static_cast<float>(frame % 64) / 64.0f;
  const float turn = 0;
  auto at = [&](float r, float a, int &x, int &y) {
    x = cx + static_cast<int>(std::lround(r * std::sin(a)));
    y = cy - static_cast<int>(std::lround(r * std::cos(a)));
  };
  for (int i = 0; i < 8; i++) { // the outline: tips at 7 pixels, the waist at 2.6
    int x0, y0, x1, y1;
    at(i % 2 ? 2.6f : 7.0f, turn + static_cast<float>(i) * pi / 4, x0, y0);
    at((i + 1) % 2 ? 2.6f : 7.0f, turn + static_cast<float>(i + 1) * pi / 4, x1, y1);
    c.line(x0, y0, x1, y1);
  }
  c.set(cx, cy);
  const float grow = std::sin(pi * t);
  if (grow > 0.1f) for (int i = 0; i < 4; i++) { // the rays, between the points
    int x0, y0, x1, y1;
    float a = turn + pi / 4 + static_cast<float>(i) * pi / 2;
    at(3.2f, a, x0, y0);
    at(3.2f + 3.2f * grow, a, x1, y1);
    c.line(x0, y0, x1, y1);
  }
  if (t > 0.4f && t < 0.7f) { // the diamond, opening
    int r = 5 + static_cast<int>(20.0f * (t - 0.4f));
    for (int i = 0; i <= r; i += 2) { c.set(cx + i, cy - (r - i)); c.set(cx - i, cy + (r - i)); c.set(cx + (r - i), cy + i); c.set(cx - (r - i), cy - i); }
  }
  const unsigned spark = frame % 40; // a pixel, a small cross, a pixel
  for (int k = 0; k < 2; k++) {
    unsigned s0 = k ? 20 : 0;
    int sx = cx + 7, sy = k ? cy + 6 : cy - 6;
    if (spark >= s0 && spark < s0 + 4) c.set(sx, sy);
    if (spark == s0 + 1 || spark == s0 + 2) { c.set(sx - 1, sy); c.set(sx + 1, sy); c.set(sx, sy - 1); c.set(sx, sy + 1); }
  }
}

inline void draw_screen(Canvas &c, const HubStatus &s, const BoardView &b, unsigned frame) {
  c.clear();
  c.title(0, 2);
  draw_star(c, 118, 7, frame);

  // Where to find it: the address, and every few seconds the name instead.
  char line[64];
  if (s.running && s.host[0]) {
    bool show_name = b.name[0] && frame / 40 % 2 == 1;
    const char *host = show_name ? b.name : s.host;
    if (s.port == (s.tls ? 443 : 80)) std::snprintf(line, sizeof line, "%s", host);
    else std::snprintf(line, sizeof line, "%s:%d", host, s.port);
    c.text_fit(0, 17, line, 128);
  } else {
    c.text(0, 17, "starting...");
  }
  for (int x = 0; x < 128; x += 2) c.set(x, 26);

  const int top = 29;
  if (b.say[0][0]) {
    for (int i = 0; i < 3; i++) c.text_fit(0, top + i * 10, b.say[i], 128);
  } else if (b.progress >= 0) {
    c.text(0, top, "Updating");
    std::snprintf(line, sizeof line, "%d%%", b.progress);
    c.text(128 - Canvas::text_width(line), top, line);
    c.frame(0, top + 12, 128, 9);
    c.fill(2, top + 14, 124 * b.progress / 100, 5);
    c.text(0, top + 25, "Do not unplug");
  } else if (s.pair_code[0]) {
    c.text(0, top, "Pairing code");
    std::snprintf(line, sizeof line, "%d:%02d", s.pair_seconds / 60, s.pair_seconds % 60);
    c.text(128 - Canvas::text_width(line), top, line);
    c.text((128 - Canvas::text_width(s.pair_code, 2)) / 2, top + 11, s.pair_code, 2);
    if (s.fingerprint[0]) { std::snprintf(line, sizeof line, "CA %.17s", s.fingerprint); c.text(0, 56, line); }
  } else if (s.peer_count == 0) {
    c.text(0, top, s.running ? "No one connected" : "");
    if (s.running && s.free) {
      std::snprintf(line, sizeof line, "%.1f GB free on card", static_cast<double>(s.free) / (1024.0 * 1024.0 * 1024.0));
      c.text_fit(0, top + 10, line, 128);
    }
  } else {
    // Four to a page; more turn over every four seconds, with a dot per page on the dotted line.
    const int per_page = 4, pages = (s.peer_count + per_page - 1) / per_page, page = static_cast<int>(frame / 50) % pages;
    for (int i = 0; i < per_page && page * per_page + i < s.peer_count; i++) {
      const HubPeer &p = s.peers[page * per_page + i];
      int y = top + i * 9;
      if (p.live) c.fill(0, y + 2, 3, 3);
      else { c.set(0, y + 2); c.set(2, y + 2); c.set(0, y + 4); c.set(2, y + 4); }
      int ip_w = Canvas::digits_width(p.ip);
      c.text_fit(5, y, p.name, 128 - ip_w - 8);
      c.digits(128 - ip_w, y + 2, p.ip);
    }
    if (pages > 1) for (int i = 0; i < pages; i++) c.fill(127 - (pages - 1 - i) * 4 - 1, 25, 2, 3, i == page);
  }

  // A notice or an alert on the bottom line, shown reversed.
  const char *bottom = b.alert[0] ? b.alert : s.notice;
  if (bottom[0]) {
    int w = Canvas::text_width(bottom);
    c.fill(0, 55, 128, 9, false);
    c.text(w < 128 ? (128 - w) / 2 : 0, 56, bottom);
    c.invert(0, 55, 128, 9);
  }
}
