// What the screen shows, drawn from the server's status (status.hpp) and the
// board's own (BoardView). Kept apart from the driver so a computer can draw
// it too: tools/screen-preview.cpp.
//
//   Learner-servr           ✦     the title in serif, the star beside it (star_*.hpp)
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
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "canvas.hpp"
#include "star_burst.hpp"
#include "star_tall.hpp"
#include "star_wide.hpp"
#include "status.hpp"

struct BoardView {
  char say[3][22] = {"", "", ""};  // lines in place of the device list ("" for none)
  int progress = -1;               // 0 to 100 while an update downloads
  char alert[22] = "";             // stays on the bottom line until cleared (Wi-Fi lost, card removed)
  char name[24] = "";              // the name on the network, "hub.local", if it has one
};

// The star beside the title: three designs, one file each, to compare and
// choose (menuconfig, Hub, "Star beside the title"; for PlatformIO a define in
// platformio.ini). The tall one unless another is chosen; "take turns" shows
// each for one cycle in turn (tall, wide, burst), to compare on the board.
inline void draw_star(Canvas &c, int cx, int cy, unsigned frame) {
#if defined(CONFIG_HUB_STAR_WIDE)
  draw_star_wide(c, cx, cy, frame);
#elif defined(CONFIG_HUB_STAR_BURST)
  draw_star_burst(c, cx, cy, frame);
#elif defined(CONFIG_HUB_STAR_TURNS)
  static void (*const stars[])(Canvas &, int, int, unsigned) = {draw_star_tall, draw_star_wide, draw_star_burst};
  stars[frame / 64 % 3](c, cx, cy, frame);
#else
  draw_star_tall(c, cx, cy, frame);
#endif
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
  // The diamonds reach a row or two below the title's band: cut there, so the
  // star stays in the top 16 rows (yellow on two-colour screens) and clear of
  // the address.
  c.fill(104, 16, 24, 8, false);

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

// What the screen says, as a number that changes when it does: the screen
// below the title drawn as at frame 0, and every device, the ones on later
// pages too. What moves by itself (the star, the address and the name taking
// turns, the pages turning over) leaves it alone, so ten minutes of the same
// number means nothing new to show (screen.cpp dims it then). Draws into `c`.
inline uint32_t screen_sum(Canvas &c, const HubStatus &s, const BoardView &b) {
  uint32_t sum = 2166136261u; // FNV-1a
  auto mix = [&sum](const char *p, size_t n) { for (size_t i = 0; i < n && p[i]; i++) sum = (sum ^ static_cast<uint8_t>(p[i])) * 16777619u; };
  draw_screen(c, s, b, 0);
  for (size_t i = 2 * Canvas::W; i < sizeof c.px; i++) sum = (sum ^ c.px[i]) * 16777619u;
  for (int i = 0; i < s.peer_count; i++) {
    mix(s.peers[i].name, sizeof s.peers[i].name);
    mix(s.peers[i].ip, sizeof s.peers[i].ip);
    sum = (sum ^ (s.peers[i].live ? 1u : 2u)) * 16777619u;
  }
  return sum;
}
