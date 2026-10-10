// A 128 x 64 one-bit picture laid out the way the SSD1306 holds it: 8 rows
// ("pages") of 128 bytes, each byte a column of 8 pixels with bit 0 at the top.
// Drawing into it touches nothing else, so the same code runs on a computer
// (tools/screen-preview.cpp) to see a screen before it goes on the board.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "font.hpp"
#include "title.hpp"

struct Canvas {
  static const int W = 128, H = 64;
  uint8_t px[W * H / 8];

  Canvas() { clear(); }
  void clear() { std::memset(px, 0, sizeof px); }
  void set(int x, int y, bool on = true) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    uint8_t &b = px[(y >> 3) * W + x];
    b = on ? static_cast<uint8_t>(b | (1u << (y & 7))) : static_cast<uint8_t>(b & ~(1u << (y & 7)));
  }
  bool get(int x, int y) const { return x >= 0 && y >= 0 && x < W && y < H && (px[(y >> 3) * W + x] >> (y & 7) & 1); }
  void line(int x0, int y0, int x1, int y1) {
    int dx = std::abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -std::abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      set(x0, y0);
      if (x0 == x1 && y0 == y1) return;
      int e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  void fill(int x, int y, int w, int h, bool on = true) { for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) set(i, j, on); }
  void invert(int x, int y, int w, int h) { for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) set(i, j, !get(i, j)); }
  void frame(int x, int y, int w, int h) { line(x, y, x + w - 1, y); line(x, y + h - 1, x + w - 1, y + h - 1); line(x, y, x, y + h - 1); line(x + w - 1, y, x + w - 1, y + h - 1); }

  // The next character of UTF-8 text as one of the font's: anything outside
  // ASCII shows as "?", once per character rather than once per byte.
  static int glyph(const char *&s) {
    unsigned char c = static_cast<unsigned char>(*s++);
    if (c < 0x80) return c >= 32 && c < 127 ? c : '?';
    while ((static_cast<unsigned char>(*s) & 0xC0) == 0x80) s++;
    return '?';
  }
  // 5x7 text, `scale` times larger; returns where it ended.
  int text(int x, int y, const char *s, int scale = 1, int max_x = W) {
    while (*s) {
      int g = glyph(s);
      if (x + 5 * scale > max_x) break;
      for (int c = 0; c < 5; c++)
        for (int r = 0; r < 7; r++)
          if (FONT5[g - 32][c] >> r & 1) fill(x + c * scale, y + r * scale, scale, scale);
      x += 6 * scale;
    }
    return x;
  }
  static int text_width(const char *s, int scale = 1) {
    int n = 0;
    while (*s) { glyph(s); n++; }
    return n ? n * 6 * scale - scale : 0;
  }
  // Text cut to fit `width` pixels, ending in an ellipsis when cut.
  int text_fit(int x, int y, const char *s, int width) {
    if (text_width(s) <= width) return text(x, y, s);
    int room = (width + 1) / 6 - 1, n = 0;
    const char *p = s;
    while (*p && n < room) { int g = glyph(p); x = draw_glyph(x, y, g); n++; }
    return draw_glyph(x, y, 127);
  }
  int draw_glyph(int x, int y, int g) {
    for (int c = 0; c < 5; c++) for (int r = 0; r < 7; r++) if (FONT5[g - 32][c] >> r & 1) set(x + c, y + r);
    return x + 6;
  }
  // Digits, dots and colons in the 3x5 font (an address); returns where it ended.
  int digits(int x, int y, const char *s) {
    for (; *s; s++) {
      if (*s >= '0' && *s <= '9') { for (int c = 0; c < 3; c++) for (int r = 0; r < 5; r++) if (DIGIT3[*s - '0'][c] >> r & 1) set(x + c, y + r); x += 4; }
      else if (*s == '.') { set(x, y + 4); x += 2; }
      else if (*s == ':') { set(x, y + 1); set(x, y + 3); x += 2; }
    }
    return x;
  }
  static int digits_width(const char *s) {
    int w = 0;
    for (; *s; s++) w += *s >= '0' && *s <= '9' ? 4 : (*s == '.' || *s == ':') ? 2 : 0;
    return w ? w - 1 : 0;
  }
  void title(int x, int y) { for (int c = 0; c < TITLE_W; c++) for (int r = 0; r < TITLE_H; r++) if (TITLE[c] >> r & 1) set(x + c, y + r); }
};
