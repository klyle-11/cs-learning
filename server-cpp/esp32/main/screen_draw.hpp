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

#include <cctype>
#include <cstdio>
#include <cstring>

#include "canvas.hpp"
#include "status.hpp"

struct BoardView {
  char say[3][22] = {"", "", ""};  // lines in place of the device list ("" for none)
  int progress = -1;               // 0 to 100 while an update downloads
  char alert[22] = "";             // stays on the bottom line until cleared (Wi-Fi lost, card removed)
  char name[24] = "";              // the name on the network, "hub.local", if it has one
};

// The star, in thin lines, tall and narrow (it reaches 7 pixels up and down
// and under 4 to the sides): a hollow four-pointed star, out of which four
// short diagonal rays grow and fall back; a dotted diamond, tall like the star,
// opens around it as the rays peak, and a spark twinkles at its right. It stays
// upright: turned, an outline this small stops looking like a star. One cycle
// takes 64 frames, about five seconds at 80 ms a frame.
inline void draw_star(Canvas &c, int cx, int cy, unsigned frame) {
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

// The start the addresses on screen all share, in whole parts and at most the
// first two ("192.168." on a home network): left out of the device list, which
// then shows 192.168.1.23 as "1.23". The line above still shows the board's own
// address whole, so the part left out is in view. 0 if any address differs.
inline size_t shared_start(const HubStatus &s) {
  const char *ref = s.peer_count ? s.peers[0].ip : "";
  size_t n = 0;
  for (int dots = 0; ref[n] && dots < 2; n++) if (ref[n] == '.') dots++;
  if (n == 0 || ref[n - 1] != '.') return 0;
  auto shares = [&](const char *ip) { return std::strncmp(ip, ref, n) == 0; };
  if (s.host[0] && std::isdigit(static_cast<unsigned char>(s.host[0])) && !shares(s.host)) return 0;
  for (int i = 0; i < s.peer_count; i++) if (!shares(s.peers[i].ip)) return 0;
  return n;
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
    const size_t cut = shared_start(s);
    for (int i = 0; i < per_page && page * per_page + i < s.peer_count; i++) {
      const HubPeer &p = s.peers[page * per_page + i];
      int y = top + i * 9;
      if (p.live) c.fill(0, y + 2, 3, 3);
      else { c.set(0, y + 2); c.set(2, y + 2); c.set(0, y + 4); c.set(2, y + 4); }
      const char *ip = p.ip + cut;
      int ip_w = Canvas::digits_width(ip);
      c.text_fit(5, y, p.name, 128 - ip_w - 8);
      c.digits(128 - ip_w, y + 2, ip);
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
