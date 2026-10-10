// What the server asks of the file system, in one place, so the board can
// answer differently from a computer where it has to.
//
// On a computer this is readdir, stat and stdio. On the board the documents are
// on a FAT32 microSD card (up to 32 GB), and two things there need the FatFS
// library directly instead of the POSIX layer ESP-IDF puts over it:
//
//  - Listing a folder. FAT keeps a file's size and time in its directory entry,
//    so one pass over the directory has everything. But the POSIX layer only
//    hands out names; stat() then looks each name up again from the top of the
//    card, reading the directory from its start every time. For a folder of n
//    files that is n²/2 directory entries read over SPI instead of n.
//  - Files over 2 GB. FAT32 holds files up to 4 GB, but off_t on the board is
//    32 bits and signed: stat() reports such a file's size as negative and
//    fseek() cannot reach past 2 GB. FatFS itself counts in unsigned 32 bits.
//
// The board says which paths are on the card (board_fat_path, in
// esp32/main/board.cpp); anything else, such as the state partition, goes
// through POSIX as on a computer.
#pragma once

#include <dirent.h>
#include <sys/stat.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

#ifdef ESP_PLATFORM
#include "ff.h"
// "/sdcard/hub/a.md" -> "1:/hub/a.md". False for a path that is not on the card.
extern "C" bool board_fat_path(const char *path, char *out, size_t size);
#else
#include <fcntl.h>
#include <sys/statvfs.h>
#endif

namespace fs {

struct Entry {
  const char *name;
  bool dir;          // a folder; otherwise a regular file (anything else is never reported)
  uint64_t size;
  int64_t time;      // changes when the file is written (not necessarily seconds since 1970)
};

#ifdef ESP_PLATFORM
struct FatPath {
  char text[FF_MAX_LFN * 2 + 16];
  bool ok;
  explicit FatPath(const std::string &path) : ok(board_fat_path(path.c_str(), text, sizeof text)) {}
  // The drive itself ("1:" or "1:/"), which f_stat cannot describe.
  bool is_drive() const { const char *c = std::strchr(text, ':'); return c && (c[1] == '\0' || (c[1] == '/' && c[2] == '\0')); }
};
inline int64_t fat_time(const FILINFO &fi) { return static_cast<int64_t>(fi.fdate) << 16 | fi.ftime; }
// Kept out of each() so the path buffer is not on the stack while callers recurse.
inline bool fat_opendir(const std::string &dir, FF_DIR &d, bool &on_card) {
  FatPath fat(dir);
  on_card = fat.ok;
  return fat.ok && f_opendir(&d, fat.text) == FR_OK;
}
#endif

// A size from stat(). On the board st_size is a signed 32-bit number, so a file
// between 2 and 4 GB reads as negative; FAT32 sizes always fit in 32 unsigned bits.
inline uint64_t size_of(const struct stat &st) {
#ifdef ESP_PLATFORM
  return static_cast<uint32_t>(st.st_size);
#else
  return static_cast<uint64_t>(st.st_size);
#endif
}

// Calls fn(const Entry &) for each entry of `dir` but "." and "..". False if
// `dir` cannot be opened. An entry that cannot be described is left out.
template <class Fn>
bool each(const std::string &dir, Fn &&fn) {
#ifdef ESP_PLATFORM
  FF_DIR fd;
  bool on_card;
  bool opened = fat_opendir(dir, fd, on_card);
  if (on_card) {
    if (!opened) return false;
    // Held on the heap: with long names it is about 300 bytes, and callers recurse.
    std::unique_ptr<FILINFO> fi(new FILINFO);
    while (f_readdir(&fd, fi.get()) == FR_OK && fi->fname[0]) {
      Entry e{fi->fname, (fi->fattrib & AM_DIR) != 0, fi->fsize, fat_time(*fi)};
      fn(e);
    }
    f_closedir(&fd);
    return true;
  }
#endif
  DIR *d = ::opendir(dir.c_str());
  if (!d) return false;
  while (dirent *de = ::readdir(d)) {
    const char *name = de->d_name;
    if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) continue;
    struct stat st;
#ifdef ESP_PLATFORM
    if (::stat((dir + "/" + name).c_str(), &st) != 0) continue;
#else
    if (::fstatat(::dirfd(d), name, &st, 0) != 0) continue; // follows links, as stat() does
#endif
    if (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) continue;
    Entry e{name, S_ISDIR(st.st_mode), size_of(st), static_cast<int64_t>(st.st_mtime)};
    fn(e);
  }
  ::closedir(d);
  return true;
}

// What `path` is. False if it does not exist (or is neither a file nor a folder).
inline bool info(const std::string &path, bool &dir, uint64_t &size) {
#ifdef ESP_PLATFORM
  FatPath fat(path);
  if (fat.ok) {
    if (fat.is_drive()) { dir = true; size = 0; return true; }
    FILINFO fi;
    if (f_stat(fat.text, &fi) != FR_OK) return false;
    dir = (fi.fattrib & AM_DIR) != 0;
    size = fi.fsize;
    return true;
  }
#endif
  struct stat st;
  if (::stat(path.c_str(), &st) != 0 || (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode))) return false;
  dir = S_ISDIR(st.st_mode);
  size = size_of(st);
  return true;
}
inline bool file_size(const std::string &path, uint64_t &size) { bool dir; return info(path, dir, size) && !dir; }

// Like lstat(): never follows a link. There are no links on FAT, and ESP-IDF has no lstat.
inline int lstat(const char *path, struct stat *st) {
#ifdef ESP_PLATFORM
  return ::stat(path, st);
#else
  return ::lstat(path, st);
#endif
}

// The size of the disk `path` is on, and how much of it is free.
inline bool space(const std::string &path, uint64_t &total, uint64_t &free) {
#ifdef ESP_PLATFORM
  FatPath fat(path);
  if (!fat.ok) return false;
  char drive[8];
  const char *colon = std::strchr(fat.text, ':');
  size_t n = static_cast<size_t>(colon - fat.text) + 1;
  if (!colon || n >= sizeof drive) return false;
  std::memcpy(drive, fat.text, n);
  drive[n] = '\0';
  // FatFS counts free clusters once (from the card's FSInfo sector if it is
  // trustworthy, otherwise by reading the whole FAT: a few seconds on 32 GB)
  // and keeps the count up to date in memory from then on.
  FATFS *vol;
  DWORD free_clusters;
  if (f_getfree(drive, &free_clusters, &vol) != FR_OK) return false;
#if FF_MAX_SS != FF_MIN_SS
  const uint64_t sector = vol->ssize;
#else
  const uint64_t sector = FF_MAX_SS;
#endif
  total = static_cast<uint64_t>(vol->n_fatent - 2) * vol->csize * sector;
  free = static_cast<uint64_t>(free_clusters) * vol->csize * sector;
  return true;
#else
  struct statvfs v;
  if (::statvfs(path.c_str(), &v) != 0) return false;
  total = static_cast<uint64_t>(v.f_blocks) * static_cast<uint64_t>(v.f_frsize);
  free = static_cast<uint64_t>(v.f_bavail) * static_cast<uint64_t>(v.f_frsize);
  return true;
#endif
}

// A file opened for reading, with positions past 2 GB.
class Reader {
 public:
  Reader() = default;
  Reader(const Reader &) = delete;
  Reader &operator=(const Reader &) = delete;
  ~Reader() { close(); }

  bool open(const std::string &path) {
    close();
#ifdef ESP_PLATFORM
    FatPath fat(path);
    if (fat.ok) {
      fil_.reset(new FIL);
      if (f_open(fil_.get(), fat.text, FA_READ) == FR_OK) return true;
      fil_.reset();
      return false;
    }
#endif
    file_ = std::fopen(path.c_str(), "rb");
    return file_ != nullptr;
  }
  bool seek(uint64_t at) {
#ifdef ESP_PLATFORM
    if (fil_) return at <= 0xFFFFFFFFull && f_lseek(fil_.get(), static_cast<FSIZE_t>(at)) == FR_OK && f_tell(fil_.get()) == at;
    if (file_ && at > 0x7FFFFFFFull) return false;
#endif
    return file_ && ::fseeko(file_, static_cast<off_t>(at), SEEK_SET) == 0;
  }
  // Up to `len` bytes; 0 at the end or on an error.
  size_t read(void *out, size_t len) {
#ifdef ESP_PLATFORM
    if (fil_) {
      UINT got = 0;
      return f_read(fil_.get(), out, static_cast<UINT>(len), &got) == FR_OK ? got : 0;
    }
#endif
    return file_ ? std::fread(out, 1, len, file_) : 0;
  }
  void close() {
#ifdef ESP_PLATFORM
    if (fil_) { f_close(fil_.get()); fil_.reset(); }
#endif
    if (file_) { std::fclose(file_); file_ = nullptr; }
  }

 private:
#ifdef ESP_PLATFORM
  std::unique_ptr<FIL> fil_; // on the heap, only while the file is open
#endif
  FILE *file_ = nullptr;
};

} // namespace fs
