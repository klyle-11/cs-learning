// Reading a zip file: what is in it, and one entry's bytes.
//
// A zip keeps its list of entries at the end (the "central directory"), after
// the entries themselves. Each entry is either stored as it is (method 0) or
// compressed with DEFLATE (method 8), which is undone here by `inflate`:
// RFC 1951, written out in full below so that nothing has to be brought in.
//
// DEFLATE in a paragraph. The data is a row of blocks. A block is either a
// plain copy of some bytes, or a row of symbols written with Huffman codes
// (short codes for common symbols). A symbol is a byte to write, or "copy
// `length` bytes from `distance` bytes back in what has been written", or
// "end of block". The codes are either the fixed ones in the standard or are
// described at the head of the block, themselves Huffman-coded. Bits are read
// from the low end of each byte; Huffman codes are read a bit at a time, most
// significant bit first.
//
// Not handled: zip64 (files over 4 GB or with over 65535 entries), encryption,
// and methods other than 0 and 8. An EPUB uses none of them.
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace zip {

// ---- inflate -----------------------------------------------------------------

struct Bits {
  const unsigned char *data;
  size_t size, pos = 0;
  uint32_t hold = 0;   // bits read from the data and not yet used, lowest first
  int held = 0;
  bool short_of = false;   // asked for more than there is
  uint32_t get(int need) {
    while (held < need) {
      if (pos >= size) { short_of = true; return 0; }
      hold |= static_cast<uint32_t>(data[pos++]) << held;
      held += 8;
    }
    const uint32_t value = hold & ((1u << need) - 1u);
    hold >>= need;
    held -= need;
    return value;
  }
};

// A Huffman code in its canonical form: how many codes there are of each
// length, and the symbols in order of code. That is all that is needed to
// decode, since codes of one length are consecutive numbers.
struct Huffman {
  uint16_t count[16];
  uint16_t symbol[288];
};
// From each symbol's code length (0: not used). False if the lengths ask for more codes than exist.
inline bool build(Huffman &h, const uint16_t *length, int n) {
  for (uint16_t &c : h.count) c = 0;
  for (int s = 0; s < n; s++) h.count[length[s]]++;
  int left = 1;   // codes still free at this length
  for (int len = 1; len < 16; len++) {
    left <<= 1;
    left -= h.count[len];
    if (left < 0) return false;
  }
  uint16_t offset[16];
  offset[1] = 0;
  for (int len = 1; len < 15; len++) offset[len + 1] = static_cast<uint16_t>(offset[len] + h.count[len]);
  for (int s = 0; s < n; s++) if (length[s]) h.symbol[offset[length[s]]++] = static_cast<uint16_t>(s);
  return true;
}
// The next symbol, or -1 if the bits are no code.
inline int decode(Bits &in, const Huffman &h) {
  int code = 0, first = 0, index = 0;   // first: the first code of this length; index: its place among the symbols
  for (int len = 1; len < 16; len++) {
    code |= static_cast<int>(in.get(1));
    const int count = h.count[len];
    if (code - count < first) return h.symbol[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  return -1;
}
// One block of symbols, written out with the two codes given.
inline bool symbols(Bits &in, std::string &out, size_t max, const Huffman &lit, const Huffman &dist) {
  static const uint16_t len_base[29] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
  static const uint16_t len_extra[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
  static const uint16_t dist_base[30] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
  static const uint16_t dist_extra[30] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
  for (;;) {
    int s = decode(in, lit);
    if (s < 0 || in.short_of) return false;
    if (s < 256) {
      if (out.size() >= max) return false;
      out += static_cast<char>(s);
      continue;
    }
    if (s == 256) return true;
    s -= 257;
    if (s >= 29) return false;
    const size_t length = len_base[s] + in.get(len_extra[s]);
    const int d = decode(in, dist);
    if (d < 0 || d >= 30) return false;
    const size_t back = dist_base[d] + in.get(dist_extra[d]);
    if (in.short_of || back > out.size() || out.size() + length > max) return false;
    // A byte at a time: the copy may run into what it is itself writing ("abab…" is a short string and a long copy).
    for (size_t k = 0, from = out.size() - back; k < length; k++) out += out[from + k];
  }
}
// Undo DEFLATE. `max` is the most that may come out. False if the data is not sound.
inline bool inflate(const unsigned char *data, size_t size, std::string &out, size_t max) {
  Bits in{data, size};
  out.clear();
  if (max <= (64u << 20)) out.reserve(max);   // a zip says how large an entry is, so the room is taken once
  for (bool last = false; !last;) {
    last = in.get(1) != 0;
    const uint32_t type = in.get(2);
    if (in.short_of) return false;
    if (type == 0) {   // bytes as they are, from the next whole byte on
      in.hold = 0;
      in.held = 0;
      if (in.pos + 4 > size) return false;
      const size_t n = static_cast<size_t>(data[in.pos]) | (static_cast<size_t>(data[in.pos + 1]) << 8);
      const size_t check = static_cast<size_t>(data[in.pos + 2]) | (static_cast<size_t>(data[in.pos + 3]) << 8);
      in.pos += 4;
      if ((n ^ check) != 0xFFFF || in.pos + n > size || out.size() + n > max) return false;
      out.append(reinterpret_cast<const char *>(data + in.pos), n);
      in.pos += n;
    } else if (type == 1) {   // the codes fixed by the standard
      static Huffman lit, dist;
      static const bool ready = [] {
        uint16_t length[288];
        for (int s = 0; s < 288; s++) length[s] = static_cast<uint16_t>(s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8);
        build(lit, length, 288);
        for (int s = 0; s < 30; s++) length[s] = 5;
        build(dist, length, 30);
        return true;
      }();
      (void)ready;
      if (!symbols(in, out, max, lit, dist)) return false;
    } else if (type == 2) {   // codes described at the head of the block
      const int nlit = static_cast<int>(in.get(5)) + 257, ndist = static_cast<int>(in.get(5)) + 1, ncode = static_cast<int>(in.get(4)) + 4;
      if (in.short_of || nlit > 286 || ndist > 30) return false;
      // First a small code for the code lengths themselves, its own lengths given in this odd order.
      static const int order[19] = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};
      uint16_t length[320] = {0};
      for (int i = 0; i < ncode; i++) length[order[i]] = static_cast<uint16_t>(in.get(3));
      Huffman code;
      if (in.short_of || !build(code, length, 19)) return false;
      // Then the lengths of the two real codes, written with it. 16: the last length again, 3 to 6 times. 17 and 18: a run of zeros.
      for (int i = 0; i < nlit + ndist;) {
        const int s = decode(in, code);
        if (s < 0 || in.short_of) return false;
        if (s < 16) { length[i++] = static_cast<uint16_t>(s); continue; }
        uint16_t value = 0;
        int repeat;
        if (s == 16) { if (i == 0) return false; value = length[i - 1]; repeat = 3 + static_cast<int>(in.get(2)); }
        else if (s == 17) repeat = 3 + static_cast<int>(in.get(3));
        else repeat = 11 + static_cast<int>(in.get(7));
        if (in.short_of || i + repeat > nlit + ndist) return false;
        while (repeat--) length[i++] = value;
      }
      if (length[256] == 0) return false;   // no way to end the block
      Huffman lit, dist;
      if (!build(lit, length, nlit) || !build(dist, length + nlit, ndist)) return false;
      if (!symbols(in, out, max, lit, dist)) return false;
    } else return false;
  }
  return true;
}

// The checksum a zip keeps of each entry (CRC-32, the polynomial 0xEDB88320).
inline uint32_t crc32(const std::string &bytes) {
  static uint32_t table[256];
  static const bool ready = [] {
    for (uint32_t n = 0; n < 256; n++) {
      uint32_t c = n;
      for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
      table[n] = c;
    }
    return true;
  }();
  (void)ready;
  uint32_t c = 0xFFFFFFFFu;
  for (unsigned char b : bytes) c = table[(c ^ b) & 0xFF] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

// ---- the zip itself --------------------------------------------------------------

struct Entry {
  std::string name;
  unsigned method;
  uint32_t crc, packed, size, offset;   // offset: where its header is in the file
};

inline uint32_t u16(const unsigned char *p) { return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8); }
inline uint32_t u32(const unsigned char *p) { return u16(p) | (u16(p + 2) << 16); }
inline bool read_at(FILE *f, long offset, unsigned char *out, size_t n) {
  return std::fseek(f, offset, SEEK_SET) == 0 && std::fread(out, 1, n, f) == n;
}

// The entries of a zip, from the directory at its end. False if it is not a zip that can be read.
// `max` is the most the list of entries may take to read: on the board, where a
// block of tens of KB is often more than there is free in one piece, a book
// with thousands of entries is not opened rather than failing for memory.
inline bool list(const std::string &file, std::vector<Entry> &out, size_t max = 16u * 1024 * 1024) {
  out.clear();
  FILE *f = std::fopen(file.c_str(), "rb");
  if (!f) return false;
  bool ok = false;
  do {
    if (std::fseek(f, 0, SEEK_END) != 0) break;
    const long size = std::ftell(f);
    if (size < 22) break;
    // The end record is the last thing in the file, but for a comment of up to 65535 bytes after it. Almost every
    // zip has no comment, so the last kilobyte is looked at first, and the whole 64 KB only when it is not there.
    std::vector<unsigned char> tail;
    long span = 0, at = -1;
    for (const long want : {1024L + 22, 65535L + 22}) {
      if (span >= size || (want > 1024 + 22 && static_cast<size_t>(want) > max)) break;
      span = size < want ? size : want;
      tail.resize(static_cast<size_t>(span));
      if (!read_at(f, size - span, tail.data(), tail.size())) { span = size; break; }
      at = span - 22;
      while (at >= 0 && u32(tail.data() + at) != 0x06054b50u) at--;
      if (at >= 0) break;
    }
    if (at < 0) break;
    const unsigned char *end = tail.data() + at;
    const uint32_t count = u16(end + 10), dir_size = u32(end + 12), dir_at = u32(end + 16);
    if (dir_size > 16u * 1024 * 1024 || dir_size > max || static_cast<unsigned long long>(dir_at) + dir_size > static_cast<unsigned long long>(size)) break;
    std::vector<unsigned char>().swap(tail);
    std::vector<unsigned char> dir(dir_size);
    if (dir_size && !read_at(f, static_cast<long>(dir_at), dir.data(), dir.size())) break;
    size_t p = 0;
    ok = true;
    for (uint32_t i = 0; i < count; i++) {
      if (p + 46 > dir.size() || u32(dir.data() + p) != 0x02014b50u) { ok = false; break; }
      const unsigned char *e = dir.data() + p;
      const size_t name = u16(e + 28), extra = u16(e + 30), comment = u16(e + 32);
      if (p + 46 + name > dir.size()) { ok = false; break; }
      out.push_back({std::string(reinterpret_cast<const char *>(e + 46), name), u16(e + 10), u32(e + 16), u32(e + 20), u32(e + 24), u32(e + 42)});
      p += 46 + name + extra + comment;
    }
  } while (false);
  std::fclose(f);
  if (!ok) out.clear();
  return ok;
}

// One entry's bytes. 0, or what went wrong as a status: 404 the file cannot be
// opened, 413 the entry is larger than `max`, 500 the zip is damaged or uses
// something not handled here.
inline int read(const std::string &file, const Entry &e, std::string &out, size_t max) {
  out.clear();
  if (e.size > max || e.packed > max) return 413;
  if (e.method != 0 && e.method != 8) return 500;
  FILE *f = std::fopen(file.c_str(), "rb");
  if (!f) return 404;
  unsigned char head[30];
  std::vector<unsigned char> packed(e.packed);
  // The entry's own header repeats its name; the data follows it.
  bool ok = e.offset < 0x7FFFFFFFu && read_at(f, static_cast<long>(e.offset), head, sizeof head) && u32(head) == 0x04034b50u;
  if (ok) {
    const unsigned long long data_at = static_cast<unsigned long long>(e.offset) + 30 + u16(head + 26) + u16(head + 28);
    ok = data_at < 0x7FFFFFFFull && (packed.empty() || read_at(f, static_cast<long>(data_at), packed.data(), packed.size()));
  }
  std::fclose(f);
  if (!ok) return 500;
  if (e.method == 0) out.assign(reinterpret_cast<const char *>(packed.data()), packed.size());
  else if (!inflate(packed.data(), packed.size(), out, e.size)) return 500;
  return out.size() == e.size && crc32(out) == e.crc ? 0 : 500;
}

inline const Entry *find(const std::vector<Entry> &entries, const std::string &name) {
  for (const Entry &e : entries) if (e.name == name) return &e;
  return nullptr;
}

} // namespace zip
