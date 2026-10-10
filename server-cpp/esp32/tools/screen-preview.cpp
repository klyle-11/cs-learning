// Draws the board's screen on a computer, as PNG files, to see a change to the
// layout or the star before flashing it.
//
//   c++ -std=c++17 -I main -I ../src tools/screen-preview.cpp -o /tmp/screen-preview
//   /tmp/screen-preview out-dir      -> out-dir/devices.png, pairing.png, ..., star-00.png ... star-63.png
//
// Pixels are drawn 4 times larger, in the yellow-over-blue of the two-colour
// 0.96" modules (the top 16 rows yellow); single-colour ones look the same in one colour.
#include <cstdio>
#include <string>
#include <vector>

#include "screen_draw.hpp"

// A PNG with no compression: just enough of the format to be opened anywhere.
static uint32_t crc(const unsigned char *p, size_t n, uint32_t c = 0xffffffffu) {
  for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1; }
  return c;
}
static void chunk(FILE *f, const char *type, const std::vector<unsigned char> &data) {
  unsigned char len[4] = {static_cast<unsigned char>(data.size() >> 24), static_cast<unsigned char>(data.size() >> 16), static_cast<unsigned char>(data.size() >> 8), static_cast<unsigned char>(data.size())};
  std::fwrite(len, 1, 4, f);
  std::vector<unsigned char> body(type, type + 4);
  body.insert(body.end(), data.begin(), data.end());
  std::fwrite(body.data(), 1, body.size(), f);
  uint32_t c = crc(body.data(), body.size()) ^ 0xffffffffu;
  unsigned char cb[4] = {static_cast<unsigned char>(c >> 24), static_cast<unsigned char>(c >> 16), static_cast<unsigned char>(c >> 8), static_cast<unsigned char>(c)};
  std::fwrite(cb, 1, 4, f);
}
static void save_png(const std::string &path, const Canvas &c, int scale = 4) {
  const int w = Canvas::W * scale + 16, h = Canvas::H * scale + 16;
  std::vector<unsigned char> raw;
  for (int y = 0; y < h; y++) {
    raw.push_back(0);
    for (int x = 0; x < w; x++) {
      int sx = (x - 8) / scale, sy = (y - 8) / scale;
      bool inside = x >= 8 && y >= 8 && sx < Canvas::W && sy < Canvas::H;
      bool on = inside && c.get(sx, sy) && (x - 8) % scale != scale - 1 && (y - 8) % scale != scale - 1;
      unsigned char r = 12, g = 12, b = 16;
      if (on) { if (sy < 16) { r = 255; g = 214; b = 64; } else { r = 96; g = 196; b = 255; } }
      raw.push_back(r); raw.push_back(g); raw.push_back(b);
    }
  }
  std::vector<unsigned char> z = {0x78, 0x01};
  uint32_t a = 1, bsum = 0;
  for (unsigned char ch : raw) { a = (a + ch) % 65521; bsum = (bsum + a) % 65521; }
  for (size_t i = 0; i < raw.size(); i += 65535) {
    size_t n = std::min<size_t>(65535, raw.size() - i);
    z.push_back(i + n == raw.size());
    z.push_back(n & 0xff); z.push_back(n >> 8); z.push_back(~n & 0xff); z.push_back((~n >> 8) & 0xff);
    z.insert(z.end(), raw.begin() + static_cast<long>(i), raw.begin() + static_cast<long>(i + n));
  }
  uint32_t ad = (bsum << 16) | a;
  z.push_back(ad >> 24); z.push_back(ad >> 16); z.push_back(ad >> 8); z.push_back(ad);
  FILE *f = std::fopen(path.c_str(), "wb");
  if (!f) { std::perror(path.c_str()); return; }
  static const unsigned char sig[8] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  std::fwrite(sig, 1, 8, f);
  std::vector<unsigned char> ihdr = {0, 0, static_cast<unsigned char>(w >> 8), static_cast<unsigned char>(w), 0, 0, static_cast<unsigned char>(h >> 8), static_cast<unsigned char>(h), 8, 2, 0, 0, 0};
  chunk(f, "IHDR", ihdr);
  chunk(f, "IDAT", z);
  chunk(f, "IEND", {});
  std::fclose(f);
}

int main(int argc, char **argv) {
  std::string dir = argc > 1 ? argv[1] : ".";
  HubStatus s;
  s.running = true;
  std::snprintf(s.host, sizeof s.host, "192.168.1.42");
  s.port = 443;
  s.tls = true;
  std::snprintf(s.fingerprint, sizeof s.fingerprint, "3F:A2:91:0C:7E:55:D4:18");
  s.free = 28ull * 1024 * 1024 * 1024 + 400ull * 1024 * 1024;
  BoardView b;
  std::snprintf(b.name, sizeof b.name, "hub.local");
  Canvas c;

  draw_screen(c, s, b, 10);
  save_png(dir + "/nobody.png", c);

  const char *names[] = {"Kai's iPhone", "laptop", "Study tablet with a long name", "desktop", "phone 2", "e-reader"};
  const char *ips[] = {"192.168.1.23", "192.168.1.40", "192.168.1.101", "192.168.1.7", "192.168.1.55", "192.168.1.200"};
  for (int i = 0; i < 6; i++) {
    std::snprintf(s.peers[i].name, sizeof s.peers[i].name, "%s", names[i]);
    std::snprintf(s.peers[i].ip, sizeof s.peers[i].ip, "%s", ips[i]);
    s.peers[i].live = i < 3;
  }
  s.peer_count = 3;
  draw_screen(c, s, b, 10);
  save_png(dir + "/devices.png", c);
  draw_screen(c, s, b, 50); // the name instead of the address
  save_png(dir + "/devices-name.png", c);
  s.peer_count = 6;
  draw_screen(c, s, b, 60);
  save_png(dir + "/devices-page2.png", c);

  std::snprintf(s.notice, sizeof s.notice, "Paired: Kai's iPhone");
  s.peer_count = 2;
  draw_screen(c, s, b, 10);
  save_png(dir + "/notice.png", c);
  s.notice[0] = 0;

  std::snprintf(s.pair_code, sizeof s.pair_code, "K7QM-2XRF");
  s.pair_seconds = 581;
  draw_screen(c, s, b, 10);
  save_png(dir + "/pairing.png", c);
  s.pair_code[0] = 0;

  b.progress = 45;
  draw_screen(c, s, b, 10);
  save_png(dir + "/update.png", c);
  b.progress = -1;

  HubStatus booting;
  std::snprintf(b.say[0], sizeof b.say[0], "No SD card found.");
  std::snprintf(b.say[1], sizeof b.say[1], "Insert a FAT32 card;");
  std::snprintf(b.say[2], sizeof b.say[2], "trying again...");
  draw_screen(c, booting, b, 10);
  save_png(dir + "/no-card.png", c);
  b = BoardView();
  std::snprintf(b.alert, sizeof b.alert, "Wi-Fi lost: rejoining");
  draw_screen(c, s, b, 10);
  save_png(dir + "/wifi-lost.png", c);

  for (unsigned f = 0; f < 64; f++) {
    Canvas star;
    draw_star(star, 118, 7, f);
    char name[32];
    std::snprintf(name, sizeof name, "/star-%02u.png", f);
    save_png(dir + name, star);
  }
  std::printf("written to %s\n", dir.c_str());
}
