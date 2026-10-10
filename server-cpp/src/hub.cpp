// The hub's server, in C++: the same HTTP API as hub/server.js (see ../API.md),
// serving the same hub/index.html.
//
//   hubd <folder> [--port 4321] [--host 127.0.0.1] [--www <folder>/hub] [--profile desktop|small|esp32]
//        [--state <dir>] [--tls] [--insecure-http] [--pair-local] [--allow-host <name>] [--quota-mb <n>]
//   hubd --make-cert [--state <dir>] [--allow-host <name>]
//
// Who may use it (see ../API.md, "Security"): requests must name a host this
// machine really has, must not come from another website, and, unless they come
// from this machine itself, must carry the token of a paired device. Beyond
// this machine the server only speaks HTTPS.
//
// File access goes through dirent/stat/stdio, which ESP-IDF maps onto an SD
// card, and through fs.hpp where the card needs FatFS itself (listing folders,
// files over 2 GB), so these handlers run on the ESP32 unchanged.
#include <dirent.h>
#include <sys/stat.h>
#ifndef ESP_PLATFORM
#include <ifaddrs.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <ctime>
#include <mutex>
#include <set>
#include <sstream>
#include <string_view>
#include <vector>

#include "../vendor/cJSON.h"
#include "http.hpp"

using std::string;
using Strings = std::vector<string>;

static string ROOT;                    // the folder of documents
static string WWW;                     // where index.html and the vendor scripts live
static string STATE;                   // certificates and the list of paired devices: never inside ROOT
static const char *FRONT = "FRONTPAGE.md";
static const size_t MAX_JSON = 1 << 20;          // 1 MB for API bodies

// What the server allows itself depends on what it is running on. The profile
// is picked once at start-up (see detect_profile) and can be forced with --profile.
struct Profile {
  const char *name;
  size_t max_upload;   // largest file accepted by /api/upload
  // Nothing but this server changes the folder (a card in the board). It then
  // tells open pages about its own changes and keeps its own count of what is
  // stored, and never looks the folder over for changes made by others.
  bool sole_writer;
  int watch_ms;        // otherwise: how often the folder is looked over for changes
  bool cache_assets;   // keep index.html and the scripts in memory between requests
  bool cache_listing;  // keep the document list until a file changes...
  bool listing_on_disk;// ...in a file beside the documents instead of in memory
  int max_conns;       // connections served at once (each TLS connection costs tens of KB)
  int max_streams;     // open pages listening for changes
  size_t piece;        // bytes moved at a time when sending or receiving a file
  long keepalive_ms;   // how long an idle connection is kept
  unsigned long long quota_mb; // most the folder may hold in total; 0: whatever the disk has free
  size_t sort_budget;  // most memory spent on names to sort the folders for the list; 0: no limit
};
static const Profile PROFILES[] = {
    {"desktop", 200u << 20, false, 500, true, true, false, 64, 16, 64 * 1024, 5000, 20480, 0}, // a computer: plenty of memory, fast disk
    {"small", 50u << 20, false, 1000, true, true, false, 24, 8, 16 * 1024, 5000, 8192, 0},     // a Raspberry Pi class board: under 1 GB of memory
    // A microcontroller with a microSD card (FAT32, up to 32 GB) and a few hundred KB of memory.
    // The card is the limit: no quota of its own.
    {"esp32", 4u << 20, true, 0, false, true, true, 4, 2, 4 * 1024, 2000, 0, 32 * 1024},
};
static Profile profile = PROFILES[0];
static unsigned device_cores = 1;
static unsigned long long device_memory_mb = 0;
static std::mutex store_lock;                    // one writer at a time to notes and settings

// ---- small helpers ----------------------------------------------------------

static bool ends_with(const string &s, const string &tail) {
  return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0;
}
static bool starts_with(const string &s, const string &head) { return s.compare(0, head.size(), head) == 0; }
static string basename_of(const string &p) { size_t i = p.rfind('/'); return i == string::npos ? p : p.substr(i + 1); }
static string dirname_of(const string &p) { size_t i = p.rfind('/'); return i == string::npos ? "" : p.substr(0, i); }
static string ext_of(const string &name) { size_t i = name.rfind('.'); return i == string::npos || i == 0 ? "" : name.substr(i); }
static string lower(string s) { for (char &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return s; }
static string trim(const string &s) {
  size_t a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
  return a == string::npos ? "" : s.substr(a, b - a + 1);
}

// Trimmed, with every run of whitespace reduced to one space.
static string squeeze(const string &s) {
  string out;
  for (char c : trim(s)) {
    bool space = std::isspace(static_cast<unsigned char>(c)) != 0;
    if (space && !out.empty() && out.back() == ' ') continue;
    out += space ? ' ' : c;
  }
  return out;
}

static bool is_file(const string &p) { struct stat st; return ::stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode); }
static bool is_dir(const string &p) { struct stat st; return ::stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode); }

// A whole file as a string. The size is asked first so the text is held once,
// not grown and copied (the notes file is read on every note saved).
static bool read_file(const string &p, string &out) {
  FILE *f = std::fopen(p.c_str(), "rb");
  if (!f) return false;
  out.clear();
  if (std::fseek(f, 0, SEEK_END) == 0) {
    long n = std::ftell(f);
    if (n > 0) out.reserve(static_cast<size_t>(n));
    std::rewind(f);
  }
  char chunk[1024];
  size_t n;
  while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) out.append(chunk, n);
  bool ok = !std::ferror(f);
  std::fclose(f);
  return ok;
}
static void make_dirs(const string &dir) {
  for (size_t i = 1; i <= dir.size(); i++) {
    if (i == dir.size() || dir[i] == '/') ::mkdir(dir.substr(0, i).c_str(), 0755);
  }
}
// Every change this server makes to the folder is reported here: it keeps the
// count of what is stored and, on the board, tells open pages (see "how much is
// stored" and "live reload" below).
static void changed(const string &abs, long long delta);

// Write to a temporary file and rename, so a crash or power cut never leaves a
// half-written file behind. `tail` is written after `data`.
static bool write_file(const string &p, const char *data, size_t len, const char *tail = "") {
  make_dirs(dirname_of(p));
  uint64_t before = 0;
  fs::file_size(p, before);
  string tmp = p + ".tmp";
  FILE *f = std::fopen(tmp.c_str(), "wb");
  if (!f) return false;
  const size_t more = std::strlen(tail);
  bool ok = std::fwrite(data, 1, len, f) == len && std::fwrite(tail, 1, more, f) == more;
  ok = std::fclose(f) == 0 && ok;
  if (!ok || !secure::replace(tmp, p)) { ::unlink(tmp.c_str()); return false; }
  changed(p, static_cast<long long>(len + more) - static_cast<long long>(before));
  return true;
}
static bool write_file(const string &p, const string &data) { return write_file(p, data.data(), data.size()); }
// A JSON tree saved as text, the text held once (not also copied into a string).
static bool write_json(const string &p, const cJSON *node) {
  char *text = cJSON_Print(node);
  if (!text) return false;
  bool ok = write_file(p, text, std::strlen(text), "\n");
  cJSON_free(text);
  return ok;
}

// Delete a folder and everything in it. Links are removed, never followed.
// What the removed files held is added to `freed`.
static bool remove_tree(const string &dir, unsigned long long &freed) {
  DIR *d = ::opendir(dir.c_str());
  if (!d) return false;
  bool ok = true;
  while (struct dirent *e = ::readdir(d)) {
    string name = e->d_name;
    if (name == "." || name == "..") continue;
    string abs = dir + "/" + name;
    struct stat st;
    if (fs::lstat(abs.c_str(), &st) != 0) { ok = false; continue; }
    if (S_ISDIR(st.st_mode)) ok = remove_tree(abs, freed) && ok;
    else if (::unlink(abs.c_str()) == 0) freed += S_ISREG(st.st_mode) ? fs::size_of(st) : 0;
    else ok = false;
  }
  ::closedir(d);
  return ::rmdir(dir.c_str()) == 0 && ok;
}

// A path sent by a client, split into parts. Rejects anything that could step
// outside the folder ("..", empty or absolute parts) and, when asked, hidden
// files and node_modules.
static bool clean_parts(const string &rel, Strings &parts, bool strict) {
  parts.clear();
  std::stringstream ss(rel);
  string part;
  while (std::getline(ss, part, '/')) {
    if (part.empty() || part == ".") continue;
    if (part == ".." || part.find('\\') != string::npos || part.find('\0') != string::npos) return false;
    if (strict && (part[0] == '.' || part == "node_modules")) return false;
    parts.push_back(part);
  }
  return !parts.empty();
}
static string join(const Strings &parts) {
  string out;
  for (const string &p : parts) out += (out.empty() ? "" : "/") + p;
  return out;
}

static const Strings CODE_EXT = {".c", ".h", ".cpp", ".hpp", ".cc", ".py", ".js", ".ts", ".rs", ".go", ".java", ".sh"};
static bool is_html(const string &name) { return ends_with(name, ".html") || ends_with(name, ".htm"); }
static bool readable(const string &name) {
  return ends_with(name, ".md") || is_html(name) || name == "Makefile" ||
         std::find(CODE_EXT.begin(), CODE_EXT.end(), ext_of(name)) != CODE_EXT.end();
}
// Pictures, video and sound are listed too; the reader shows them in a viewer.
static bool is_media(const string &name) {
  static const Strings media = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mp3", ".m4a", ".wav", ".ogg"};
  return std::find(media.begin(), media.end(), lower(ext_of(name))) != media.end();
}
static const size_t MAX_RANGE = 4u << 20; // most bytes sent in answer to one partial request
static const char *mime_of(const string &name) {
  static const std::pair<const char *, const char *> types[] = {
      {".html", "text/html"}, {".htm", "text/html"}, {".css", "text/css"}, {".js", "text/javascript"},
      {".mjs", "text/javascript"}, {".json", "application/json"}, {".svg", "image/svg+xml"}, {".png", "image/png"},
      {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}, {".gif", "image/gif"}, {".webp", "image/webp"},
      {".pdf", "application/pdf"}, {".woff2", "font/woff2"}, {".mp4", "video/mp4"}, {".m4v", "video/mp4"},
      {".mov", "video/quicktime"}, {".webm", "video/webm"}, {".ogv", "video/ogg"}, {".mp3", "audio/mpeg"},
      {".m4a", "audio/mp4"}, {".wav", "audio/wav"}, {".ogg", "audio/ogg"}};
  string ext = lower(ext_of(name));
  for (const auto &t : types) if (ext == t.first) return t.second;
  return "text/plain";
}

// Choose a profile from what the machine reports. On the ESP32 the build itself
// says so (ESP_PLATFORM is defined by ESP-IDF); elsewhere, ask the OS.
static void detect_profile(const string &forced) {
  device_cores = std::max(1u, std::thread::hardware_concurrency());
#ifdef ESP_PLATFORM
  profile = PROFILES[2];
#else
  long pages = ::sysconf(_SC_PHYS_PAGES), page_size = ::sysconf(_SC_PAGESIZE);
  if (pages > 0 && page_size > 0) device_memory_mb = static_cast<unsigned long long>(pages) * static_cast<unsigned long long>(page_size) >> 20;
  profile = device_memory_mb != 0 && device_memory_mb < 1024 ? PROFILES[1] : PROFILES[0];
#endif
  for (const Profile &pr : PROFILES) if (forced == pr.name) profile = pr;
}

// ---- JSON (cJSON, the library ESP-IDF ships) ----------------------------------

struct Json { // owns a cJSON tree
  cJSON *p;
  explicit Json(cJSON *node) : p(node) {}
  ~Json() { cJSON_Delete(p); }
  Json(const Json &) = delete;
  Json &operator=(const Json &) = delete;
};
static string dump(const cJSON *node, bool pretty = false) {
  char *text = pretty ? cJSON_Print(node) : cJSON_PrintUnformatted(node);
  string out = text ? text : "null";
  cJSON_free(text);
  return out;
}
static string str_of(const cJSON *obj, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  return cJSON_IsString(v) && v->valuestring ? v->valuestring : "";
}
static bool has_str(const cJSON *obj, const char *key) { return cJSON_IsString(cJSON_GetObjectItemCaseSensitive(obj, key)); }
static void set_str(cJSON *obj, const char *key, const string &value) {
  cJSON_DeleteItemFromObjectCaseSensitive(obj, key);
  cJSON_AddStringToObject(obj, key, value.c_str());
}
static Strings list_of(const cJSON *obj, const char *key) {
  Strings out;
  const cJSON *item;
  cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(obj, key)) if (cJSON_IsString(item)) out.push_back(item->valuestring);
  return out;
}
static http::Response json_response(const cJSON *node, int status = 200) {
  http::Response r;
  r.status = status;
  r.body = dump(node);
  return r;
}

// ---- settings: hub.json and FRONTPAGE.md ---------------------------------------

// The first "# Heading" of a markdown text.
static bool first_h1(const string &md, string &title, size_t *line_start = nullptr, size_t *line_len = nullptr) {
  size_t pos = 0;
  while (pos < md.size()) {
    size_t eol = md.find('\n', pos);
    if (eol == string::npos) eol = md.size();
    if (md[pos] == '#' && pos + 1 < eol && (md[pos + 1] == ' ' || md[pos + 1] == '\t')) {
      string rest = trim(md.substr(pos + 1, eol - pos - 1));
      if (!rest.empty()) {
        title = rest;
        if (line_start) *line_start = pos;
        if (line_len) *line_len = eol - pos;
        return true;
      }
    }
    pos = eol + 1;
  }
  return false;
}

// Titles come from the start of a file only (its first 64 KB), read through a
// small buffer: a 64 KB block at once is more than the board can count on
// finding free, and most titles are in the first line anyway.
static const size_t TITLE_SCAN = 64 * 1024;

// The first "# Heading" among the lines that start in the first 64 KB. A line
// longer than the buffer is judged by its first kilobyte.
static bool md_title(FILE *f, string &title) {
  char line[1024];
  size_t seen = 0;
  while (seen < TITLE_SCAN && std::fgets(line, sizeof line, f)) {
    size_t n = std::strlen(line);
    seen += n;
    if (line[0] == '#' && first_h1(string(line, n), title)) return true;
    if (n > 0 && line[n - 1] != '\n') {
      int c;
      while (seen < TITLE_SCAN && (c = std::fgetc(f)) != EOF && c != '\n') seen++;
    }
  }
  return false;
}

// <title>…</title> in the first 64 KB, in any case.
static bool html_title(FILE *f, string &title) {
  string window; // the tail of what was read, which may hold the start of the tag; then the tag onwards
  bool open = false;
  char chunk[1024];
  size_t seen = 0, n;
  while (seen < TITLE_SCAN && (n = std::fread(chunk, 1, std::min(sizeof chunk, TITLE_SCAN - seen), f)) > 0) {
    seen += n;
    window.append(chunk, n);
    string low = lower(window);
    if (!open) {
      size_t at = low.find("<title");
      if (at == string::npos) { window.erase(0, window.size() > 5 ? window.size() - 5 : 0); continue; }
      window.erase(0, at);
      low.erase(0, at);
      open = true;
    }
    size_t start = low.find('>');
    size_t end = start == string::npos ? string::npos : low.find("</title>", start);
    if (end != string::npos) { title = trim(window.substr(start + 1, end - start - 1)); return !title.empty(); }
    if (window.size() > 8 * 1024) return false; // that long, it is not a title
  }
  return false;
}

static cJSON *default_highlights() {
  static const char *types[][3] = {{"important", "Important", "#fbeeb0"}, {"definition", "Definition", "#cfe8c6"},
                                   {"question", "Question", "#cfe0f5"}, {"unclear", "Unclear", "#f6d0d6"}};
  cJSON *arr = cJSON_CreateArray();
  for (const auto &t : types) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", t[0]);
    cJSON_AddStringToObject(o, "name", t[1]);
    cJSON_AddStringToObject(o, "color", t[2]);
    cJSON_AddItemToArray(arr, o);
  }
  return arr;
}

// hub.json as it is on disk (an empty object if missing or broken).
static cJSON *read_settings_file() {
  string text;
  cJSON *cfg = read_file(ROOT + "/hub.json", text) ? cJSON_Parse(text.c_str()) : nullptr;
  if (!cJSON_IsObject(cfg)) { cJSON_Delete(cfg); cfg = cJSON_CreateObject(); }
  return cfg;
}

// Settings as the page sees them: file contents, defaults filled in, plus
// "front" (the landing page, if there is one) and "root".
static cJSON *read_config() {
  cJSON *cfg = read_settings_file();
  if (!has_str(cfg, "title")) set_str(cfg, "title", basename_of(ROOT));
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(cfg, "side"))) { cJSON_DeleteItemFromObjectCaseSensitive(cfg, "side"); cJSON_AddItemToObject(cfg, "side", cJSON_CreateArray()); }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(cfg, "ignore"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(cfg, "ignore");
    cJSON *ignore = cJSON_AddArrayToObject(cfg, "ignore");
    cJSON_AddItemToArray(ignore, cJSON_CreateString("CLAUDE.md"));
  }
  cJSON *hl = cJSON_GetObjectItemCaseSensitive(cfg, "highlights");
  if (!cJSON_IsArray(hl) || cJSON_GetArraySize(hl) == 0) {
    cJSON_DeleteItemFromObjectCaseSensitive(cfg, "highlights");
    cJSON_AddItemToObject(cfg, "highlights", default_highlights());
  }
  cJSON_DeleteItemFromObjectCaseSensitive(cfg, "front");
  cJSON_DeleteItemFromObjectCaseSensitive(cfg, "root");
  string title;
  if (FILE *f = std::fopen((ROOT + "/" + FRONT).c_str(), "rb")) {
    cJSON_AddStringToObject(cfg, "front", FRONT);
    if (md_title(f, title)) set_str(cfg, "title", title);
    std::fclose(f);
  } else {
    cJSON_AddNullToObject(cfg, "front");
  }
  cJSON_AddStringToObject(cfg, "root", ROOT.c_str());
  return cfg;
}

// "x" matches a path equal to x, a file named x, or (when x ends in "/") anything under that folder.
static bool matches(const string &rel, const Strings &list) {
  for (const string &x : list) {
    if (rel == x || basename_of(rel) == x) return true;
    if (!x.empty() && x.back() == '/' && starts_with(rel + "/", x)) return true;
  }
  return false;
}

// ---- the document list -----------------------------------------------------------

// Names sort the way a person expects: case-insensitive, digit runs as numbers.
static bool natural_less(std::string_view a, std::string_view b) {
  size_t i = 0, j = 0;
  while (i < a.size() && j < b.size()) {
    if (std::isdigit(static_cast<unsigned char>(a[i])) && std::isdigit(static_cast<unsigned char>(b[j]))) {
      size_t i2 = i, j2 = j;
      while (i2 < a.size() && std::isdigit(static_cast<unsigned char>(a[i2]))) i2++;
      while (j2 < b.size() && std::isdigit(static_cast<unsigned char>(b[j2]))) j2++;
      std::string_view na = a.substr(i, i2 - i), nb = b.substr(j, j2 - j);
      na.remove_prefix(std::min(na.find_first_not_of('0'), na.size() - 1));
      nb.remove_prefix(std::min(nb.find_first_not_of('0'), nb.size() - 1));
      if (na.size() != nb.size()) return na.size() < nb.size();
      if (na != nb) return na < nb;
      i = i2;
      j = j2;
    } else {
      int ca = std::tolower(static_cast<unsigned char>(a[i])), cb = std::tolower(static_cast<unsigned char>(b[j]));
      if (ca != cb) return ca < cb;
      i++;
      j++;
    }
  }
  return a.size() - i < b.size() - j;
}

static string title_of(const string &abs, const string &name) {
  const bool html = is_html(name), md = ends_with(name, ".md");
  if (!html && !md) return name;
  string title;
  if (FILE *f = std::fopen(abs.c_str(), "rb")) {
    bool found = html ? html_title(f, title) : md_title(f, title);
    std::fclose(f);
    if (found) return title;
  }
  return html ? name : name.substr(0, name.size() - 3);
}

// The list is written out as it is made, to memory or to a file, never held as
// a tree of JSON objects: for a few thousand documents that tree alone would be
// several times what the board has free.
struct Sink {
  string *mem = nullptr; // either this...
  FILE *file = nullptr;  // ...or this, written a few KB at a time
  string buf;
  bool ok = true;
  void put(const char *s, size_t n) {
    if (mem) { mem->append(s, n); return; }
    buf.append(s, n);
    if (buf.size() >= 4096) flush();
  }
  void put(const char *s) { put(s, std::strlen(s)); }
  void flush() {
    if (file && !buf.empty()) ok = std::fwrite(buf.data(), 1, buf.size(), file) == buf.size() && ok;
    buf.clear();
  }
  // A JSON string, escaped the way cJSON escapes it.
  void str(const string &s) {
    put("\"", 1);
    size_t from = 0;
    for (size_t i = 0; i < s.size(); i++) {
      const unsigned char c = static_cast<unsigned char>(s[i]);
      if (c >= 0x20 && c != '"' && c != '\\') continue;
      put(s.data() + from, i - from);
      from = i + 1;
      switch (c) {
        case '"': put("\\\"", 2); break;
        case '\\': put("\\\\", 2); break;
        case '\b': put("\\b", 2); break;
        case '\f': put("\\f", 2); break;
        case '\n': put("\\n", 2); break;
        case '\r': put("\\r", 2); break;
        case '\t': put("\\t", 2); break;
        default: { char esc[8]; std::snprintf(esc, sizeof esc, "\\u%04x", c); put(esc, 6); }
      }
    }
    put(s.data() + from, s.size() - from);
    put("\"", 1);
  }
};

struct Listing {
  Strings ignore, side;
  Sink *out;
  size_t budget;     // the profile's sort_budget
  size_t held = 0;   // what the folders being walked hold now, outer ones included
  bool first = true;
};

static void walk(const string &dir, const string &rel, Listing &ls);

// Whether an entry is in the list (a folder: whether it is walked).
static bool listed(bool is_dir, const string &name, const string &r, const string &abs, const Listing &ls) {
  if (name[0] == '.' || matches(r, ls.ignore)) return false;
  if (is_dir) return name != "node_modules" && name != "notes" && abs != WWW;
  return readable(name) || is_media(name);
}
static void list_entry(const string &dir, const string &rel, const string &name, bool is_dir, Listing &ls) {
  string r = rel.empty() ? name : rel + "/" + name, abs = dir + "/" + name;
  if (is_dir) { walk(abs, r, ls); return; }
  Sink &o = *ls.out;
  o.put(ls.first ? "{\"path\":" : ",{\"path\":");
  ls.first = false;
  o.str(r);
  o.put(",\"group\":");
  o.str(rel);
  o.put(",\"title\":");
  o.str(title_of(abs, name));
  o.put(matches(r, ls.side) ? ",\"side\":true" : ",\"side\":false");
  o.put(r == FRONT ? ",\"front\":true}" : ",\"front\":false}");
}

// The order of the list: natural_less, with names it finds equal ("a01",
// "a1") put in byte order so the order is total and the same on every disk.
static bool name_less(std::string_view a, std::string_view b) { return natural_less(a, b) || (!natural_less(b, a) && a < b); }

// Some of one folder's names, held compactly: one buffer of entries ("d" or
// "f", the name, a 0 byte) and an offset per entry. A vector rather than a
// string because its reserve() allocates exactly what is asked (a string's may
// double), which is what keeps the budget a budget.
struct Names {
  std::vector<char> text;
  std::vector<uint32_t> at;
  std::string_view name(size_t i) const { return std::string_view(text.data() + at[i] + 1); }
  bool is_dir(size_t i) const { return text[at[i]] == 'd'; }
  size_t bytes() const { return text.capacity() + at.capacity() * sizeof(uint32_t); }
  // Room for one more name of `len` bytes within `budget` (0: no limit), less
  // what is `held` elsewhere. Two names always fit, so a pass always gets somewhere.
  bool room(size_t len, size_t budget, size_t held) {
    size_t need_t = text.size() + len + 2, need_a = at.size() + 1;
    size_t cap_t = text.capacity() >= need_t ? text.capacity() : std::max(need_t, text.capacity() + text.capacity() / 2);
    size_t cap_a = at.capacity() >= need_a ? at.capacity() : std::max(need_a, at.capacity() + at.capacity() / 2);
    if (budget && at.size() >= 2 && held + cap_t + cap_a * sizeof(uint32_t) > budget) return false;
    text.reserve(cap_t);
    at.reserve(cap_a);
    return true;
  }
  void add(bool dir, const string &name) {
    at.push_back(static_cast<uint32_t>(text.size()));
    text.push_back(dir ? 'd' : 'f');
    text.insert(text.end(), name.begin(), name.end());
    text.push_back('\0');
  }
  void sort() { std::sort(at.begin(), at.end(), [&](uint32_t x, uint32_t y) { return name_less(text.data() + x + 1, text.data() + y + 1); }); }
  // Keep the first `n` (by name, after sort()), moving them down in place.
  void keep_first(size_t n) {
    at.resize(n);
    std::sort(at.begin(), at.end());
    size_t w = 0;
    for (uint32_t &x : at) {
      size_t len = std::strlen(text.data() + x + 1) + 2;
      std::memmove(text.data() + w, text.data() + x, len);
      x = static_cast<uint32_t>(w);
      w += len;
    }
    text.resize(w);
    sort();
  }
};

// One folder, in name order, each folder inside walked in its place. When the
// folder has more names than the budget leaves room for (a few thousand
// pictures, on the board), it is read more than once: each pass keeps the
// lowest names it can hold, after those already listed, and lists them. Reading
// a folder again costs far less than memory the board does not have.
static void walk(const string &dir, const string &rel, Listing &ls) {
  Names b;
  string after;       // the last name listed by an earlier pass
  bool more = true, first_pass = true;
  while (more) {
    string below;     // names from here on are left to the next pass
    more = false;
    b.text.clear();
    b.at.clear();
    fs::each(dir, [&](const fs::Entry &e) {
      string name = e.name;
      if ((!first_pass && !name_less(after, name)) || (more && !name_less(name, below))) return;
      if (!listed(e.dir, name, rel.empty() ? name : rel + "/" + name, dir + "/" + name, ls)) return;
      while (!b.room(name.size(), ls.budget, ls.held)) {
        // Full: keep the lower half; the rest, from the first name let go, waits for the next pass.
        b.sort();
        size_t keep = b.at.size() / 2;
        below = string(b.name(keep));
        more = true;
        b.keep_first(keep);
        if (!name_less(name, below)) return;
      }
      b.add(e.dir, name);
    });
    b.sort();
    const size_t mine = b.bytes();
    ls.held += mine;
    bool let_go = false;
    for (size_t i = 0; i < b.at.size(); i++) {
      string name(b.name(i));
      // A folder inside one that holds most of the budget: let this folder's
      // names go while that one is walked, so it has room of its own, then read
      // on from it.
      if (b.is_dir(i) && ls.budget && mine > ls.budget / 2) {
        ls.held -= mine;
        std::vector<char>().swap(b.text);
        std::vector<uint32_t>().swap(b.at);
        let_go = true;
        list_entry(dir, rel, name, true, ls);
        after = name;
        more = true;
        break;
      }
      list_entry(dir, rel, name, b.is_dir(i), ls);
    }
    if (!let_go) {
      ls.held -= mine;
      if (more) after = string(b.name(b.at.size() - 1));
    }
    first_pass = false;
  }
}

// ---- notes --------------------------------------------------------------------------

static cJSON *read_notes() {
  string text;
  cJSON *notes = read_file(ROOT + "/notes/notes.json", text) ? cJSON_Parse(text.c_str()) : nullptr;
  if (!cJSON_IsArray(notes)) { cJSON_Delete(notes); notes = cJSON_CreateArray(); }
  return notes;
}
static bool write_notes(const cJSON *notes) { return write_json(ROOT + "/notes/notes.json", notes); }

static string new_id() {
  static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  string id;
  for (auto v = static_cast<unsigned long long>(ms); v > 0; v /= 36) id.insert(id.begin(), digits[v % 36]);
  unsigned char r[4] = {0};
  secure::random_bytes(r, sizeof r);
  for (unsigned char c : r) id += digits[c % 36];
  return id;
}
static string now_iso() {
  auto now = std::chrono::system_clock::now();
  std::time_t t = std::chrono::system_clock::to_time_t(now);
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
  std::tm tm{};
  ::gmtime_r(&t, &tm);
  char buf[80]; // room for any int the compiler can imagine in each field (the board's build stops on a warning)
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
  return buf;
}

// ---- who is asking: host names, paired devices -----------------------------------------
// See ../API.md, "Security". State lives in STATE/devices.json; only a hash of
// each device's token is kept, so the file alone lets nobody in.

#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "esp_system.h"
extern "C" const char *board_ip();
#endif
static bool pair_local = false;        // even this machine's own browser must pair
static bool tls_on = false;
static Strings extra_hosts;
static string bind_host = "127.0.0.1";

#ifdef __APPLE__
// The name other devices find this Mac by on the local network (the one in
// System Settings > Sharing), which is often not its host name. Asked for once.
static const string &mac_local_name() {
  static const string name = [] {
    string out;
    if (FILE *f = ::popen("/usr/sbin/scutil --get LocalHostName 2>/dev/null", "r")) {
      char buf[256] = {0};
      if (std::fgets(buf, sizeof buf, f)) out = lower(trim(buf));
      ::pclose(f);
    }
    return !out.empty() && out.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") == string::npos ? out + ".local" : string();
  }();
  return name;
}
#endif
// Every name this machine answers to. A request naming any other host is
// refused: that is what stops a website from pointing its own name at this
// address and being treated as "the same site" (DNS rebinding).
static Strings host_names() {
  Strings out = {"localhost", "127.0.0.1", "hub.local"};
#ifdef ESP_PLATFORM
  if (const char *ip = board_ip()) out.push_back(ip); // the address Wi-Fi gave the board (esp32/main/board.cpp)
#else
  char name[256] = {0};
  if (::gethostname(name, sizeof name - 1) == 0 && name[0]) {
    string h = lower(name);
    out.push_back(h);
    if (!ends_with(h, ".local") && h.find('.') == string::npos) out.push_back(h + ".local");
  }
#ifdef __APPLE__
  if (!mac_local_name().empty()) out.push_back(mac_local_name());
#endif
  ifaddrs *list = nullptr;
  if (::getifaddrs(&list) == 0) {
    for (ifaddrs *i = list; i; i = i->ifa_next) {
      if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET) continue;
      char buf[INET_ADDRSTRLEN];
      if (::inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in *>(i->ifa_addr)->sin_addr, buf, sizeof buf)) out.push_back(buf);
    }
    ::freeifaddrs(list);
  }
#endif
  if (bind_host != "0.0.0.0") out.push_back(bind_host);
  for (const string &h : extra_hosts) out.push_back(lower(h));
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}
static std::mutex hosts_lock;
static std::set<string> hosts;
static bool known_host(const string &header) {
  string h = lower(header);
  if (!h.empty() && h[0] == '[') h = h.substr(0, h.find(']') + 1);
  else h = h.substr(0, h.rfind(':') == string::npos ? h.size() : h.rfind(':'));
  if (h.empty()) return false;
  if (h == "[::1]") return true;
  std::lock_guard<std::mutex> g(hosts_lock);
  if (hosts.count(h)) return true;
  // The address may have changed since start-up (a new Wi-Fi network): look again.
  Strings now = host_names();
  hosts = std::set<string>(now.begin(), now.end());
  return hosts.count(h) != 0;
}

struct Device { string id, name, hash, created, seen; };
static std::mutex auth_lock;
static std::vector<Device> devices;
static string pair_code;                       // the code a new device must type, if one is on offer
static http::Clock::time_point pair_until;
static int pair_fails = 0;

static void load_devices() {
  string text;
  Json file(secure::slurp(STATE + "/devices.json", text) ? cJSON_Parse(text.c_str()) : nullptr);
  const cJSON *d;
  cJSON_ArrayForEach(d, cJSON_GetObjectItemCaseSensitive(file.p, "devices")) {
    Device dev{str_of(d, "id"), str_of(d, "name"), str_of(d, "hash"), str_of(d, "created"), str_of(d, "seen")};
    if (!dev.id.empty() && dev.hash.size() == 64) devices.push_back(dev);
  }
}
static bool save_devices() {
  Json file(cJSON_CreateObject());
  cJSON *arr = cJSON_AddArrayToObject(file.p, "devices");
  for (const Device &d : devices) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", d.id.c_str());
    cJSON_AddStringToObject(o, "name", d.name.c_str());
    cJSON_AddStringToObject(o, "hash", d.hash.c_str());
    cJSON_AddStringToObject(o, "created", d.created.c_str());
    cJSON_AddStringToObject(o, "seen", d.seen.c_str());
    cJSON_AddItemToArray(arr, o);
  }
  return secure::spit(STATE + "/devices.json", dump(file.p, true) + "\n", 0600);
}
// Offer a new pairing code for ten minutes. Call with auth_lock held.
static string offer_code(bool announce) {
  pair_code = secure::random_code(8);
  pair_until = http::Clock::now() + std::chrono::minutes(10);
  pair_fails = 0;
  if (announce) {
    std::printf("pairing code: %s-%s  (type it on the device you want to add; good for 10 minutes)\n", pair_code.substr(0, 4).c_str(), pair_code.substr(4).c_str());
    std::fflush(stdout);
  }
  return pair_code;
}
static string cookie_of(const http::Request &req, const string &name) {
  const string &all = req.header("cookie");
  size_t pos = 0;
  while (pos < all.size()) {
    size_t end = all.find(';', pos);
    if (end == string::npos) end = all.size();
    string pair = trim(all.substr(pos, end - pos));
    if (starts_with(pair, name + "=")) return pair.substr(name.size() + 1);
    pos = end + 1;
  }
  return "";
}
// The id of the paired device that sent this request: "local" for this machine
// itself, "" for a stranger.
// Whether a request comes from a page of another site, going by what the
// browser says (Origin, Sec-Fetch-Site).
static bool cross_site(const http::Request &req) {
  const string &origin = req.header("origin"), &site = req.header("sec-fetch-site");
  if (!origin.empty()) {
    size_t scheme = origin.find("://");
    if (scheme == string::npos || origin.substr(scheme + 3) != req.header("host")) return true;
  }
  return !site.empty() && site != "same-origin" && site != "none";
}
// "http(s)://host[:port]" and nothing more.
static bool plain_origin(const string &o) {
  size_t at = starts_with(o, "https://") ? 8 : starts_with(o, "http://") ? 7 : 0;
  if (!at || o.size() == at) return false;
  return std::all_of(o.begin() + static_cast<long>(at), o.end(), [](unsigned char c) { return c > ' ' && c != '/' && c < 127; });
}
static string bearer_of(const http::Request &req) {
  const string &h = req.header("authorization");
  return starts_with(h, "Bearer ") ? trim(h.substr(7)) : "";
}

// A request from this hub's own page proves itself with its cookie. A reader
// that was loaded from another hub (`cross`) proves itself with the token it
// was given when it paired, sent as "Authorization: Bearer"; for it the cookie
// and being on this machine count for nothing, since any website could cause
// such a request.
static string device_of(const http::Request &req, bool cross) {
  string cookie = bearer_of(req);
  if (cookie.empty() && !cross) cookie = cookie_of(req, "hub_device");
  size_t dot = cookie.find('.');
  if (dot != string::npos) {
    string id = cookie.substr(0, dot), hash = secure::sha256_hex(cookie.substr(dot + 1)), today = now_iso().substr(0, 10);
    std::lock_guard<std::mutex> g(auth_lock);
    for (Device &d : devices) {
      if (d.id != id || !secure::same(d.hash, hash)) continue;
      if (d.seen != today) { d.seen = today; save_devices(); } // one small write a day, not one per request
      return d.id;
    }
  }
  return !cross && req.local && !pair_local ? "local" : "";
}

// Other hubs the reader may also connect to: a name and an address each, set
// from the reader. The page is allowed to talk to these and to nothing else.
struct Hub { string name, url; };
static std::vector<Hub> read_hubs() {
  std::vector<Hub> out;
  string text;
  Json file(secure::slurp(STATE + "/hubs.json", text) ? cJSON_Parse(text.c_str()) : nullptr);
  const cJSON *h;
  cJSON_ArrayForEach(h, cJSON_GetObjectItemCaseSensitive(file.p, "hubs")) {
    Hub hub{str_of(h, "name"), str_of(h, "url")};
    if (has_str(h, "name") && plain_origin(hub.url)) out.push_back(hub);
  }
  return out;
}
static cJSON *hubs_json(const std::vector<Hub> &hubs) {
  cJSON *arr = cJSON_CreateArray();
  for (const Hub &h : hubs) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "name", h.name.c_str());
    cJSON_AddStringToObject(o, "url", h.url.c_str());
    cJSON_AddItemToArray(arr, o);
  }
  return arr;
}
// What a typed address comes down to: scheme and host in lower case, the
// port unless it is the usual one, and nothing after it. "" if it is no address.
static string origin_of(const string &typed) {
  string u = lower(trim(typed));
  bool tls = starts_with(u, "https://");
  if (!tls && !starts_with(u, "http://")) return "";
  size_t at = tls ? 8 : 7, end = u.find_first_of("/?#", at);
  string host = u.substr(at, end == string::npos ? string::npos : end - at);
  const string usual = tls ? ":443" : ":80";
  if (host.size() > usual.size() && host.compare(host.size() - usual.size(), usual.size(), usual) == 0) host.erase(host.size() - usual.size());
  string out = (tls ? "https://" : "http://") + host;
  return !host.empty() && host.find('@') == string::npos && plain_origin(out) ? out : "";
}
static string device_cookie(const string &value, bool tls, bool clear = false) {
  return "Set-Cookie: hub_device=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + (clear ? "0" : "31536000") + (tls ? "; Secure" : "") + "\r\n";
}

// ---- how much is stored ---------------------------------------------------------------------
// The folder is measured by looking it over once; from then on the count
// follows the server's own writes (uploads, notes, settings, removed folders).
// On the board nothing else writes to the card, so that count stays exact and
// the folder is never walked again for it. On a computer other programs write
// too: every look over the folder made for another reason (the change watcher,
// the document list) refreshes the count, and one older than 3 seconds is
// redone when it is needed.

static unsigned long long quota_bytes = 0;      // 0: no limit but the disk's free space
static std::mutex usage_lock;
static long long usage_count = 0;
static bool usage_known = false;
static http::Clock::time_point usage_at;
// Moves on whenever something that can change the document list changes.
static std::atomic<unsigned long long> generation{1};

// What one look over the folder finds. `stamp` changes when a file pages care
// about (not hidden, not in node_modules, not a .tmp being written) is added,
// removed, resized or rewritten. It is a sum, so it needs no list of paths and
// does not depend on the order the disk gives them in.
struct Scan {
  unsigned long long bytes = 0, files = 0, stamp = 0;
  std::map<string, long long> *each = nullptr; // when wanted: every such file with its own stamp
};
static unsigned long long mix(unsigned long long x) { // the last step of splitmix64
  x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
  x ^= x >> 27; x *= 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
static void scan(const string &dir, const string &rel, bool watched, Scan &s) {
  fs::each(dir, [&](const fs::Entry &e) {
    string name = e.name, abs = dir + "/" + name, r = rel.empty() ? name : rel + "/" + name;
    const bool w = watched && name[0] != '.' && name != "node_modules";
    if (e.dir) { if (abs != WWW) scan(abs, r, w, s); return; }
    s.bytes += e.size;
    s.files++;
    if (!w || ends_with(name, ".tmp")) return;
    const long long own = e.time * 1000003LL + static_cast<long long>(e.size);
    unsigned long long h = 1469598103934665603ULL;
    for (char ch : r) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;
    s.stamp += mix(h ^ static_cast<unsigned long long>(own));
    if (s.each) (*s.each)[r] = own;
  });
}
static Scan look_over(std::map<string, long long> *each = nullptr) {
  Scan s;
  s.each = each;
  scan(ROOT, "", true, s);
  std::lock_guard<std::mutex> g(usage_lock);
  usage_count = static_cast<long long>(s.bytes);
  usage_at = http::Clock::now();
  usage_known = true;
  return s;
}
static unsigned long long used_bytes() {
  {
    std::lock_guard<std::mutex> g(usage_lock);
    const bool stale = !usage_known || (!profile.sole_writer && http::Clock::now() - usage_at > std::chrono::seconds(3));
    if (!stale) return usage_count > 0 ? static_cast<unsigned long long>(usage_count) : 0;
  }
  return look_over().bytes;
}
static void used_more(long long n) { std::lock_guard<std::mutex> g(usage_lock); if (usage_known) usage_count += n; }
// What the disk has free (on the board: the card, from FatFS's own count). ~0 if unknown.
static unsigned long long free_bytes() {
  uint64_t total, free;
  return fs::space(ROOT, total, free) ? free : ~0ULL;
}
// Whether `more` bytes may be added: under the quota, and leaving the disk 16 MB to breathe.
static bool room_for(unsigned long long more) {
  if (free_bytes() < more + (16ULL << 20)) return false;
  return quota_bytes == 0 || used_bytes() + more <= quota_bytes;
}

// ---- live reload: tell open pages which file changed --------------------------------
// There is no portable file-watching API (and the ESP32 has none). On the
// board none is needed: the server announces its own changes as it makes them.
// Elsewhere the folder is looked over every watch_ms and compared.

static std::mutex clients_lock;
static std::vector<std::shared_ptr<http::Conn>> clients;

// Send one line to every open page; a page that cannot take it, or has gone, is dropped.
static void tell_clients(const string &line) {
  std::lock_guard<std::mutex> g(clients_lock);
  for (size_t i = 0; i < clients.size();) {
    clients[i]->within(2000);
    if (!clients[i]->gone() && clients[i]->write_all(line)) i++;
    else clients.erase(clients.begin() + static_cast<long>(i));
  }
}
static void announce(const string &rel) {
  Json msg(cJSON_CreateObject());
  cJSON_AddStringToObject(msg.p, "file", rel.c_str());
  tell_clients("data: " + dump(msg.p) + "\n\n");
}
// Whether a change to `rel` is one pages hear about, and whether it can change the list.
static bool watched_path(const string &rel, bool &in_list) {
  in_list = true;
  size_t pos = 0;
  while (pos <= rel.size()) {
    size_t end = rel.find('/', pos);
    if (end == string::npos) end = rel.size();
    std::string_view part(rel.data() + pos, end - pos);
    if (part.empty() || part[0] == '.' || part == "node_modules") return false;
    if (part == "notes") in_list = false; // the notes folder is never listed
    pos = end + 1;
  }
  return !ends_with(rel, ".tmp");
}
static void changed(const string &abs, long long delta) {
  used_more(delta);
  if (!starts_with(abs, ROOT + "/")) return;
  const string rel = abs.substr(ROOT.size() + 1);
  bool in_list;
  if (!watched_path(rel, in_list)) return;
  if (in_list) generation++;
  if (profile.sole_writer) announce(rel); // elsewhere the watcher reports it
}
static void watch_loop() {
  std::map<string, long long> before;
  try { look_over(&before); } catch (...) {}
  auto pinged = http::Clock::now();
  for (;;) {
    std::this_thread::sleep_for(std::chrono::milliseconds(profile.watch_ms));
    { std::lock_guard<std::mutex> g(clients_lock); if (clients.empty()) continue; }
    // Running out of memory here gives up this turn, not the server.
    try {
      // A comment line now and then finds pages that have gone away, freeing their place.
      if (http::Clock::now() - pinged > std::chrono::seconds(20)) { tell_clients(": ping\n\n"); pinged = http::Clock::now(); }
      std::map<string, long long> after;
      look_over(&after);
      Strings files;
      for (const auto &kv : after) { auto it = before.find(kv.first); if (it == before.end() || it->second != kv.second) files.push_back(kv.first); }
      for (const auto &kv : before) if (!after.count(kv.first)) files.push_back(kv.first);
      before.swap(after);
      if (!files.empty()) generation++;
      for (const string &file : files) announce(file);
    } catch (...) {}
  }
}

// ---- routes ----------------------------------------------------------------------------

// The page and its scripts, kept in memory on machines that can spare it and
// re-read only when the file on disk changes.
struct CachedFile { long long stamp; string body; };
static std::mutex cache_lock;
static std::map<string, CachedFile> asset_cache;

static long long stamp_of(const string &abs) {
  struct stat st;
  return ::stat(abs.c_str(), &st) == 0 && S_ISREG(st.st_mode) ? static_cast<long long>(st.st_mtime) * 1000003LL + static_cast<long long>(st.st_size) : -1;
}
// A file sent a piece at a time, straight from disk.
static http::Response file_response(const string &abs, const char *type) {
  bool dir;
  uint64_t size;
  if (!fs::info(abs, dir, size) || dir) return http::error(404, "no such file");
  http::Response r;
  r.type = type;
  r.file = abs;
  r.length = size;
  return r;
}
static http::Response asset_response(const string &abs, const char *type) {
  if (!profile.cache_assets) return file_response(abs, type);
  long long stamp = stamp_of(abs);
  if (stamp < 0) return http::error(404, "no such file");
  http::Response r;
  r.type = type;
  std::lock_guard<std::mutex> g(cache_lock);
  CachedFile &c = asset_cache[abs];
  if (c.stamp != stamp || c.body.empty()) { if (!read_file(abs, c.body)) return http::error(404, "no such file"); c.stamp = stamp; }
  r.body = c.body;
  return r;
}
// The document list, kept between requests until something listed changes.
// On the board it may be larger than the free memory, so it is kept in a file
// in a hidden folder beside the documents (CACHE). Each new list is a new file;
// an old one is deleted once the last answer still sending it has finished.
static string CACHE;
struct ListFile {
  string path;
  uint64_t size = 0;
  ~ListFile() { if (::unlink(path.c_str()) == 0) used_more(-static_cast<long long>(size)); }
};
static std::mutex listing_lock;  // one list made at a time: two pages asking at once share the work
static string listing_mem;
static std::shared_ptr<ListFile> listing_file;
static unsigned long long listing_gen = 0, listing_stamp = 0, listing_made = 0;
static bool listing_ok = false;

static void make_list(Sink &out) {
  Json cfg(read_config());
  Listing ls{list_of(cfg.p, "ignore"), list_of(cfg.p, "side"), &out, profile.sort_budget};
  out.put("[");
  walk(ROOT, "", ls);
  out.put("]");
  out.flush();
}
// Into a new file in CACHE; null if it could not be written (a full disk).
static std::shared_ptr<ListFile> make_list_file() {
  auto file = std::make_shared<ListFile>();
  file->path = CACHE + "/docs-" + std::to_string(++listing_made) + ".json";
  make_dirs(CACHE);
  std::unique_ptr<FILE, int (*)(FILE *)> f(std::fopen(file->path.c_str(), "wb"), std::fclose);
  if (!f) return nullptr;
  Sink out;
  out.file = f.get();
  make_list(out);
  if (std::fclose(f.release()) != 0 || !out.ok || !fs::file_size(file->path, file->size)) return nullptr;
  used_more(static_cast<long long>(file->size));
  return file;
}

// What each kind of answer is allowed to do once a browser has it.
//
// The reader: its own scripts only, nothing inline, and it may load from and
// talk to this server alone. So a document cannot make it run code, and
// opening a document never contacts the internet.
static const char *CSP_PAGE =
    "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'\r\n"
    "X-Frame-Options: DENY\r\nCross-Origin-Opener-Policy: same-origin\r\n";
// A file from the folder: no scripts at all, wherever it is opened (in the
// reader's frame or in a tab of its own), no forms, no leaving the frame, and
// pictures, styles and fonts from this server only.
static const char *CSP_RAW =
    "Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'\r\n";
static const char *CSP_DATA = "Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'\r\n";
static const char *COMMON_HEADERS = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\nX-DNS-Prefetch-Control: off\r\n";

// The files that make up the page. Nothing else in WWW is served.
static const std::pair<const char *, const char *> ASSETS[] = {
    {"/app.js", "app.js"}, {"/local.js", "local.js"}, {"/vault.js", "vault.js"},
    {"/vendor/marked.js", "node_modules/marked/lib/marked.umd.js"},
    {"/vendor/highlight.js", "node_modules/@highlightjs/cdn-assets/highlight.min.js"},
    {"/vendor/purify.js", "node_modules/dompurify/dist/purify.min.js"}};

// The body of a JSON request, or the status to refuse it with.
static int json_body(http::Request &req, string &body) { return req.read_body(body, MAX_JSON); }
static http::Response body_error(int status) { return http::error(status, status == 413 ? "body too large" : "body not received"); }

static http::Response session_json(const string &device) {
  Json out(cJSON_CreateObject());
  cJSON *d = cJSON_AddObjectToObject(out.p, "device");
  cJSON_AddStringToObject(d, "id", device.c_str());
  string name = "this computer";
  if (device != "local") { std::lock_guard<std::mutex> g(auth_lock); for (const Device &x : devices) if (x.id == device) name = x.name; }
  cJSON_AddStringToObject(d, "name", name.c_str());
  cJSON_AddBoolToObject(out.p, "local", device == "local");
  cJSON_AddBoolToObject(out.p, "tls", tls_on);
  return json_response(out.p);
}

static http::Response answer(http::Request &req) {
  const string &p = req.path, &m = req.method;

  if (!known_host(req.header("host"))) return http::error(403, "unknown host name");

  // The authority's certificate is public: a device needs it before it can trust the connection.
  if (p == "/hub-ca.crt" && m == "GET" && tls_on) return file_response(STATE + "/ca.pem", "application/x-x509-ca-cert");
  if (p == "/trust" && m == "GET" && tls_on) return asset_response(WWW + "/trust.html", "text/html");
  if (p == "/trust.js" && m == "GET" && tls_on) return asset_response(WWW + "/trust.js", "text/javascript");
  if (p == "/api/trust" && m == "GET" && tls_on) {
    string pem;
    secure::slurp(STATE + "/ca.pem", pem);
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "fingerprint", secure::fingerprint(pem).c_str());
    cJSON_AddBoolToObject(out.p, "encrypted", req.tls);
    return json_response(out.p);
  }
  // Someone typed http:// at a port that speaks HTTPS: send them to the trust page, or on to https://.
  if (req.plain_on_tls) {
    http::Response r;
    r.status = 308;
    r.type = "text/plain";
    r.extra = "Location: " + string(p == "/" ? "/trust" : "https://" + req.header("host") + req.target) + "\r\n";
    r.body = "This hub only speaks HTTPS.\n";
    r.close = true;
    return r;
  }

  if (m == "GET") {
    if (p == "/") return asset_response(WWW + "/index.html", "text/html");
    // What lets the page be installed and opened without the server. The
    // worker gets a content policy of its own: the one for data would stop
    // it asking the server for anything.
    if (p == "/sw.js") {
      http::Response r = asset_response(WWW + "/sw.js", "text/javascript");
      r.extra += "Content-Security-Policy: default-src 'none'; connect-src 'self'\r\n";
      return r;
    }
    if (p == "/manifest.webmanifest") return asset_response(WWW + p, "application/manifest+json");
    if (p == "/icon-192.png" || p == "/icon-512.png" || p == "/apple-touch-icon.png") return asset_response(WWW + p, "image/png");
    for (const auto &a : ASSETS) {
      if (p != a.first) continue;
      // Scripts sit beside the page (copied there for the board), or in node_modules.
      string name = a.first + 1;
      return asset_response(is_file(WWW + "/" + name) ? WWW + "/" + name : WWW + "/" + a.second, "text/javascript");
    }
  }

  // A page on another website must not be able to use what is here. Browsers
  // say where a request comes from (Origin, Sec-Fetch-Site); if that is not
  // this server itself, refuse.
  // The one exception is a reader that was loaded from another hub and is
  // paired with this one: it sends its token itself (never a cookie, which a
  // browser would attach for any site), or is pairing with the code.
  const bool cross = cross_site(req);
  if (cross) {
    const bool asked = m == "OPTIONS" && !req.header("access-control-request-method").empty();
    const bool allowed = asked || !bearer_of(req).empty() || (p == "/api/pair" && m == "POST");
    if (!allowed || !plain_origin(req.header("origin"))) return http::error(403, "requests from other sites are not allowed");
    if (asked) {
      http::Response r;
      r.status = 204;
      r.type = "text/plain";
      r.extra = "Access-Control-Allow-Methods: GET, POST, PUT, DELETE\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, Range\r\nAccess-Control-Max-Age: 600\r\n";
      return r;
    }
  }

  // Pairing: a new device shows it knows the code on offer and is given a token.
  if (p == "/api/pair" && m == "POST") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    string code, name = squeeze(str_of(body.p, "name")).substr(0, 60);
    for (char c : str_of(body.p, "code")) if (std::isalnum(static_cast<unsigned char>(c))) code += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (code.empty()) return http::error(400, "code required");
    std::lock_guard<std::mutex> g(auth_lock);
    bool on_offer = !pair_code.empty() && http::Clock::now() < pair_until;
    if (!on_offer || !secure::same(code, pair_code)) {
      // Five wrong tries and the code is withdrawn, so it cannot be guessed at.
      if (on_offer && ++pair_fails >= 5) { pair_code.clear(); if (devices.empty()) offer_code(true); }
      return http::error(403, "wrong or expired pairing code");
    }
    pair_code.clear();
    string token = secure::random_token(32);
    Device d{secure::random_hex(8), name.empty() ? "device" : name, secure::sha256_hex(token), now_iso(), now_iso().substr(0, 10)};
    if (token.empty() || d.id.empty()) return http::error(500, "could not pair");
    devices.push_back(d);
    if (!save_devices()) { devices.pop_back(); return http::error(500, "could not save"); }
    std::printf("paired: %s (%s)\n", d.name.c_str(), d.id.c_str());
    std::fflush(stdout);
    Json out(cJSON_CreateObject());
    cJSON *o = cJSON_AddObjectToObject(out.p, "device");
    cJSON_AddStringToObject(o, "id", d.id.c_str());
    cJSON_AddStringToObject(o, "name", d.name.c_str());
    // A reader from another hub keeps the token itself; this hub's own page gets it as a cookie.
    if (cross) { cJSON_AddStringToObject(out.p, "token", (d.id + "." + token).c_str()); return json_response(out.p); }
    http::Response r = json_response(out.p);
    r.extra = device_cookie(d.id + "." + token, req.tls);
    return r;
  }

  const string device = device_of(req, cross);
  if (device.empty()) return http::error(401, "pairing required");

  if (p == "/api/session" && m == "GET") return session_json(device);
  if (p == "/api/pair/code" && m == "POST") {
    std::lock_guard<std::mutex> g(auth_lock);
    string code = offer_code(false);
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "code", (code.substr(0, 4) + "-" + code.substr(4)).c_str());
    cJSON_AddNumberToObject(out.p, "minutes", 10);
    return json_response(out.p);
  }
  if (p == "/api/devices" && m == "GET") {
    Json out(cJSON_CreateArray());
    std::lock_guard<std::mutex> g(auth_lock);
    for (const Device &d : devices) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", d.id.c_str());
      cJSON_AddStringToObject(o, "name", d.name.c_str());
      cJSON_AddStringToObject(o, "created", d.created.c_str());
      cJSON_AddStringToObject(o, "seen", d.seen.c_str());
      cJSON_AddBoolToObject(o, "current", d.id == device);
      cJSON_AddItemToArray(out.p, o);
    }
    return json_response(out.p);
  }
  if (starts_with(p, "/api/devices/") && m == "DELETE") {
    string id = p.substr(13);
    std::lock_guard<std::mutex> g(auth_lock);
    auto it = std::find_if(devices.begin(), devices.end(), [&](const Device &d) { return d.id == id; });
    if (it == devices.end()) return http::error(404, "no such device");
    devices.erase(it);
    if (!save_devices()) return http::error(500, "could not save");
    http::Response r;
    r.body = "{\"ok\":true}";
    if (id == device) r.extra = device_cookie("", req.tls, true);
    return r;
  }
  if (p == "/api/storage" && m == "GET") {
    Json out(cJSON_CreateObject());
    cJSON_AddNumberToObject(out.p, "used", static_cast<double>(used_bytes()));
    cJSON_AddNumberToObject(out.p, "quota", static_cast<double>(quota_bytes));
    const unsigned long long free = free_bytes();
    cJSON_AddNumberToObject(out.p, "free", static_cast<double>(free == ~0ULL ? 0 : free));
    return json_response(out.p);
  }

  // Files as they are on disk (HTML documents, images and the like).
  if (starts_with(p, "/raw/")) {
    Strings parts;
    if (!clean_parts(p.substr(5), parts, false)) return http::error(404, "not found");
    string abs = ROOT + "/" + join(parts);
    bool dir;
    uint64_t size64;
    if (!fs::info(abs, dir, size64) || dir) return http::error(404, "no such file");
    const unsigned long long size = size64;
    http::Response r;
    r.type = mime_of(parts.back());
    r.extra = "Accept-Ranges: bytes\r\n";
    // A browser's PDF viewer does not start inside a sandbox; a PDF cannot touch the reader anyway.
    if (r.type != "application/pdf") r.extra += CSP_RAW;
    // "Range: bytes=a-b", "bytes=a-" or "bytes=-n" (the last n): send that part
    // only. This is what lets a browser play and seek video, and read a large
    // PDF a piece at a time.
    auto rh = req.headers.find("range");
    unsigned long long start = 0, end = size == 0 ? 0 : size - 1;
    bool partial = false;
    if (rh != req.headers.end() && starts_with(rh->second, "bytes=")) {
      string spec = rh->second.substr(6);
      size_t dash = spec.find('-');
      string a = dash == string::npos ? "" : spec.substr(0, dash), b = dash == string::npos ? "" : spec.substr(dash + 1);
      auto digits = [](const string &t) { return !t.empty() && t.size() < 19 && std::all_of(t.begin(), t.end(), [](unsigned char c) { return std::isdigit(c); }); };
      if (dash != string::npos && (a.empty() || digits(a)) && (b.empty() || digits(b)) && !(a.empty() && b.empty())) {
        partial = true;
        if (a.empty()) { unsigned long long n = std::stoull(b); start = n >= size ? 0 : size - n; }
        else { start = std::stoull(a); if (!b.empty()) end = std::min(std::stoull(b), size == 0 ? 0 : size - 1); }
        if (size == 0 || start >= size || start > end) {
          r.status = 416;
          r.extra += "Content-Range: bytes */" + std::to_string(size) + "\r\n";
          return r;
        }
        end = std::min(end, start + MAX_RANGE - 1);
      }
    }
    r.file = abs;
    r.length = size;
    if (partial) {
      r.status = 206;
      r.extra += "Content-Range: bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(size) + "\r\n";
      r.offset = start;
      r.length = end - start + 1;
    }
    return r;
  }

  // The event stream: answer the headers here and keep the connection for watch_loop.
  if (p == "/api/events") {
    std::lock_guard<std::mutex> g(clients_lock);
    // Places held by pages that have since closed are freed first.
    clients.erase(std::remove_if(clients.begin(), clients.end(), [](const std::shared_ptr<http::Conn> &c) { return c->gone(); }), clients.end());
    if (static_cast<int>(clients.size()) >= profile.max_streams) return http::error(503, "too many open pages");
    http::Response r;
    req.conn->within(5000);
    if (!req.conn->write_all(string("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n") + COMMON_HEADERS + "\r\n\n")) { r.status = 500; r.close = true; return r; }
    clients.push_back(req.conn);
    r.hold = true;
    return r;
  }

  if (p == "/api/docs") {
    // Making the list reads the start of every document for its title, so it
    // is kept until something listed changes. On the board only this server
    // changes the card and counts its own changes (generation); elsewhere the
    // folder is also looked over (one stat per file, nothing read).
    http::Response r;
    Sink out;
    if (!profile.cache_listing) { out.mem = &r.body; make_list(out); return r; }
    std::lock_guard<std::mutex> g(listing_lock);
    const unsigned long long gen = generation.load(), stamp = profile.sole_writer ? 0 : look_over().stamp;
    if (!listing_ok || gen != listing_gen || stamp != listing_stamp) {
      std::shared_ptr<ListFile> file = profile.listing_on_disk ? make_list_file() : nullptr;
      listing_mem.clear();
      if (!file) { out.mem = &listing_mem; make_list(out); listing_mem.shrink_to_fit(); } // in memory, also when the card is too full for the file
      listing_file = file;
      listing_gen = gen;
      listing_stamp = stamp;
      listing_ok = true;
    }
    if (!listing_file) { r.body = listing_mem; return r; }
    r = file_response(listing_file->path, "application/json");
    r.keep = listing_file;
    return r;
  }

  // What the server detected about the machine, and the limits it chose.
  if (p == "/api/device") {
    Json d(cJSON_CreateObject());
    cJSON_AddStringToObject(d.p, "profile", profile.name);
    cJSON_AddNumberToObject(d.p, "cores", device_cores);
    cJSON_AddNumberToObject(d.p, "memoryMB", static_cast<double>(device_memory_mb));
    cJSON_AddNumberToObject(d.p, "maxUploadMB", static_cast<double>(profile.max_upload >> 20));
    cJSON_AddNumberToObject(d.p, "watchMs", profile.watch_ms);
    cJSON_AddBoolToObject(d.p, "cacheAssets", profile.cache_assets);
    cJSON_AddBoolToObject(d.p, "cacheListing", profile.cache_listing);
    cJSON_AddNumberToObject(d.p, "maxConnections", profile.max_conns);
    cJSON_AddNumberToObject(d.p, "quotaMB", static_cast<double>(quota_bytes >> 20));
#ifdef ESP_PLATFORM
    // Memory now, the least there has been since start-up, and the largest
    // single block (what a large allocation can actually get).
    cJSON_AddNumberToObject(d.p, "heapFree", esp_get_free_heap_size());
    cJSON_AddNumberToObject(d.p, "heapLeast", esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(d.p, "heapLargest", static_cast<double>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
#endif
    return json_response(d.p);
  }

  if (p == "/api/hubs" && m == "GET") { Json out(hubs_json(read_hubs())); return json_response(out.p); }
  if (p == "/api/hubs" && m == "PUT") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    std::vector<Hub> hubs;
    const cJSON *h;
    int seen = 0;
    cJSON_ArrayForEach(h, cJSON_GetObjectItemCaseSensitive(body.p, "hubs")) {
      if (++seen > 12) break;
      Hub hub{squeeze(str_of(h, "name")).substr(0, 40), origin_of(str_of(h, "url"))};
      if (hub.url.empty() || hub.name.empty() || std::any_of(hubs.begin(), hubs.end(), [&](const Hub &x) { return x.url == hub.url; })) continue;
      hubs.push_back(hub);
    }
    Json file(cJSON_CreateObject());
    cJSON_AddItemToObject(file.p, "hubs", hubs_json(hubs));
    if (!secure::spit(STATE + "/hubs.json", dump(file.p, true) + "\n", 0600)) return http::error(500, "could not save");
    Json out(hubs_json(read_hubs()));
    return json_response(out.p);
  }

  if (p == "/api/config" && m == "GET") { Json cfg(read_config()); return json_response(cfg.p); }
  if (p == "/api/config" && m == "PUT") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    if (!cJSON_IsObject(body.p)) return http::error(400, "json object required");
    std::lock_guard<std::mutex> g(store_lock);
    Json file(read_settings_file());
    string title = squeeze(str_of(body.p, "title")), md;
    if (!title.empty() && read_file(ROOT + "/" + FRONT, md)) {
      // The front page's heading is the title: rewrite that line.
      string old;
      size_t at = 0, len = 0;
      if (first_h1(md, old, &at, &len)) md.replace(at, len, "# " + title);
      else md = "# " + title + "\n\n" + md;
      if (!write_file(ROOT + "/" + FRONT, md)) return http::error(500, "could not save");
    } else if (!title.empty()) {
      set_str(file.p, "title", title);
    }
    const cJSON *types = cJSON_GetObjectItemCaseSensitive(body.p, "highlights");
    if (cJSON_IsArray(types)) {
      cJSON *clean = cJSON_CreateArray();
      const cJSON *t;
      cJSON_ArrayForEach(t, types) {
        string id = str_of(t, "id"), color = str_of(t, "color"), name = trim(str_of(t, "name"));
        bool hex = color.size() == 7 && color[0] == '#' && std::all_of(color.begin() + 1, color.end(), [](unsigned char c) { return std::isxdigit(c); });
        if (id.empty() || !hex) continue;
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "id", id.c_str());
        cJSON_AddStringToObject(o, "name", name.empty() ? "Untitled" : name.c_str());
        cJSON_AddStringToObject(o, "color", color.c_str());
        cJSON_AddItemToArray(clean, o);
      }
      cJSON_DeleteItemFromObjectCaseSensitive(file.p, "highlights");
      cJSON_AddItemToObject(file.p, "highlights", clean);
    }
    // Folder locks: which folders the reader asks a password for, and what
    // it checks the password against. The whole set is replaced. The lock is
    // the reader's (it hides the folder until the password is typed); the
    // files themselves are stored as they are.
    const cJSON *locks = cJSON_GetObjectItemCaseSensitive(body.p, "locks");
    if (cJSON_IsObject(locks)) {
      auto b64 = [](const string &v, size_t most) {
        return !v.empty() && v.size() <= most && std::all_of(v.begin(), v.end(), [](unsigned char c) { return std::isalnum(c) || c == '+' || c == '/' || c == '='; });
      };
      cJSON *clean = cJSON_CreateObject();
      const cJSON *l;
      cJSON_ArrayForEach(l, locks) {
        Strings parts;
        if (!l->string || !cJSON_IsObject(l) || !clean_parts(l->string, parts, true)) continue;
        string salt = str_of(l, "salt"), hash = str_of(l, "hash");
        cJSON *o = cJSON_CreateObject();
        if (b64(salt, 64) && b64(hash, 128)) {
          cJSON_AddStringToObject(o, "salt", salt.c_str());
          cJSON_AddStringToObject(o, "hash", hash.c_str());
        }
        cJSON_DeleteItemFromObjectCaseSensitive(clean, join(parts).c_str());
        cJSON_AddItemToObject(clean, join(parts).c_str(), o);
      }
      cJSON_DeleteItemFromObjectCaseSensitive(file.p, "locks");
      cJSON_AddItemToObject(file.p, "locks", clean);
    }
    if (!write_json(ROOT + "/hub.json", file.p)) return http::error(500, "could not save");
    Json cfg(read_config());
    return json_response(cfg.p);
  }

  // Take a folder, and everything in it, out of the workspace. The notes
  // folder is the reader's own and stays. Any lock on the folder goes with it.
  if (p == "/api/folder" && m == "DELETE") {
    Strings parts;
    auto it = req.query.find("path");
    struct stat st;
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || parts[0] == "notes" ||
        fs::lstat((ROOT + "/" + join(parts)).c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) return http::error(400, "no such folder");
    std::lock_guard<std::mutex> g(store_lock);
    string key = join(parts);
    unsigned long long freed = 0;
    const bool removed = remove_tree(ROOT + "/" + key, freed);
    changed(ROOT + "/" + key, -static_cast<long long>(freed));
    if (!removed) return http::error(500, "could not remove");
    Json file(read_settings_file());
    cJSON *locks = cJSON_GetObjectItemCaseSensitive(file.p, "locks");
    if (cJSON_IsObject(locks)) {
      Strings gone;
      const cJSON *l;
      cJSON_ArrayForEach(l, locks) { string k = l->string ? l->string : ""; if (k == key || k.compare(0, key.size() + 1, key + "/") == 0) gone.push_back(k); }
      for (const string &k : gone) cJSON_DeleteItemFromObjectCaseSensitive(locks, k.c_str());
      if (!write_json(ROOT + "/hub.json", file.p)) return http::error(500, "could not save");
    }
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "removed", key.c_str());
    return json_response(out.p);
  }

  if (p == "/api/doc") {
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, false) || !readable(parts.back())) return http::error(404, "no such doc");
    http::Response r = file_response(ROOT + "/" + join(parts), "text/plain");
    return r.status == 200 ? r : http::error(404, "no such doc");
  }

  // The front page is the only document the reader may write.
  if (p == "/api/front" && m == "PUT") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    if (!has_str(body.p, "markdown")) return http::error(400, "markdown required");
    string md = str_of(body.p, "markdown");
    if (md.empty() || md.back() != '\n') md += '\n';
    // With "folder", it is that folder's own front page; without, the workspace's.
    string dir = ROOT, folder = str_of(body.p, "folder");
    if (!folder.empty()) {
      Strings parts;
      if (!clean_parts(folder, parts, true) || !is_dir(ROOT + "/" + join(parts))) return http::error(400, "no such folder");
      dir = ROOT + "/" + join(parts);
    }
    std::lock_guard<std::mutex> g(store_lock);
    if (!write_file(dir + "/" + FRONT, md)) return http::error(500, "could not save");
    Json cfg(read_config());
    return json_response(cfg.p);
  }

  if (p == "/api/notes" && m == "GET") { Json notes(read_notes()); return json_response(notes.p); }
  if (p == "/api/notes" && m == "POST") {
    string raw;
    if (int bad = json_body(req, raw)) return body_error(bad);
    Json body(cJSON_Parse(raw.c_str()));
    // A highlight is a note with a quote and no text yet.
    string doc = str_of(body.p, "doc"), text = str_of(body.p, "text"), quote = str_of(body.p, "quote");
    if (doc.empty() || (text.empty() && quote.empty())) return http::error(400, "doc and text or quote required");
    std::lock_guard<std::mutex> g(store_lock);
    Json notes(read_notes());
    // A note written while the board was out of reach arrives later with the id
    // and time it was given on the device. Sending the same one twice is harmless.
    string own_id = str_of(body.p, "id"), own_ts = str_of(body.p, "ts");
    const cJSON *seen;
    cJSON_ArrayForEach(seen, notes.p) if (!own_id.empty() && str_of(seen, "id") == own_id) return json_response(seen);
    if (!room_for(raw.size())) return http::error(507, "storage is full");
    bool id_ok = own_id.size() >= 6 && own_id.size() <= 40 && std::all_of(own_id.begin(), own_id.end(), [](unsigned char c) { return std::isalnum(c) || c == '_' || c == '-'; });
    bool ts_ok = own_ts.size() >= 20 && own_ts.size() <= 30 && own_ts.back() == 'Z' && own_ts[4] == '-' && own_ts[7] == '-' && own_ts[10] == 'T' && own_ts[13] == ':' && own_ts[16] == ':' &&
                 std::all_of(own_ts.begin(), own_ts.end() - 1, [](unsigned char c) { return std::isdigit(c) || c == '-' || c == 'T' || c == ':' || c == '.'; });
    cJSON *note = cJSON_CreateObject();
    cJSON_AddStringToObject(note, "id", id_ok ? own_id.c_str() : new_id().c_str());
    cJSON_AddStringToObject(note, "doc", doc.c_str());
    cJSON_AddStringToObject(note, "heading", str_of(body.p, "heading").c_str());
    cJSON_AddStringToObject(note, "headingText", str_of(body.p, "headingText").c_str());
    cJSON_AddStringToObject(note, "quote", quote.c_str());
    cJSON_AddStringToObject(note, "type", str_of(body.p, "type").c_str());
    cJSON_AddStringToObject(note, "text", text.c_str());
    cJSON_AddStringToObject(note, "ts", ts_ok ? own_ts.c_str() : now_iso().c_str());
    cJSON_AddStringToObject(note, "status", text.empty() ? "highlight" : "open");
    cJSON_AddItemToArray(notes.p, note);
    if (!write_notes(notes.p)) return http::error(500, "could not save");
    return json_response(note);
  }
  if (starts_with(p, "/api/notes/") && (m == "PUT" || m == "DELETE")) {
    string id = p.substr(11);
    std::lock_guard<std::mutex> g(store_lock);
    Json notes(read_notes());
    int index = 0;
    cJSON *note = nullptr, *item;
    cJSON_ArrayForEach(item, notes.p) { if (str_of(item, "id") == id) { note = item; break; } index++; }
    if (!note) return http::error(404, "no such note");
    if (m == "DELETE") {
      cJSON_DeleteItemFromArray(notes.p, index);
      if (!write_notes(notes.p)) return http::error(500, "could not save");
      http::Response r;
      r.body = "{\"ok\":true}";
      return r;
    }
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    if (!cJSON_IsObject(body.p)) return http::error(400, "json object required");
    for (const char *key : {"text", "quote", "heading", "headingText", "type"}) if (has_str(body.p, key)) set_str(note, key, str_of(body.p, key));
    if (str_of(note, "status") == "highlight" && !str_of(note, "text").empty()) set_str(note, "status", "open");
    if (!write_notes(notes.p)) return http::error(500, "could not save");
    return json_response(note);
  }

  // Workspaces made from uploads are not in this server yet: there is one, the folder itself.
  if (p == "/api/workspaces" || (p == "/api/workspace" && m == "POST")) {
    Json list(cJSON_CreateArray());
    cJSON *home = cJSON_CreateObject();
    cJSON_AddStringToObject(home, "name", basename_of(ROOT).c_str());
    cJSON_AddStringToObject(home, "root", ROOT.c_str());
    cJSON_AddBoolToObject(home, "home", true);
    cJSON_AddBoolToObject(home, "current", true);
    cJSON_AddItemToArray(list.p, home);
    return json_response(list.p);
  }

  // One file of an uploaded folder, added to this folder. Existing files are
  // never overwritten. The body goes to disk a piece at a time, under a
  // temporary name until it is complete.
  if (p == "/api/upload" && m == "POST") {
    if (req.query.count("workspace")) return http::error(501, "opening an upload as its own workspace is not in the C++ server yet");
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true)) return http::error(400, "bad path");
    if (req.content_length > profile.max_upload) return http::error(413, "body too large");
    string abs = ROOT + "/" + join(parts);
    Json out(cJSON_CreateObject());
    if (is_file(abs) || is_dir(abs)) {
      req.discard_body(profile.max_upload);
      cJSON_AddBoolToObject(out.p, "skipped", true);
      return json_response(out.p);
    }
    if (!room_for(req.content_length)) return http::error(507, "storage is full");
    make_dirs(dirname_of(abs));
    string tmp = abs + "." + secure::random_hex(4) + ".tmp";
    if (int bad = req.save_body(tmp, profile.max_upload, profile.piece)) return bad == 507 ? http::error(507, "storage is full") : bad == 500 ? http::error(500, "could not save") : body_error(bad);
    if (::rename(tmp.c_str(), abs.c_str()) != 0) { ::unlink(tmp.c_str()); return http::error(500, "could not save"); }
    changed(abs, static_cast<long long>(req.content_length));
    cJSON_AddBoolToObject(out.p, "saved", true);
    cJSON_AddStringToObject(out.p, "root", ROOT.c_str());
    return json_response(out.p);
  }

  return http::error(404, "not found");
}

// Every answer leaves with the headers that say what a browser may do with it.
static http::Response route(http::Request &req) {
  http::Response r = answer(req);
  if (r.hold) return r;
  bool page = req.method == "GET" && (req.path == "/" || req.path == "/trust") && r.status == 200;
  if (page) {
    // The page may also talk to the other hubs it has been told about.
    string csp = CSP_PAGE, also;
    if (req.path == "/") for (const Hub &h : read_hubs()) also += " " + h.url;
    size_t at = csp.find("connect-src 'self'");
    if (at != string::npos) csp.insert(at + 18, also);
    r.extra += csp;
  }
  else if (r.extra.find("Content-Security-Policy") == string::npos && r.type != "application/pdf") r.extra += CSP_DATA;
  r.extra += COMMON_HEADERS;
  // A reader loaded from another hub may read the answer (see cross_site, above).
  if (cross_site(req) && plain_origin(req.header("origin"))) r.extra += "Access-Control-Allow-Origin: " + req.header("origin") + "\r\nVary: Origin\r\n";
  return r;
}

static bool loopback(const string &host) { return starts_with(host, "127.") || host == "localhost"; }

// On the board there is no command line: esp32/main/board.cpp brings up Wi-Fi
// and the SD card, then calls this with the arguments it wants.
#ifdef ESP_PLATFORM
int hub_main(int argc, char **argv) {
#else
int main(int argc, char **argv) {
#endif
  string folder = ".", host = "127.0.0.1", www, forced;
  int port = 4321;
  bool want_tls = false, insecure = false, make_cert = false, new_authority = false;
  long long quota_mb = -1;
  const char *home = std::getenv("HOME"), *state_env = std::getenv("HUB_STATE");
  STATE = state_env ? state_env : string(home ? home : ".") + "/.config/hub";
  for (int i = 1; i < argc; i++) {
    string a = argv[i];
    if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
    else if (a == "--host" && i + 1 < argc) host = argv[++i];
    else if (a == "--www" && i + 1 < argc) www = argv[++i];
    else if (a == "--profile" && i + 1 < argc) forced = argv[++i];
    else if (a == "--state" && i + 1 < argc) STATE = argv[++i];
    else if (a == "--allow-host" && i + 1 < argc) extra_hosts.push_back(argv[++i]);
    else if (a == "--quota-mb" && i + 1 < argc) quota_mb = std::atoll(argv[++i]);
    else if (a == "--tls") want_tls = true;
    else if (a == "--insecure-http") insecure = true;
    else if (a == "--pair-local") pair_local = true;
    else if (a == "--make-cert") make_cert = true;
    else if (a == "--new-authority") make_cert = new_authority = true;
    else if (a == "--help" || a == "-h") {
      std::printf("usage: hubd [folder] [--port 4321] [--host 127.0.0.1] [--www <folder>/hub] [--profile desktop|small|esp32]\n"
                  "            [--state <dir>] [--tls] [--insecure-http] [--pair-local] [--allow-host <name>] [--quota-mb <n>]\n"
                  "       hubd --make-cert [--state <dir>] [--allow-host <name>]\n"
                  "       hubd --new-authority [--state <dir>] [--allow-host <name>]\n\n"
                  "  --state         where certificates and the list of paired devices are kept (default ~/.config/hub)\n"
                  "  --tls           serve HTTPS. Always on when --host is not this machine only\n"
                  "  --insecure-http serve the network without encryption anyway (not recommended)\n"
                  "  --pair-local    ask this machine's own browser to pair too\n"
                  "  --allow-host    another name this server may be reached by (repeatable)\n"
                  "  --quota-mb      most the folder may hold in total; 0 for no limit\n"
                  "  --make-cert     make or renew the certificates, print how to trust them, and stop\n"
                  "  --new-authority replace the authority devices install (each device then installs the new one once)\n");
      return 0;
    } else folder = a;
  }
  make_dirs(STATE);
  ::chmod(STATE.c_str(), 0700);
  bind_host = host;
  if (!secure::rng().ok) { std::fprintf(stderr, "no source of random numbers\n"); return 1; }

  // Beyond this machine, everything is encrypted.
  if (!loopback(host) && !insecure) want_tls = true;
  static http::Tls tls;
  if (want_tls || make_cert) {
    secure::Certs certs;
    string err;
    Strings names;
    for (const string &n : host_names()) if (n.find(':') == string::npos) names.push_back(n);
    if (!secure::ensure_certs(STATE, names, certs, err, new_authority)) { std::fprintf(stderr, "certificates: %s\n", err.c_str()); return 1; }
    if (certs.new_authority) {
      std::printf("A NEW AUTHORITY WAS MADE. It can vouch for this hub's names and home-network addresses only.\n"
                  "  Every device that uses this hub must install it once (steps below, or the hub's /trust page).\n");
      if (certs.replaced_open) std::printf("  It replaces an earlier authority that had no such limits. That one's key has been deleted here.\n"
                                           "  REMOVE THE EARLIER ONE (\"Hub local authority\") from every device it was installed on:\n"
                                           "    iPhone: Settings > General > VPN & Device Management > Hub local authority > Remove Profile\n"
                                           "    Mac:    Keychain Access > search \"Hub local authority\" > delete it\n");
    }
    if (certs.issued || make_cert) {
      std::printf("certificate %s for:", certs.issued ? "made" : "is current");
      for (const string &n : certs.covered) std::printf(" %s", n.c_str());
      std::printf("\n");
    }
    if (!certs.left_out.empty()) {
      std::printf("not in the certificate (outside what the authority may vouch for):");
      for (const string &n : certs.left_out) std::printf(" %s", n.c_str());
      std::printf("\n  For a name of your own, pass it with --allow-host and make a new authority with --new-authority.\n");
    }
    std::printf("To trust this hub on a device, install its authority once: %s\n  (or open http://<this address>:%d/ on the device and follow the steps)\n  fingerprint (SHA-256) %s\n", certs.ca_path.c_str(), port, certs.ca_fingerprint.c_str());
    if (make_cert) return 0;
    if (!tls.load(certs.cert_path, certs.key_path, err)) { std::fprintf(stderr, "TLS: %s\n", err.c_str()); return 1; }
    tls_on = true;
  } else if (!loopback(host)) {
    std::printf("WARNING: serving the network without encryption. Anyone on it can read and change what is sent.\n");
  }

  char resolved[4096];
  if (!::realpath(folder.c_str(), resolved) || !is_dir(resolved)) { std::fprintf(stderr, "not a folder: %s\n", folder.c_str()); return 1; }
  ROOT = resolved;
  if (::realpath(STATE.c_str(), resolved)) STATE = resolved;
  if (starts_with(STATE + "/", ROOT + "/")) { std::fprintf(stderr, "the state folder must not be inside the folder being served\n"); return 1; }
  // The page lives beside the server (../hub from server-cpp/), or inside the folder being served.
  if (www.empty()) www = is_file(ROOT + "/hub/index.html") ? ROOT + "/hub" : is_file("../hub/index.html") ? "../hub" : "hub";
  if (!::realpath(www.c_str(), resolved) || !is_file(string(resolved) + "/index.html")) { std::fprintf(stderr, "no index.html in %s\n", www.c_str()); return 1; }
  WWW = resolved;
  if (port <= 0 || port > 65535) { std::fprintf(stderr, "bad port\n"); return 1; }

  detect_profile(forced);
  quota_bytes = (quota_mb >= 0 ? static_cast<unsigned long long>(quota_mb) : profile.quota_mb) << 20;
  CACHE = ROOT + "/.hub-cache";
  if (is_dir(CACHE)) { unsigned long long freed = 0; remove_tree(CACHE, freed); } // lists left by an earlier run
  load_devices();
  std::printf("hubd: %s://%s:%d  (reading %s)\n", tls_on ? "https" : "http", host == "0.0.0.0" ? "localhost" : host.c_str(), port, ROOT.c_str());
  std::printf("device: %s profile, %u cores, %llu MB memory; uploads up to %zu MB, %d connections at once\n", profile.name, device_cores, device_memory_mb, profile.max_upload >> 20, profile.max_conns);
  if (profile.sole_writer) {
    // Nothing else writes here: measure once now, then keep count as files are written.
    Scan s = look_over();
    std::printf("folder: %llu files, %llu MB; only this server changes it, so it is not watched\n", s.files, s.bytes >> 20);
  } else {
    std::thread(watch_loop).detach();
    std::printf("folder: checked for changes every %d ms\n", profile.watch_ms);
  }
  // On the board this is also when FatFS counts the card's free space (once; a few seconds at most).
  uint64_t disk_total = 0, disk_free = 0;
  if (fs::space(ROOT, disk_total, disk_free)) std::printf("disk: %llu MB free of %llu MB", static_cast<unsigned long long>(disk_free >> 20), static_cast<unsigned long long>(disk_total >> 20));
  else std::printf("disk: free space unknown");
  if (quota_bytes) std::printf("; the folder may hold up to %llu MB\n", quota_bytes >> 20);
  else std::printf("; the folder may fill it, less 16 MB\n");
#ifdef ESP_PLATFORM
  std::printf("memory: %u bytes free, largest block %u (also at /api/device)\n", static_cast<unsigned>(esp_get_free_heap_size()), static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
#endif
  std::printf("%zu paired device%s%s\n", devices.size(), devices.size() == 1 ? "" : "s", pair_local ? "" : "; this machine's own browser needs no pairing");
  // With nobody paired yet, someone has to be let in: offer a code on the terminal.
  if (devices.empty() && (pair_local || !loopback(host))) { std::lock_guard<std::mutex> g(auth_lock); offer_code(true); }
  std::fflush(stdout);
  http::Options opt;
  opt.host = host;
  opt.port = port;
  opt.tls = tls_on ? &tls : nullptr;
  opt.max_conns = profile.max_conns;
  opt.keepalive_ms = profile.keepalive_ms;
  opt.piece = profile.piece;
  return http::serve(opt, route);
}
