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
// File access goes through dirent/stat/stdio, and the few calls that differ
// between systems through platform.hpp; ESP-IDF maps all of it onto an SD card.
// Where the card needs FatFS itself (listing folders, files over 2 GB), it goes
// through fs.hpp. So these handlers run on the ESP32 unchanged.
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "esp_system.h"
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <ctime>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string_view>
#include <vector>

#include "../vendor/cJSON.h"
#include "anchor.hpp"
#include "epub.hpp"
#include "http.hpp"
#include "links.hpp"
#include "status.hpp"

using std::string;
using Strings = std::vector<string>;

// The folder of documents. It can change while the server runs (another
// workspace is opened), so each thread works on its own copy, taken when its
// request begins: a request sees one folder from start to finish.
static thread_local string ROOT;
static string HOME_DIR;                // the folder the server was started on
static string WORKSPACES;              // where uploads opened as workspaces of their own are kept; "" if this server keeps none
static std::mutex root_lock;
static string open_root;               // the workspace that is open: HOME_DIR, or a folder in WORKSPACES
static string root_now() { std::lock_guard<std::mutex> g(root_lock); return open_root; }
// What a page calls the workspace it shows (`workspace` in /api/config, sent back as X-Hub-Workspace): a hash of its
// folder, so the folder's name, in whatever letters, never has to travel in a header.
static string workspace_id(const string &root) {
  unsigned long long h = 1469598103934665603ULL;
  for (char ch : root) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;
  char out[17];
  std::snprintf(out, sizeof out, "%016llx", h);
  return out;
}
static string WWW;                     // where index.html and the vendor scripts live
static string STATE;                   // certificates and the list of paired devices: never inside ROOT
static const char *FRONT = "FRONTPAGE.md";
static const size_t MAX_JSON = 1 << 20;          // 1 MB for API bodies

// What the server allows itself depends on what it is running on. The profile
// is picked once at start-up (see detect_profile) and can be forced with --profile.
static const size_t FAT32_MAX = 0xFFFFFFFFu; // the largest file FAT32 holds: 4 GB less a byte
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
  int max_depth;       // folders nested deeper than this are left out: each level is stack, and the board's threads have 12 KB
  // The most of one file held in memory at once: a page of a book, a file of links, a document being mapped for
  // anchors, the part of a file searched. Larger ones are answered 413, or searched only this far in.
  size_t most_held;
};
static const Profile PROFILES[] = {
    {"desktop", 200u << 20, false, 500, true, true, false, 64, 16, 64 * 1024, 5000, 20480, 0, 64, 16u << 20}, // a computer: plenty of memory, fast disk
    {"small", 50u << 20, false, 1000, true, true, false, 24, 8, 16 * 1024, 5000, 8192, 0, 64, 4u << 20},      // a Raspberry Pi class board: under 1 GB of memory
    // A microcontroller with a microSD card (FAT32, up to 32 GB) and a few hundred KB of memory
    // (the T3 V1.6.1). The card is the limit: no quota of its own. Uploads may be as large as
    // FAT32 allows: they go to the card in pieces, so the cost is time, not memory. Pages left
    // open cost little once loaded (a socket and an idle TLS session), so six may listen.
    // A file worked on whole takes two or three times its size while it is (a book's page
    // unpacked, a document split into blocks), so 32 KB of it at most.
    {"esp32", FAT32_MAX, true, 0, false, true, true, 4, 6, 4 * 1024, 2000, 0, 32 * 1024, 10, 32 * 1024},
    // The same with 2 MB or more of PSRAM (the T3-S3): TLS keeps its buffers there (mbedTLS
    // set to allocate outside), so only each connection's stack takes the internal memory;
    // the page and scripts are kept in memory, and folders of thousands sort in one pass.
    // Blocks over 16 KB go to PSRAM by themselves (CONFIG_SPIRAM_USE_MALLOC), so a file of 1 MB may be worked on whole.
    {"esp32-psram", FAT32_MAX, true, 0, true, true, true, 8, 12, 8 * 1024, 5000, 0, 512 * 1024, 10, 1u << 20},
};
static Profile profile = PROFILES[0];

// Whether there is memory for one more connection or open page. On the board a
// TLS connection needs a 16 KB block for an incoming record, and a thread
// stack; without them a newcomer waits (http::serve) or is refused, rather than
// failing halfway through and taking memory others need.
// With PSRAM, TLS buffers go there and only the stack (12 KB) needs internal memory.
static bool memory_for_one_more() {
#ifdef ESP_PLATFORM
  if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0)
    return heap_caps_get_free_size(MALLOC_CAP_INTERNAL) > 40 * 1024 && heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) > 16 * 1024 &&
           heap_caps_get_free_size(MALLOC_CAP_SPIRAM) > 96 * 1024;
  return esp_get_free_heap_size() > 48 * 1024 && heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) > 20 * 1024;
#else
  return true;
#endif
}
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
// The first `max` bytes of a file: enough to tell what kind of file it is without reading a large one whole.
static bool read_start(const string &p, string &out, size_t max) {
  FILE *f = std::fopen(p.c_str(), "rb");
  if (!f) return false;
  out.resize(max);
  out.resize(std::fread(&out[0], 1, max, f));
  std::fclose(f);
  return true;
}
// The folders above a file, those that are missing: usually none, which costs
// one look rather than a mkdir for every folder from the top (each a directory
// search on FAT).
static void make_dirs(const string &dir) {
  if (dir.empty() || is_dir(dir)) return;
  make_dirs(dirname_of(dir));
  sys::make_dir(dir);
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

// A file removed by this server, taken off the count of what is stored.
static bool remove_file(const string &abs) {
  uint64_t size = 0;
  fs::file_size(abs, size);
  if (::unlink(abs.c_str()) != 0) return false;
  changed(abs, -static_cast<long long>(size));
  return true;
}
// A copy of a file, made a piece at a time (never held whole), under a temporary name until it is complete.
static bool copy_file(const string &from, const string &to) {
  FILE *in = std::fopen(from.c_str(), "rb");
  if (!in) return false;
  uint64_t before = 0;
  fs::file_size(to, before);
  const string tmp = to + ".tmp";
  FILE *out = std::fopen(tmp.c_str(), "wb");
  if (!out) { std::fclose(in); return false; }
  char buf[1024];
  size_t n;
  long long total = 0;
  bool ok = true;
  while (ok && (n = std::fread(buf, 1, sizeof buf, in)) > 0) { ok = std::fwrite(buf, 1, n, out) == n; total += static_cast<long long>(n); }
  ok = !std::ferror(in) && ok;
  std::fclose(in);
  ok = std::fclose(out) == 0 && ok;
  if (!ok || !secure::replace(tmp, to)) { ::unlink(tmp.c_str()); return false; }
  changed(to, total - static_cast<long long>(before));
  return true;
}

// Delete a folder and everything in it. Links are removed, never followed.
// What the removed files held is added to `freed`.
static bool remove_tree(const string &dir, unsigned long long &freed, int depth = 0) {
  if (depth > 64) return false; // a loop, or nothing a person made
  DIR *d = ::opendir(dir.c_str());
  if (!d) return false;
  bool ok = true;
  while (struct dirent *e = ::readdir(d)) {
    string name = e->d_name;
    if (name == "." || name == "..") continue;
    string abs = dir + "/" + name;
    if (sys::is_link(abs)) { ok = sys::remove_link(abs) && ok; continue; }
    struct stat st;
    if (::stat(abs.c_str(), &st) != 0) { ok = false; continue; }
    if (S_ISDIR(st.st_mode)) ok = remove_tree(abs, freed, depth + 1) && ok;
    else if (::unlink(abs.c_str()) == 0) freed += S_ISREG(st.st_mode) ? fs::size_of(st) : 0;
    else ok = false;
  }
  ::closedir(d);
  return ::rmdir(dir.c_str()) == 0 && ok;
}
// The same, with what it held taken off the count of what is stored.
static bool remove_tree(const string &dir) {
  unsigned long long freed = 0;
  const bool ok = remove_tree(dir, freed);
  changed(dir, -static_cast<long long>(freed));
  return ok;
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
    if (strict && (part[0] == '.' || lower(part) == "node_modules")) return false;
#ifdef _WIN32
    if (sys::odd_on_windows(part)) return false;
#endif
    parts.push_back(part);
  }
  return !parts.empty();
}
// How many folders deep a relative path is ("" is the top).
static int depth_of(const string &rel) { return rel.empty() ? 0 : 1 + static_cast<int>(std::count(rel.begin(), rel.end(), '/')); }
static void too_deep(const string &rel) {
  static std::atomic<bool> said{false};
  if (!said.exchange(true)) std::printf("folders nested deeper than %s are left out (the limit keeps a thread's stack from running out)\n", rel.c_str());
}

static string join(const Strings &parts) {
  string out;
  for (const string &p : parts) out += (out.empty() ? "" : "/") + p;
  return out;
}

static const Strings CODE_EXT = {".c", ".h", ".cpp", ".hpp", ".cc", ".py", ".js", ".ts", ".rs", ".go", ".java", ".sh"};
static bool is_html(const string &name) { return ends_with(name, ".html") || ends_with(name, ".htm") || ends_with(name, ".xhtml"); }
static bool readable(const string &name) {
  return ends_with(name, ".md") || is_html(name) || name == "Makefile" ||
         std::find(CODE_EXT.begin(), CODE_EXT.end(), ext_of(name)) != CODE_EXT.end();
}
// Pictures, video, sound and PDFs are listed too; the reader shows them in a viewer.
static bool is_media(const string &name) {
  static const Strings media = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mp3", ".m4a", ".wav", ".ogg"};
  return std::find(media.begin(), media.end(), lower(ext_of(name))) != media.end();
}
// Text and JSON files are listed only when they hold web addresses: a file of saved links, shown as media cards.
static bool is_link_file(const string &name) {
  static const Strings kinds = {".txt", ".json", ".jsonl", ".ndjson", ".csv"};
  return std::find(kinds.begin(), kinds.end(), lower(ext_of(name))) != kinds.end();
}
static const size_t MAX_RANGE = 4u << 20; // most bytes sent in answer to one partial request
static const char *mime_of(const string &name) {
  static const std::pair<const char *, const char *> types[] = {
      {".html", "text/html"}, {".htm", "text/html"}, {".css", "text/css"}, {".js", "text/javascript"},
      {".xhtml", "application/xhtml+xml"}, {".otf", "font/otf"}, {".ttf", "font/ttf"}, {".woff", "font/woff"},
      {".mjs", "text/javascript"}, {".json", "application/json"}, {".svg", "image/svg+xml"}, {".png", "image/png"},
      {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}, {".gif", "image/gif"}, {".webp", "image/webp"},
      {".pdf", "application/pdf"}, {".wasm", "application/wasm"}, {".woff2", "font/woff2"}, {".mp4", "video/mp4"}, {".m4v", "video/mp4"},
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
  profile = heap_caps_get_total_size(MALLOC_CAP_SPIRAM) >= (1u << 20) ? PROFILES[3] : PROFILES[2];
  device_memory_mb = (heap_caps_get_total_size(MALLOC_CAP_INTERNAL) + heap_caps_get_total_size(MALLOC_CAP_SPIRAM)) >> 20;
#else
  device_memory_mb = sys::memory_mb();
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
// A JSON file the server keeps (settings, notes). Missing, or empty, is fine:
// nothing has been saved yet. Present but unreadable is not: a write cut short
// by a power cut, a hand edit gone wrong, or (on the board) too little memory
// to parse it. Saving over it would replace everything in it with one change,
// so whatever writes refuses while `intact` is false.
static cJSON *read_kept(const string &path, bool &intact) {
  string text;
  intact = true;
  if (!read_file(path, text)) { intact = !is_file(path); return nullptr; }
  if (text.find_first_not_of(" \t\r\n") == string::npos) return nullptr;
  cJSON *json = cJSON_Parse(text.c_str());
  if (!json) intact = false;
  return json;
}
static cJSON *read_settings_file(bool &intact) {
  cJSON *cfg = read_kept(ROOT + "/hub.json", intact);
  if (cfg && !cJSON_IsObject(cfg)) intact = false;
  if (!cJSON_IsObject(cfg)) { cJSON_Delete(cfg); cfg = cJSON_CreateObject(); }
  return cfg;
}
static cJSON *read_settings_file() { bool intact; return read_settings_file(intact); }

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
  cJSON_DeleteItemFromObjectCaseSensitive(cfg, "workspace");
  string title;
  if (FILE *f = std::fopen((ROOT + "/" + FRONT).c_str(), "rb")) {
    cJSON_AddStringToObject(cfg, "front", FRONT);
    if (md_title(f, title)) set_str(cfg, "title", title);
    std::fclose(f);
  } else {
    cJSON_AddNullToObject(cfg, "front");
  }
  cJSON_AddStringToObject(cfg, "root", ROOT.c_str());
  cJSON_AddStringToObject(cfg, "workspace", workspace_id(ROOT).c_str());
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

// The order of the list: natural_less, with names it finds equal ("a01",
// "a1") put in byte order so the order is total and the same on every disk.
static bool name_less(std::string_view a, std::string_view b) { return natural_less(a, b) || (!natural_less(b, a) && a < b); }

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

// ---- books -------------------------------------------------------------------
// An EPUB is listed as a folder of its pages, in reading order:
// "shelf/book.epub/OEBPS/ch1.xhtml". Such a path names a file inside the zip
// and is answered from there, so a page of a book is read, highlighted and
// annotated like any other page, and its pictures and styles are found beside it.

// The most of one file that is held in memory at once: an entry of a book, a document being mapped, a file searched.
static size_t most_in_memory() { return profile.most_held; }
// Whether a path goes into a book; if so, the book's file and the path inside it.
static bool in_book(const Strings &parts, string &book, string &inner) {
  for (size_t i = 0; i + 1 < parts.size(); i++) {
    if (lower(ext_of(parts[i])) != ".epub") continue;
    const auto cut = parts.begin() + static_cast<std::ptrdiff_t>(i) + 1;
    book = ROOT + "/" + join(Strings(parts.begin(), cut));
    if (!is_file(book)) return false;
    inner = join(Strings(cut, parts.end()));
    return true;
  }
  return false;
}
// One file of a book. 0, or the status to answer with.
static int book_item(const string &book, const string &inner, string &out) {
  std::vector<zip::Entry> entries;
  if (!zip::list(book, entries, most_in_memory())) return 404;
  const zip::Entry *e = zip::find(entries, inner);
  return e ? zip::read(book, *e, out, most_in_memory()) : 404;
}
static http::Response book_error(int status) { return http::error(status, status == 413 ? "too large to read from the book" : status == 500 ? "the book is damaged, or packed in a way not handled" : "no such file"); }
// What makes a file one of saved links, judged by its beginning so a long file is not read through for the list:
// a browser's export of bookmarks, and a text or JSON file with a web address in it.
static bool is_bookmarks(const string &abs) { string start; return read_start(abs, start, 512) && start.find("NETSCAPE-Bookmark-file") != string::npos; }
static bool has_addresses(const string &abs) {
  string start;
  return read_start(abs, start, 64 * 1024) && (start.find("https://") != string::npos || start.find("https:\\/\\/") != string::npos);
}
// How many items of such a file are read: all of them. Only the microcontroller, with its few hundred KB, stops at 2000.
static size_t most_links() { return string(profile.name) == "esp32" ? 2000 : static_cast<size_t>(-1); }
// Whether a path stays inside `top` (the workspace) once every link on the way is followed. A symbolic link put in the
// workspace by hand (an upload cannot make one) that leads out of it is neither listed, searched, counted nor served,
// and nothing is written through it; a link to elsewhere in the workspace is followed as before. A path that does not
// exist yet is judged by the nearest folder above it that does.
static bool inside(const string &abs, const string &top = ROOT) {
  string at = abs, real, root;
  while (!sys::final_path(at, real)) {
    const string up = dirname_of(at);
    if (up.empty() || up == at || at.size() <= top.size()) return true;   // nothing there, or no links on this system
    at = up;
  }
  if (!sys::final_path(top, root)) return true;
  return real == root || starts_with(real, root + "/");
}
static bool link_out(const string &abs) { return sys::is_link(abs) && !inside(abs); }

// Titles of the previous list, read alongside the new one. Both come out in
// the same order, so one pass over the old file finds each title that can be
// reused (its file's size and time unchanged) without opening the file. After
// a change, a new list then costs a look at each folder rather than reading
// the start of every document: on the board's SPI card that is the difference
// between a fraction of a second and many seconds for a thousand documents.
// Each line: stamp, tab, path, tab, kind, tab, title, with \\ \t \n \r escaped.
// The kind is what the start of the file said, kept so it is not read again
// either: 'd' a document, 'l' a page of links (a browser's bookmarks, a file of
// saved links), 'n' not listed (a text file with no web address in it).
static string escape_line(const string &s) {
  string out;
  for (char c : s) {
    if (c == '\\') out += "\\\\";
    else if (c == '\t') out += "\\t";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else out += c;
  }
  return out;
}
static string unescape_line(const char *s, size_t n) {
  string out;
  for (size_t i = 0; i < n; i++) {
    if (s[i] != '\\' || i + 1 == n) { out += s[i]; continue; }
    char c = s[++i];
    out += c == 't' ? '\t' : c == 'n' ? '\n' : c == 'r' ? '\r' : c;
  }
  return out;
}
// The order of the list, for two whole paths: folder by folder, by name_less.
static bool path_less(const string &a, const string &b) {
  size_t i = 0, j = 0;
  for (;;) {
    size_t ei = a.find('/', i), ej = b.find('/', j);
    std::string_view ca(a.data() + i, (ei == string::npos ? a.size() : ei) - i), cb(b.data() + j, (ej == string::npos ? b.size() : ej) - j);
    if (ca != cb) return name_less(ca, cb);
    if (ei == string::npos || ej == string::npos) return ei == string::npos && ej != string::npos;
    i = ei + 1;
    j = ej + 1;
  }
}
struct OldTitles {
  FILE *f = nullptr;
  bool have = false;
  int64_t stamp = 0;
  string path, title;
  char kind = 'd';
  void next() {
    have = false;
    char line[1024];
    while (f && std::fgets(line, sizeof line, f)) {
      size_t n = std::strlen(line);
      if (n == 0 || line[n - 1] != '\n') { int c; while ((c = std::fgetc(f)) != EOF && c != '\n') {} continue; } // too long: not kept
      char *tab1 = std::strchr(line, '\t'), *tab2 = tab1 ? std::strchr(tab1 + 1, '\t') : nullptr;
      if (!tab2 || tab2[1] == '\0' || tab2[2] != '\t') continue;
      stamp = std::strtoll(line, nullptr, 16);
      path = unescape_line(tab1 + 1, static_cast<size_t>(tab2 - tab1 - 1));
      kind = tab2[1];
      title = unescape_line(tab2 + 3, n - 1 - static_cast<size_t>(tab2 + 3 - line));
      have = true;
      return;
    }
  }
  bool find(const string &p, int64_t st, string &out, char &out_kind) {
    while (have && path_less(path, p)) next();
    if (!have || path != p) return false;
    bool same = stamp == st;
    if (same) { out = title; out_kind = kind; }
    next();
    return same;
  }
};

struct Listing {
  Strings ignore, side;
  Sink *out;
  size_t budget;     // the profile's sort_budget
  size_t held = 0;   // what the folders being walked hold now, outer ones included
  bool first = true;
  OldTitles *old = nullptr; // titles to reuse
  Sink *titles = nullptr;   // where this list's titles are written for the next one
  const cJSON *names = nullptr; // files saved under a shorter name: saved -> asked (see fit_path); null if none
};

static void walk(const string &dir, const string &rel, Listing &ls);

// Whether an entry is in the list (a folder: whether it is walked). A link put
// in the workspace by hand that leads out of it is not.
static bool listed(bool is_dir, const string &name, const string &r, const string &abs, const Listing &ls) {
  if (name[0] == '.' || matches(r, ls.ignore) || link_out(abs)) return false;
  if (is_dir) return name != "node_modules" && name != "notes" && abs != WWW;
  return readable(name) || is_media(name) || lower(ext_of(name)) == ".epub" || is_link_file(name);
}
// One document of the list. `changed`, in seconds, is left out when negative (a book's page has none of its own).
static void put_doc(Listing &ls, const string &path, const string &group, string title, bool side, bool front, bool links, int64_t changed, const string &book_title) {
  // A file saved under a shorter name, or a page of such a book, says the path it was given ("asked"), and goes by the
  // name it was given where it would have gone by its file's name.
  string asked;
  const cJSON *n;
  if (ls.names) cJSON_ArrayForEach(n, ls.names) {
    const string saved = n->string ? n->string : "";
    if (saved.empty() || !cJSON_IsString(n) || !(path == saved || starts_with(path, saved + "/"))) continue;
    asked = n->valuestring + path.substr(saved.size());
    if (title == basename_of(path)) title = basename_of(asked);
    break;
  }
  Sink &o = *ls.out;
  o.put(ls.first ? "{\"path\":" : ",{\"path\":");
  ls.first = false;
  o.str(path);
  o.put(",\"group\":");
  o.str(group);
  o.put(",\"title\":");
  o.str(title);
  if (!book_title.empty()) { o.put(",\"bookTitle\":"); o.str(book_title); } // whose page it is, for wherever the page is named away from its book
  o.put(side ? ",\"side\":true" : ",\"side\":false");
  o.put(front ? ",\"front\":true" : ",\"front\":false");
  if (changed >= 0) { char num[32]; std::snprintf(num, sizeof num, ",\"changed\":%lld", static_cast<long long>(changed)); o.put(num); }
  if (links) o.put(",\"links\":true");
  if (!asked.empty()) { o.put(",\"asked\":"); o.str(asked); }
  o.put("}");
}
// The pages of a book, as documents, in reading order.
static void list_book(const string &abs, const string &rel, Listing &ls) {
  epub::Book book;
  {
    std::vector<zip::Entry> entries;
    if (!zip::list(abs, entries, most_in_memory()) || !epub::open(abs, entries, book, most_in_memory())) return;
  }
  const bool side = matches(rel, ls.side);   // a book's pages are on the side when the book is
  for (const epub::Chapter &c : book.chapters) {
    Strings parts;
    const string path = rel + "/" + c.path;
    if (!is_html(c.path) || !clean_parts(path, parts, true) || join(parts) != path) continue;   // not a page, or not a path the reader could ask for
    put_doc(ls, path, rel, c.title, side, false, false, -1, book.title);
  }
}
static void list_entry(const string &dir, const string &rel, const string &name, bool is_dir, int64_t time, uint64_t size, Listing &ls) {
  string r = rel.empty() ? name : rel + "/" + name, abs = dir + "/" + name;
  if (is_dir) { walk(abs, r, ls); return; }
  const bool doc = readable(name) || is_media(name);
  if (!doc && lower(ext_of(name)) == ".epub") { list_book(abs, r, ls); return; }
  // What needs the start of the file read (a title; whether it holds web addresses) comes from the last list
  // when the file is unchanged.
  string title = name;
  char kind = 'd';
  if (is_html(name) || ends_with(name, ".md") || !doc) {
    const int64_t stamp = time * 1000003LL + static_cast<int64_t>(size);
    if (!ls.old || !ls.old->find(r, stamp, title, kind)) {
      if (doc) { title = title_of(abs, name); kind = is_html(name) && is_bookmarks(abs) ? 'l' : 'd'; }
      else { title = name; kind = has_addresses(abs) ? 'l' : 'n'; }
    }
    if (ls.titles) {
      char head[32];
      std::snprintf(head, sizeof head, "%llx\t", static_cast<unsigned long long>(stamp));
      ls.titles->put(head);
      string line = escape_line(r) + "\t" + kind + "\t" + escape_line(title) + "\n";
      ls.titles->put(line.data(), line.size());
    }
    if (kind == 'n') return;
  }
  put_doc(ls, r, rel, title, matches(r, ls.side), doc && r == FRONT, kind == 'l', time, "");
}

// Some of one folder's names, held compactly: one buffer of entries ("d" or
// "f", the file's time and size, the name, a 0 byte) and an offset per entry. A vector rather than a
// string because its reserve() allocates exactly what is asked (a string's may
// double), which is what keeps the budget a budget.
struct Names {
  std::vector<char> text;
  std::vector<uint32_t> at;
  static const size_t HEAD = 1 + sizeof(int64_t) + sizeof(uint64_t);
  std::string_view name(size_t i) const { return std::string_view(text.data() + at[i] + HEAD); }
  bool is_dir(size_t i) const { return text[at[i]] == 'd'; }
  int64_t time(size_t i) const { int64_t v; std::memcpy(&v, text.data() + at[i] + 1, sizeof v); return v; }
  uint64_t size(size_t i) const { uint64_t v; std::memcpy(&v, text.data() + at[i] + 1 + sizeof(int64_t), sizeof v); return v; }
  size_t bytes() const { return text.capacity() + at.capacity() * sizeof(uint32_t); }
  // Room for one more name of `len` bytes within `budget` (0: no limit), less
  // what is `held` elsewhere. Two names always fit, so a pass always gets somewhere.
  bool room(size_t len, size_t budget, size_t held) {
    size_t need_t = text.size() + HEAD + len + 1, need_a = at.size() + 1;
    size_t cap_t = text.capacity() >= need_t ? text.capacity() : std::max(need_t, text.capacity() + text.capacity() / 2);
    size_t cap_a = at.capacity() >= need_a ? at.capacity() : std::max(need_a, at.capacity() + at.capacity() / 2);
    if (budget && at.size() >= 2 && held + cap_t + cap_a * sizeof(uint32_t) > budget) return false;
    text.reserve(cap_t);
    at.reserve(cap_a);
    return true;
  }
  void add(bool dir, int64_t time, uint64_t size, const string &name) {
    at.push_back(static_cast<uint32_t>(text.size()));
    text.push_back(dir ? 'd' : 'f');
    const char *raw = reinterpret_cast<const char *>(&time);
    text.insert(text.end(), raw, raw + sizeof time);
    raw = reinterpret_cast<const char *>(&size);
    text.insert(text.end(), raw, raw + sizeof size);
    text.insert(text.end(), name.begin(), name.end());
    text.push_back('\0');
  }
  void sort() { std::sort(at.begin(), at.end(), [&](uint32_t x, uint32_t y) { return name_less(text.data() + x + HEAD, text.data() + y + HEAD); }); }
  // Keep the first `n` (by name, after sort()), moving them down in place.
  void keep_first(size_t n) {
    at.resize(n);
    std::sort(at.begin(), at.end());
    size_t w = 0;
    for (uint32_t &x : at) {
      size_t len = HEAD + std::strlen(text.data() + x + HEAD) + 1;
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
  if (depth_of(rel) > profile.max_depth) { too_deep(rel); return; }
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
      b.add(e.dir, e.time, e.size, name);
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
        list_entry(dir, rel, name, true, 0, 0, ls);
        after = name;
        more = true;
        break;
      }
      list_entry(dir, rel, name, b.is_dir(i), b.time(i), b.size(i), ls);
    }
    if (!let_go) {
      ls.held -= mine;
      if (more) after = string(b.name(b.at.size() - 1));
    }
    first_pass = false;
  }
}

// The entries of a folder, for search and for a folder's file list: in name order where memory allows (a computer);
// on the board, whose memory a folder of thousands of names can outgrow, in the order the card keeps them.
template <class Fn>
static void each_entry(const string &dir, Fn &&fn) {
  if (profile.sort_budget) { fs::each(dir, [&](const fs::Entry &e) { fn(string(e.name), e.dir, e.size, e.time); }); return; }
  struct One { string name; bool dir; uint64_t size; int64_t time; };
  std::vector<One> all;
  fs::each(dir, [&](const fs::Entry &e) { all.push_back({e.name, e.dir, e.size, e.time}); });
  std::sort(all.begin(), all.end(), [](const One &x, const One &y) { return natural_less(x.name, y.name); });
  for (const One &o : all) fn(o.name, o.dir, o.size, o.time);
}

// Every file under a folder, with its size and when it was last changed. A device that
// holds the folder these came from works out from this what it has that is new or
// changed, and sends only that (see "update" in the reader). Hidden names and
// node_modules are left out, as an upload leaves them out. Written out as it is
// found, like the document list, with the name each was given if it was saved under
// a shorter one (`names`, see fit_path).
static void walk_files(const string &dir, const string &rel, const cJSON *names, Sink &out, bool &first) {
  if (depth_of(rel) > profile.max_depth) { too_deep(rel); return; }
  each_entry(dir, [&](const string &name, bool is_dir, uint64_t size, int64_t time) {
    if (name[0] == '.' || name == "node_modules") return;
    const string r = rel + "/" + name, abs = dir + "/" + name;
    if (link_out(abs)) return;
    if (is_dir) { if (abs != WWW) walk_files(abs, r, names, out, first); return; }
    out.put(first ? "{\"path\":" : ",{\"path\":");
    first = false;
    out.str(r);
    char num[64];
    std::snprintf(num, sizeof num, ",\"size\":%llu,\"changed\":%lld", static_cast<unsigned long long>(size), static_cast<long long>(time));
    out.put(num);
    const string asked = str_of(names, r.c_str());
    if (!asked.empty()) { out.put(",\"asked\":"); out.str(asked); }
    out.put("}");
  });
}

// ---- notes --------------------------------------------------------------------------

static cJSON *read_notes(bool &intact) {
  cJSON *notes = read_kept(ROOT + "/notes/notes.json", intact);
  if (notes && !cJSON_IsArray(notes)) intact = false;
  if (!cJSON_IsArray(notes)) { cJSON_Delete(notes); notes = cJSON_CreateArray(); }
  return notes;
}
// Before the notes or the settings are written, what the file held is kept beside it, under a hidden name the list,
// the watcher and /raw/ all leave alone: the version just before this write (".notes.prev.json"), and for the notes,
// the first version of each of the last seven days (".notes.2026-10-09.json"). A change that went wrong (a tool
// writing into the file, a hand edit, a device sending something odd) is undone by copying one of them back.
// The copies are made a piece at a time: the board has no room for a second whole notes file in memory.
static string now_iso();
static void keep_earlier(const string &file, const string &name, bool daily) {
  if (!is_file(file)) return;
  const string dir = dirname_of(file);
  copy_file(file, dir + "/." + name + ".prev.json");
  if (!daily) return;
  const string day = now_iso().substr(0, 10), copy = dir + "/." + name + "." + day + ".json";
  if (is_file(copy)) return;
  copy_file(file, copy);
  Strings days;
  if (DIR *d = ::opendir(dir.c_str())) {
    while (dirent *e = ::readdir(d)) {
      const string n = e->d_name;
      if (n.size() == name.size() + 17 && starts_with(n, "." + name + ".") && ends_with(n, ".json") && std::isdigit(static_cast<unsigned char>(n[name.size() + 2]))) days.push_back(n);
    }
    ::closedir(d);
  }
  std::sort(days.begin(), days.end());
  for (size_t i = 0; i + 7 < days.size(); i++) remove_file(dir + "/" + days[i]);
}
static bool write_notes(const cJSON *notes) {
  keep_earlier(ROOT + "/notes/notes.json", "notes", true);
  return write_json(ROOT + "/notes/notes.json", notes);
}
static bool write_settings(const cJSON *settings) {
  keep_earlier(ROOT + "/hub.json", "hub", false);
  return write_json(ROOT + "/hub.json", settings);
}

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
  sys::utc(t, tm);
  char buf[80]; // room for any int the compiler can imagine in each field (the board's build stops on a warning)
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
  return buf;
}

// ---- who is asking: host names, paired devices -----------------------------------------
// See ../API.md, "Security". State lives in STATE/devices.json; only a hash of
// each device's token is kept, so the file alone lets nobody in.

#ifdef ESP_PLATFORM
extern "C" const char *board_ip();
extern "C" const char *board_name(); // the name it answers to on the network, without ".local" (esp32/main/board.cpp)
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
  if (const char *name = board_name()) { out.push_back(lower(name)); out.push_back(lower(name) + ".local"); }
#else
  if (string h = lower(sys::host_name()); !h.empty()) {
    out.push_back(h);
    if (!ends_with(h, ".local") && h.find('.') == string::npos) out.push_back(h + ".local");
  }
#ifdef __APPLE__
  if (!mac_local_name().empty()) out.push_back(mac_local_name());
#endif
  for (const string &a : sys::ipv4_addresses()) out.push_back(a);
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
static int pair_fails_away = 0;                 // wrong codes from pages of other sites, counted apart (see /api/pair)

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
  pair_fails = pair_fails_away = 0;
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
  // Letters, digits, dots, hyphens, colons and brackets only: the address is
  // written into the page's content policy, where ";" or "," would start a new rule.
  return std::all_of(o.begin() + static_cast<long>(at), o.end(), [](unsigned char c) { return std::isalnum(c) || c == '.' || c == '-' || c == ':' || c == '[' || c == ']'; });
}
// Whether a page of another site is one on a home network, as another hub's reader is: its address is `localhost`, a
// name under `.local`, one of the ranges set aside for private networks (IPv4, or IPv6 fc00::/7 and fe80::/10), or a
// name this hub answers to. Only such a page may try a pairing code (26): a website out on the internet cannot.
static bool home_origin(const string &origin) {
  if (!plain_origin(origin)) return false;
  string host = lower(origin.substr(origin.find("://") + 3));
  if (!host.empty() && host[0] == '[') host = host.substr(0, host.find(']') + 1);
  else host = host.substr(0, host.rfind(':') == string::npos ? host.size() : host.rfind(':'));
  if (host == "[::1]" || secure::under(host, "localhost") || secure::under(host, "local") || secure::home_address(host)) return true;
  if (host.size() > 4 && host[0] == '[' && (host[1] == 'f') && (host[2] == 'c' || host[2] == 'd' || (host[2] == 'e' && std::strchr("89ab", host[3])))) return true;
  return known_host(host);
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
static thread_local string renew_cookie;   // set when this request's cookie should be sent again with a fresh year
// The cookie is named for the port (set in main): a browser keeps cookies by host name alone, whatever the port, so two
// hubs on one machine (the hub and a scratch one) would otherwise take each other's cookie; and a browser will not let
// a plain-HTTP hub replace a cookie of the same name that an HTTPS one marked Secure, so pairing with it never held.
// The name from before, "hub_device", is still read, so a device paired then stays paired.
static string COOKIE = "hub_device";
static string device_of(const http::Request &req, bool cross) {
  string cookie = bearer_of(req);
  const bool by_cookie = cookie.empty() && !cross;
  if (by_cookie) cookie = cookie_of(req, COOKIE);
  if (by_cookie && cookie.empty()) cookie = cookie_of(req, "hub_device");
  size_t dot = cookie.find('.');
  if (dot != string::npos) {
    string id = cookie.substr(0, dot), hash = secure::sha256_hex(cookie.substr(dot + 1)), today = now_iso().substr(0, 10);
    std::lock_guard<std::mutex> g(auth_lock);
    for (Device &d : devices) {
      if (d.id != id || !secure::same(d.hash, hash)) continue;
      if (d.seen != today) { d.seen = today; save_devices(); if (by_cookie) renew_cookie = cookie; } // one small write a day; the cookie's year starts again
      return d.id;
    }
  }
  return !cross && req.local && !pair_local ? "local" : "";
}

// ---- what is happening, for a screen (see status.hpp) ------------------------------

// Something that just happened, shown for a few seconds.
static std::mutex notice_lock;
static string notice_text;
static http::Clock::time_point notice_until;
static void notice(const string &text, int seconds = 10) {
  std::lock_guard<std::mutex> g(notice_lock);
  notice_text = text;
  notice_until = http::Clock::now() + std::chrono::seconds(seconds);
}
// Which paired device last asked for something, and from where. One entry per
// device that has asked since start-up.
struct Seen { string ip; http::Clock::time_point at; };
static std::mutex seen_lock;
static std::map<string, Seen> seen_devices;
static void saw(const string &device, const string &ip) {
  std::lock_guard<std::mutex> g(seen_lock);
  Seen &s = seen_devices[device];
  s.ip = ip;
  s.at = http::Clock::now();
}
static string ca_fingerprint_text;   // set at start-up when HTTPS is on
static int serve_port = 0;
static std::atomic<bool> serving{false};

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
  return "Set-Cookie: " + COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + (clear ? "0" : "31536000") + (tls ? "; Secure" : "") + "\r\n";
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
  Strings *temporary = nullptr;                // when wanted: .tmp files found (a few at most)
};
static unsigned long long mix(unsigned long long x) { // the last step of splitmix64
  x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
  x ^= x >> 27; x *= 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
static void scan(const string &dir, const string &rel, bool watched, Scan &s) {
  if (depth_of(rel) > profile.max_depth) { too_deep(rel); return; }
  fs::each(dir, [&](const fs::Entry &e) {
    string name = e.name, abs = dir + "/" + name, r = rel.empty() ? name : rel + "/" + name;
    if (link_out(abs)) return;   // a link put in by hand that leads out of the workspace: not counted, not watched
    const bool w = watched && name[0] != '.' && name != "node_modules";
    if (e.dir) { if (abs != WWW) scan(abs, r, w, s); return; }
    s.bytes += e.size;
    s.files++;
    if (s.temporary && ends_with(name, ".tmp") && s.temporary->size() < 64) s.temporary->push_back(abs);
    if (!w || ends_with(name, ".tmp")) return;
    const long long own = e.time * 1000003LL + static_cast<long long>(e.size);
    unsigned long long h = 1469598103934665603ULL;
    for (char ch : r) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;
    s.stamp += mix(h ^ static_cast<unsigned long long>(own));
    if (s.each) (*s.each)[r] = own;
  });
}
static Scan look_over(std::map<string, long long> *each = nullptr, Strings *temporary = nullptr) {
  Scan s;
  s.each = each;
  s.temporary = temporary;
  scan(ROOT, "", true, s);
  if (ROOT != root_now()) return s;   // this request began before another workspace was opened
  std::lock_guard<std::mutex> g(usage_lock);
  usage_count = static_cast<long long>(s.bytes);
  usage_at = http::Clock::now();
  usage_known = true;
  return s;
}
// What a folder other than the open workspace holds, measured now (a removed folder, another workspace).
static unsigned long long tree_size(const string &dir) {
  Scan s;
  scan(dir, "", false, s);
  return s.bytes;
}
// After a power cut. On the board's FAT a save is "delete the old file, then
// rename the new one into place" (secure::replace), so a cut between the two
// leaves only "x.tmp", complete. A .tmp beside its file is a save that never
// finished: the file is the good copy. An upload's temporary ("x.1a2b3c4d.tmp")
// is always partial. Elsewhere a rename replaces in one step, so nothing here
// is needed and nothing is touched.
static bool recover(const string &tmp) {
#ifdef ESP_PLATFORM
  string target = tmp.substr(0, tmp.size() - 4);
  size_t dot = target.rfind('.');
  bool upload = dot != string::npos && target.size() - dot == 9 && std::all_of(target.begin() + static_cast<long>(dot) + 1, target.end(), [](unsigned char c) { return std::isxdigit(c); });
  bool dir;
  uint64_t size;
  if (!upload && !fs::info(target, dir, size) && ::rename(tmp.c_str(), target.c_str()) == 0) {
    std::printf("recovered %s from a save cut short\n", target.c_str());
    return true;
  }
  ::unlink(tmp.c_str());
  return true;
#else
  (void)tmp;
  return false;
#endif
}
static void recover_folder(const string &dir) {
  Strings found;
  fs::each(dir, [&](const fs::Entry &e) { if (!e.dir && ends_with(e.name, ".tmp")) found.push_back(dir + "/" + e.name); });
  for (const string &t : found) recover(t);
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
// ---- removed folders ------------------------------------------------------------------------
// A folder taken out of the workspace is moved, not deleted: into .removed/ in the workspace, a hidden name, so it is
// neither listed, watched nor served. Each is .removed/<undo>/<its name>, beside .removed/<undo>.json, which says where
// it was, when it was removed, and the locks it had. It can be put back (POST /api/folder/restore) until it is let go:
// seven days after it was removed, or sooner, oldest first, when something being saved needs its room (room_for).
static const string REMOVED = ".removed";
static std::mutex removed_lock;   // taken after store_lock where both are
struct Removed { string undo, from, at; unsigned long long size; bool locked; };
static bool undo_ok(const string &undo) {
  return !undo.empty() && undo.size() <= 40 && std::all_of(undo.begin(), undo.end(), [](unsigned char c) { return std::isdigit(c) || std::islower(c); });
}
static std::vector<Removed> removed_list(const string &root) {
  std::vector<Removed> out;
  const string dir = root + "/" + REMOVED;
  if (DIR *d = ::opendir(dir.c_str())) {
    while (dirent *e = ::readdir(d)) {
      const string n = e->d_name;
      if (!ends_with(n, ".json") || !undo_ok(n.substr(0, n.size() - 5))) continue;
      string text;
      if (!read_file(dir + "/" + n, text)) continue;
      Json info(cJSON_Parse(text.c_str()));
      const string undo = n.substr(0, n.size() - 5);
      const cJSON *locks = cJSON_GetObjectItemCaseSensitive(info.p, "locks");
      out.push_back({undo, str_of(info.p, "from"), str_of(info.p, "at"), tree_size(dir + "/" + undo), cJSON_IsObject(locks) && cJSON_GetArraySize(locks) > 0});
    }
    ::closedir(d);
  }
  std::sort(out.begin(), out.end(), [](const Removed &a, const Removed &b) { return a.at < b.at; });   // oldest first
  return out;
}
static void let_go(const string &root, const string &undo) {
  remove_tree(root + "/" + REMOVED + "/" + undo);   // what it held comes off the count (see changed)
  remove_file(root + "/" + REMOVED + "/" + undo + ".json");
}
// Those removed more than seven days ago. Their time is the server's own, written as it removed them.
static void let_go_old(const string &root) {
  const std::time_t week_ago = std::time(nullptr) - 7 * 24 * 3600;
  std::tm tm{};
  sys::utc(week_ago, tm);
  char cut[40];
  std::snprintf(cut, sizeof cut, "%04d-%02d-%02dT%02d:%02d:%02d", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
  for (const Removed &r : removed_list(root)) if (r.at < cut) let_go(root, r.undo);
}
// Whether `more` bytes may be added: under the quota, and leaving the disk 16 MB to breathe.
static bool room_for(unsigned long long more) {
  for (;;) {
    if (free_bytes() >= more + (16ULL << 20) && (quota_bytes == 0 || used_bytes() + more <= quota_bytes)) return true;
    // Not enough: what was removed longest ago is let go, one at a time, until there is, or nothing removed is left.
    std::lock_guard<std::mutex> g(removed_lock);
    const std::vector<Removed> list = removed_list(ROOT);
    if (list.empty()) return false;
    let_go(ROOT, list.front().undo);
  }
}
// The same for a folder other than the open workspace, measured as it is now.
static bool room_in(const string &dir, unsigned long long more) {
  if (dir == ROOT) return room_for(more);
  if (free_bytes() < more + (16ULL << 20)) return false;
  return quota_bytes == 0 || tree_size(dir) + more <= quota_bytes;
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
  if (!starts_with(abs, ROOT + "/") || ROOT != root_now()) return;   // the count is the open workspace's (not the state folder's, nor another workspace's)
  used_more(delta);
  const string rel = abs.substr(ROOT.size() + 1);
  bool in_list;
  if (!watched_path(rel, in_list)) return;
  if (in_list) generation++;
  if (profile.sole_writer) announce(rel); // elsewhere the watcher reports it
}
static void watch_loop() {
  std::map<string, long long> before;
  ROOT = root_now();
  string watching = ROOT;
  try { look_over(&before); } catch (...) {}
  auto pinged = http::Clock::now();
  for (;;) {
    std::this_thread::sleep_for(std::chrono::milliseconds(profile.watch_ms));
    try {
    ROOT = root_now();
    // Another workspace was opened: start afresh there, with nothing to announce.
    if (ROOT != watching) { watching = ROOT; before.clear(); look_over(&before); continue; }
    { std::lock_guard<std::mutex> g(clients_lock); if (clients.empty()) continue; }
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
    } catch (...) { before.clear(); }   // out of memory on a large folder must not end the server: start the comparison again
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
  long long stamp = stamp_of(abs);
  if (stamp < 0) return http::error(404, "no such file");
  if (!profile.cache_assets) { http::Response r = file_response(abs, type); r.etag = "\"" + std::to_string(stamp) + "\""; return r; }
  http::Response r;
  r.type = type;
  r.etag = "\"" + std::to_string(stamp) + "\"";
  std::lock_guard<std::mutex> g(cache_lock);
  CachedFile &c = asset_cache[abs];
  if (c.stamp != stamp || c.body.empty()) { if (!read_file(abs, c.body)) return http::error(404, "no such file"); c.stamp = stamp; }
  r.body = c.body;
  return r;
}
// One number that changes whenever a file pages care about is added, removed, resized or rewritten (see look_over),
// worked out at most once per watch interval: a burst of requests for the list costs one look over the folder, not one
// each. A change made through this server (touch_tree) makes the next request look again at once. On the board,
// where only this server writes, it is not needed: changes are counted as they are made (generation).
static std::mutex stamp_lock;
static unsigned long long stamp_value = 0;
static http::Clock::time_point stamp_at;
static string stamp_root;
static bool stamp_fresh = false;
static void touch_tree() {
  generation++;
  std::lock_guard<std::mutex> g(stamp_lock);
  stamp_fresh = false;
}
static unsigned long long tree_stamp() {
  std::lock_guard<std::mutex> g(stamp_lock);
  if (!stamp_fresh || stamp_root != ROOT || http::Clock::now() - stamp_at > std::chrono::milliseconds(profile.watch_ms)) {
    unsigned long long h = look_over().stamp;
    for (char ch : ROOT) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;   // two workspaces never share a list
    stamp_value = h;
    stamp_at = http::Clock::now();
    stamp_root = ROOT;
    stamp_fresh = true;
  }
  return stamp_value;
}

// The document list, kept between requests until something listed changes.
// On the board it may be larger than the free memory, so it is kept in a file
// in a hidden folder beside the documents (CACHE). Each new list is a new file;
// an old one is deleted once the last answer still sending it has finished.
static string CACHE;
struct ListFile {
  string path, titles;      // the list, and its titles for the next one (see OldTitles)
  uint64_t size = 0, titles_size = 0;
  ~ListFile() {
    if (::unlink(path.c_str()) == 0) used_more(-static_cast<long long>(size));
    if (::unlink(titles.c_str()) == 0) used_more(-static_cast<long long>(titles_size));
  }
};
static std::mutex listing_lock;  // one list made at a time: two pages asking at once share the work
static string listing_mem;
static std::shared_ptr<ListFile> listing_file;
static unsigned long long listing_gen = 0, listing_stamp = 0, listing_made = 0;
static string listing_root;      // the workspace it is the list of
static bool listing_ok = false;

static cJSON *read_names(const string &base);

static void make_list(Sink &out, OldTitles *old = nullptr, Sink *titles = nullptr) {
  Json cfg(read_config());
  Listing ls{list_of(cfg.p, "ignore"), list_of(cfg.p, "side"), &out, profile.sort_budget};
  ls.old = old;
  ls.titles = titles;
  Json names(read_names(ROOT));
  if (cJSON_GetArraySize(names.p) > 0) ls.names = names.p;
  if (old) old->next();
  out.put("[");
  walk(ROOT, "", ls);
  out.put("]");
  out.flush();
}
// Into a new file in CACHE; null if it could not be written (a full disk).
static std::shared_ptr<ListFile> make_list_file() {
  auto file = std::make_shared<ListFile>();
  const string n = std::to_string(++listing_made);
  file->path = CACHE + "/docs-" + n + ".json";
  file->titles = CACHE + "/titles-" + n + ".tsv";
  make_dirs(CACHE);
  using File = std::unique_ptr<FILE, int (*)(FILE *)>;
  File f(std::fopen(file->path.c_str(), "wb"), std::fclose), t(std::fopen(file->titles.c_str(), "wb"), std::fclose);
  if (!f || !t) return nullptr;
  File before(listing_file ? std::fopen(listing_file->titles.c_str(), "rb") : nullptr, std::fclose);
  OldTitles old;
  old.f = before.get();
  Sink out, titles;
  out.file = f.get();
  titles.file = t.get();
  make_list(out, &old, &titles);
  titles.flush();
  if (std::fclose(f.release()) != 0 || !out.ok || !fs::file_size(file->path, file->size)) return nullptr;
  if (std::fclose(t.release()) != 0 || !titles.ok || !fs::file_size(file->titles, file->titles_size)) file->titles_size = 0;
  used_more(static_cast<long long>(file->size + file->titles_size));
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
// A page named under "scripts" in hub.json is a small program of the user's
// own, and may run: its own inline scripts, files picked or dropped into it,
// pictures and media from the web. It runs as a stranger, though: the sandbox
// leaves out allow-same-origin, so the page has an origin of its own, with no
// cookie of the reader's, no storage, and no way to ask this server for
// anything (a request from it is one from another site, and is refused).
static const char *CSP_APP =
    "Content-Security-Policy: sandbox allow-scripts allow-downloads allow-popups allow-modals allow-forms; default-src 'none'; "
    "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; media-src https: data: blob:; connect-src https:; "
    "frame-src https:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'\r\n";
// The page of cards made from a file of links: pictures and media from the
// web and nothing else. No script, and no share in the reader's origin. A
// link in it opens in a tab of its own, as an ordinary page.
// The one script in it is the server's own, and the only one allowed: the
// policy names its nonce, made afresh for each answer.
static string csp_cards(const string &nonce) {
  return "Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'nonce-" + nonce + "'; "
         "img-src https: data:; media-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'\r\n";
}
static const char *CSP_DATA = "Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'\r\n";
static const char *COMMON_HEADERS = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\nX-DNS-Prefetch-Control: off\r\n";

// The files that make up the page. Nothing else in WWW is served.
static const std::pair<const char *, const char *> ASSETS[] = {
    {"/app.js", "app.js"}, {"/local.js", "local.js"}, {"/vault.js", "vault.js"},
    {"/vendor/marked.js", "node_modules/marked/lib/marked.umd.js"},
    {"/vendor/highlight.js", "node_modules/@highlightjs/cdn-assets/highlight.min.js"},
    {"/vendor/purify.js", "node_modules/dompurify/dist/purify.min.js"},
    // PDF.js, which draws a PDF's pages where the browser has no viewer for a frame (a phone). Asked for only when such a PDF is opened.
    {"/vendor/pdf.mjs", "node_modules/pdfjs-dist/legacy/build/pdf.min.mjs"},
    {"/vendor/pdf.worker.mjs", "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"}};

// ---- workspaces ----------------------------------------------------------------------------
// The folder the server was started on is "home". A folder uploaded "as its
// own workspace" is kept in WORKSPACES and can be opened in home's place, with
// its own notes and settings; home stays on disk and can be switched back to.

// A name a person typed, made safe to be a folder name: letters, digits, "_",
// spaces, dots and hyphens only; no leading or trailing dots or spaces.
static string clean_name(const string &name) {
  string out;
  bool gap = false;
  for (char ch : name) {
    const unsigned char c = static_cast<unsigned char>(ch);
    if (std::isalnum(c) || c == '_' || c == ' ' || c == '.' || c == '-') { if (gap) out += ' '; gap = false; out += static_cast<char>(c); }
    else gap = true;
  }
  if (gap) out += ' ';
  size_t a = out.find_first_not_of(" ."), b = out.find_last_not_of(" .");
  return a == string::npos ? "" : out.substr(a, b - a + 1).substr(0, 80);
}
struct Workspace { string name, root; bool home; };
static std::vector<Workspace> list_workspaces() {
  std::vector<Workspace> out = {{basename_of(HOME_DIR), HOME_DIR, true}};
  if (WORKSPACES.empty()) return out;
  Strings names;
  if (DIR *d = ::opendir(WORKSPACES.c_str())) {
    while (dirent *e = ::readdir(d)) if (e->d_name[0] != '.' && is_dir(WORKSPACES + "/" + e->d_name)) names.push_back(e->d_name);
    ::closedir(d);
  }
  std::sort(names.begin(), names.end(), natural_less);
  for (const string &n : names) out.push_back({n, WORKSPACES + "/" + n, false});
  return out;
}
static http::Response workspaces_response() {
  Json list(cJSON_CreateArray());
  for (const Workspace &w : list_workspaces()) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "name", w.name.c_str());
    cJSON_AddStringToObject(o, "root", w.root.c_str());
    cJSON_AddBoolToObject(o, "home", w.home);
    cJSON_AddBoolToObject(o, "current", w.root == ROOT);
    cJSON_AddStringToObject(o, "workspace", workspace_id(w.root).c_str());
    cJSON_AddItemToArray(list.p, o);
  }
  return json_response(list.p);
}
// Open a workspace in place of the one that is open, and remember the choice for the next start.
static void open_workspace(const Workspace &w) {
  { std::lock_guard<std::mutex> g(root_lock); open_root = w.root; }
  ROOT = w.root;
  { std::lock_guard<std::mutex> g(usage_lock); usage_known = false; }
  if (!WORKSPACES.empty()) { make_dirs(WORKSPACES); write_file(WORKSPACES + "/.current", w.home ? "" : w.name); }
  // Every open page is told at once: one still showing the workspace before goes no further with it (see answer).
  Json msg(cJSON_CreateObject());
  cJSON_AddStringToObject(msg.p, "workspace", workspace_id(w.root).c_str());
  tell_clients("data: " + dump(msg.p) + "\n\n");
}

// A highlight's anchor as it will be stored: the known fields only, each
// within bounds. nullptr if there is nothing usable in it.
static cJSON *clean_anchor(const cJSON *in) {
  if (!cJSON_IsObject(in)) return nullptr;
  const string block = str_of(in, "block");
  if (block.empty() || block.size() > 32 || !std::all_of(block.begin(), block.end(), [](unsigned char c) { return std::isxdigit(c); })) return nullptr;
  auto number = [&](const char *key) { const cJSON *v = cJSON_GetObjectItemCaseSensitive(in, key); return cJSON_IsNumber(v) && v->valuedouble >= 0 && v->valuedouble < 1e9 ? static_cast<double>(static_cast<long>(v->valuedouble)) : 0.0; };
  auto words = [&](const char *key) { const string s = str_of(in, key); return s.size() <= 200 ? s : string(); };   // the words on either side: a few dozen characters
  cJSON *a = cJSON_CreateObject();
  cJSON_AddStringToObject(a, "block", block.c_str());
  cJSON_AddNumberToObject(a, "nth", number("nth"));
  cJSON_AddNumberToObject(a, "start", number("start"));
  cJSON_AddStringToObject(a, "before", words("before").c_str());
  cJSON_AddStringToObject(a, "after", words("after").c_str());
  return a;
}

// The same for a highlight on a PDF's page, which the document engine places: { doc, anchor }. `doc` is the file's
// SHA-256, and `anchor` what the engine made (its API.md, "Anchor"), handed back to it as it is: the known fields
// only, each within bounds, and nothing of it is read here. nullptr if it is not usable.
static cJSON *clean_mg(const cJSON *in) {
  if (!cJSON_IsObject(in)) return nullptr;
  const string doc = str_of(in, "doc");
  const cJSON *from = cJSON_GetObjectItemCaseSensitive(in, "anchor"), *quote = cJSON_GetObjectItemCaseSensitive(from, "quote");
  if (doc.size() != 64 || !std::all_of(doc.begin(), doc.end(), [](unsigned char c) { return std::isxdigit(c); })) return nullptr;
  const string unit = str_of(from, "unit"), exact = str_of(quote, "exact");
  if (!cJSON_IsObject(from) || unit.empty() || unit.size() > 200 || exact.empty() || exact.size() > 20000) return nullptr;
  auto number = [](const cJSON *o, const char *key, cJSON *to) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    const bool ok = cJSON_IsNumber(v) && v->valuedouble > -1e9 && v->valuedouble < 1e9;
    if (ok) cJSON_AddNumberToObject(to, key, v->valuedouble);
    return ok;
  };
  auto words = [&](const char *key) { const string s = str_of(quote, key); return s.size() <= 2000 ? s : string(); };
  cJSON *a = cJSON_CreateObject(), *q = cJSON_AddObjectToObject(a, "quote");
  cJSON_AddStringToObject(a, "unit", unit.c_str());
  number(from, "unitIndex", a);
  cJSON_AddStringToObject(q, "exact", exact.c_str());
  cJSON_AddStringToObject(q, "prefix", words("prefix").c_str());
  cJSON_AddStringToObject(q, "suffix", words("suffix").c_str());
  if (const cJSON *at = cJSON_GetObjectItemCaseSensitive(from, "position"); cJSON_IsObject(at)) {
    cJSON *to = cJSON_CreateObject();
    if (number(at, "start", to) && number(at, "end", to)) cJSON_AddItemToObject(a, "position", to); else cJSON_Delete(to);
  }
  const string cfi = str_of(from, "cfi");
  if (!cfi.empty() && cfi.size() <= 2000) cJSON_AddStringToObject(a, "cfi", cfi.c_str());
  // One box for each run of the highlight's words: a long one has a few dozen.
  if (const cJSON *rects = cJSON_GetObjectItemCaseSensitive(from, "rects"); cJSON_IsArray(rects) && cJSON_GetArraySize(rects) <= 2000) {
    cJSON *to = cJSON_AddArrayToObject(a, "rects");
    const cJSON *r;
    cJSON_ArrayForEach(r, rects) {
      cJSON *box = cJSON_CreateObject();
      if (number(r, "x0", box) && number(r, "x1", box) && number(r, "y0", box) && number(r, "y1", box)) cJSON_AddItemToArray(to, box); else cJSON_Delete(box);
    }
  }
  cJSON *mg = cJSON_CreateObject();
  cJSON_AddStringToObject(mg, "doc", lower(doc).c_str());
  cJSON_AddItemToObject(mg, "anchor", a);
  return mg;
}

// ---- when a note was changed ------------------------------------------------------------------
// The page stamps each change to a note with a hybrid logical clock: 16 digits of milliseconds, 4 of a counter, and a
// name for the device ("0001760000000000-0002-k3x9a1"). The device takes the later of its own clock and the latest
// stamp it has seen, so a device whose clock is behind still stamps its changes after the ones it was shown; and the
// fixed widths make stamps compare as text in the order they were made. A note keeps the stamp of the last change to
// each of three parts of it (`stamps`): its text, its type, and its place (the quote, where it is, its anchors). A
// change older than the one a part has already had is not applied to that part: two devices editing one note while
// apart no longer leave whichever reconnects last as the winner, part for part.
static bool stamp_ok(const string &s) {
  if (s.size() < 23 || s.size() > 38 || s[16] != '-' || s[21] != '-') return false;
  for (size_t i = 0; i < 21; i++) if (i != 16 && !std::isdigit(static_cast<unsigned char>(s[i]))) return false;
  return std::all_of(s.begin() + 22, s.end(), [](unsigned char c) { return std::islower(c) || std::isdigit(c); });
}

// ---- a file's SHA-256 ------------------------------------------------------------------------
// What the document engine knows a file by (a note's `mg.doc`). Working it out reads the whole file, so it is done here,
// where the file is, rather than by sending the file to a device; and the answer is kept while the file's size and time
// stay the same (for the 64 files asked about last).
struct FilePrint { unsigned long long size; long long mtime; string hex; };
static std::mutex prints_lock;
static std::map<string, FilePrint> prints;
static string file_sha256(const string &abs, unsigned long long size, long long mtime) {
  {
    std::lock_guard<std::mutex> g(prints_lock);
    auto it = prints.find(abs);
    if (it != prints.end() && it->second.size == size && it->second.mtime == mtime) return it->second.hex;
  }
  FILE *f = std::fopen(abs.c_str(), "rb");
  if (!f) return "";
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  std::vector<unsigned char> buf(32u << 10);
  size_t n;
  while ((n = std::fread(buf.data(), 1, buf.size(), f)) > 0) mbedtls_sha256_update(&ctx, buf.data(), n);
  const bool bad = std::ferror(f) != 0;
  std::fclose(f);
  unsigned char out[32];
  mbedtls_sha256_finish(&ctx, out);
  mbedtls_sha256_free(&ctx);
  if (bad) return "";
  const string hex = secure::hex(out, sizeof out);
  std::lock_guard<std::mutex> g(prints_lock);
  if (prints.size() >= 64 && !prints.count(abs)) prints.erase(prints.begin());
  prints[abs] = {size, mtime, hex};
  return hex;
}

// A file that is there but cannot be read as what it should be. Writing would
// replace everything in it with what little this request knows, so writes are
// refused until it is repaired by hand.
static bool damaged(const string &path, bool want_array) {
  string text;
  if (!read_file(path, text) || trim(text).empty()) return false;
  Json parsed(cJSON_Parse(text.c_str()));
  return want_array ? !cJSON_IsArray(parsed.p) : !cJSON_IsObject(parsed.p);
}
static http::Response damaged_error(const char *what) { return http::error(500, string(what) + " is damaged and was left as it is; repair or remove it"); }
// Whether a path is the page's own folder or inside it: nothing there may be changed through the API.
static bool in_page_folder(const string &abs) { return abs == WWW || starts_with(abs, WWW + "/"); }

// ---- search --------------------------------------------------------------------------------
// Lines that contain the words asked for, in the documents that can be read
// as text. Upper and lower case count as the same (for plain letters).
// The part of a line around what was found, not the whole line: a line can be very long.
// The line is from `a` to `b`; the words are at `at`, `len` long.
static string around(const string &text, size_t a, size_t b, size_t at, size_t len) {
  size_t from = at > a + 60 ? at - 60 : a, to = std::min(b, at + len + 100);
  while (from < to && (static_cast<unsigned char>(text[from]) & 0xC0) == 0x80) from++;   // not in the middle of a character
  while (to > from && to < b && (static_cast<unsigned char>(text[to]) & 0xC0) == 0x80) to--;
  return squeeze(text.substr(from, to - from));
}
// A file of saved links is searched as it is shown (see links.hpp): by its
// items, their names and addresses, not by its lines. A hit has `item`, the
// item's place in the file, where a line's has `line`: the page of cards is
// asked to open at that item (/cards/<file>?item=).
static void search_links(const string &abs, const string &name, const string &rel, const string &needle, cJSON *out, int &left) {
  struct stat st;
  if (::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode) || static_cast<unsigned long long>(st.st_size) > most_in_memory()) return;
  string text;
  if (!read_file(abs, text)) return;
  // Most files do not have the words at all, and are not read through for their items: the words are looked for
  // in the text as it stands first. That is sound only for words a file cannot have written another way (JSON
  // and HTML may write a quote, an "&" or a letter outside ASCII as an escape; JSON's "\/" is allowed for here).
  bool plain = true;
  for (unsigned char c : needle) plain = plain && c != 0 && (std::isalnum(c) || c == ' ' || std::strchr("/.-_:=?%~,", c) != nullptr);
  if (plain) {
    string hay;
    hay.reserve(text.size());
    for (size_t i = 0; i < text.size(); i++) {
      if (text[i] == '\\' && i + 1 < text.size() && text[i + 1] == '/') continue;
      hay += static_cast<char>(std::tolower(static_cast<unsigned char>(text[i])));
    }
    if (hay.find(needle) == string::npos) return;
  }
  bool more = false;
  const std::vector<links::Item> list = links::find(name, text, most_links(), more);
  int in_file = 0;
  for (size_t k = 0; k < list.size() && in_file < 3 && left > 0; k++) {
    const links::Item &it = list[k];
    // Its name first, then each of its addresses.
    std::vector<const string *> where = {&it.title};
    for (const links::Part &p : it.all) where.push_back(&p.url);
    where.push_back(&it.thumb);
    where.push_back(&it.preview);
    where.push_back(&it.page);
    for (const links::Link &l : it.media) where.push_back(&l.url);
    for (const string *s : where) {
      const size_t at = lower(*s).find(needle);
      if (at == string::npos) continue;
      cJSON *hit = cJSON_CreateObject();
      cJSON_AddStringToObject(hit, "path", rel.c_str());
      cJSON_AddNumberToObject(hit, "item", static_cast<double>(k));
      cJSON_AddStringToObject(hit, "text", ((s == &it.title || it.title.empty() ? "" : it.title + " \xC2\xB7 ") + around(*s, 0, s->size(), at, needle.size())).c_str());
      cJSON_AddItemToArray(out, hit);
      in_file++;
      left--;
      break;
    }
  }
}
// Each file is searched in its first 2 MB, and on the board only as far as most_held (its memory holds no more).
static void search_tree(const string &dir, const string &rel, const Strings &ignore, const string &needle, cJSON *out, int &left) {
  if (depth_of(rel) > profile.max_depth) return;
  each_entry(dir, [&](const string &name, bool is_dir, uint64_t size, int64_t) {
    if (left <= 0) return;
    string r = rel.empty() ? name : rel + "/" + name, abs = dir + "/" + name;
    if (name[0] == '.' || matches(r, ignore) || link_out(abs)) return;
    if (is_dir) {
      if (name == "node_modules" || name == "notes" || abs == WWW) return;
      search_tree(abs, r, ignore, needle, out, left);
      return;
    }
    if (is_link_file(name) ? has_addresses(abs) : is_html(name) && is_bookmarks(abs)) { search_links(abs, name, r, needle, out, left); return; }
    if (!readable(name)) return;
    string text;
    if (!read_start(abs, text, static_cast<size_t>(std::min<uint64_t>(size, std::min<size_t>(2u << 20, most_in_memory()))))) return;
    const string low = lower(text);
    size_t at = 0;
    int line = 1, in_file = 0;
    size_t counted = 0;
    while (in_file < 3 && left > 0 && (at = low.find(needle, at)) != string::npos) {
      for (; counted < at; counted++) if (text[counted] == '\n') line++;
      size_t a = text.rfind('\n', at), b = text.find('\n', at);
      a = a == string::npos ? 0 : a + 1;
      if (b == string::npos) b = text.size();
      cJSON *hit = cJSON_CreateObject();
      cJSON_AddStringToObject(hit, "path", r.c_str());
      cJSON_AddNumberToObject(hit, "line", line);
      cJSON_AddStringToObject(hit, "text", around(text, a, b, at, needle.size()).c_str());
      cJSON_AddItemToArray(out, hit);
      in_file++;
      left--;
      at = b;
    }
  });
}

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

// What a file saved under a shorter name (fit_path) was called when it came: its path as saved -> as asked, kept in
// .names.json at the top of its workspace (a hidden name: neither listed nor served). The list shows a file by the name
// it was given, and "update…" on a folder matches its files by it. A plain map of names; cJSON objects, returned owned.
static cJSON *read_names(const string &base) {
  string text;
  cJSON *names = read_file(base + "/.names.json", text) ? cJSON_Parse(text.c_str()) : nullptr;
  if (cJSON_IsObject(names)) return names;
  cJSON_Delete(names);
  return cJSON_CreateObject();
}
static void remember_name(const string &base, const string &saved, const string &asked) {
  Json names(read_names(base));
  cJSON_DeleteItemFromObjectCaseSensitive(names.p, saved.c_str());
  cJSON_AddStringToObject(names.p, saved.c_str(), asked.c_str());
  write_file(base + "/.names.json", dump(names.p, true) + "\n");
}
// Shorten a path that is too long for this system to save under `base`, rather than refuse it: the longest part first,
// to its beginning, "~", six hex digits made from its whole name, and its extension (".epub" stays ".epub"), as many
// times as it takes. The same name always shortens the same way, so the files of a folder whose name is too long stay
// together in one folder, and a second upload of a file finds the first. False if even that does not fit.
static bool fit_path(const string &base, Strings &parts) {
  const auto too_long = [&]() { return sys::path_too_long(base + "/" + join(parts) + ".00000000.tmp"); };   // with the temporary name's ending
  const Strings was = parts;
  std::vector<size_t> keep(parts.size());
  for (size_t i = 0; i < parts.size(); i++) keep[i] = parts[i].size();
  for (int round = 0; round < 200 && too_long(); round++) {
    size_t at = 0;
    for (size_t i = 1; i < parts.size(); i++) if (parts[i].size() > parts[at].size()) at = i;
    const string &whole = was[at];
    const size_t dot = at + 1 == parts.size() ? whole.rfind('.') : string::npos;
    const string ext = dot != string::npos && dot > 0 && whole.size() - dot <= 10 ? whole.substr(dot) : "";
    const size_t stem = whole.size() - ext.size();
    if (keep[at] > stem) keep[at] = stem;
    if (keep[at] <= 8) return false;   // as short as it goes
    keep[at] = std::max<size_t>(8, keep[at] - std::max<size_t>(4, keep[at] / 8));
    size_t cut = keep[at];
    while (cut > 0 && (static_cast<unsigned char>(whole[cut]) & 0xC0) == 0x80) cut--;   // not in the middle of a letter
    string start = whole.substr(0, cut);
    while (!start.empty() && (start.back() == ' ' || start.back() == '.')) start.pop_back();
    unsigned long long h = 1469598103934665603ULL;
    for (char ch : whole) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;
    char tag[8];
    std::snprintf(tag, sizeof tag, "~%06llx", h & 0xFFFFFFULL);
    parts[at] = start + tag + ext;
  }
  return !too_long();
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
  // Not this machine's own browser, though: a connection from the machine to
  // itself never crosses the network, so there is nothing for encryption to
  // protect, and browsers count http://localhost as secure. So the computer
  // the hub runs on never needs the hub's certificate authority installed.
  if (req.plain_on_tls && !req.local) {
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
    // The reader's own modules: hub/js/<name>.js, by plain names only.
    if (starts_with(p, "/js/") && p.size() > 7 && p.compare(p.size() - 3, 3, ".js") == 0 &&
        std::all_of(p.begin() + 4, p.end() - 3, [](unsigned char c) { return std::islower(c) || std::isdigit(c) || c == '-'; })) {
      http::Response r = asset_response(WWW + p, "text/javascript");
      // The reader's own worker for the document engine: the engine's worker, which also reads a book on this server a
      // piece at a time. It runs under the policy its file is sent with, the same as the engine's own worker's.
      if (p == "/js/engine-worker.js") r.extra += "Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'\r\n";
      return r;
    }
    for (const auto &a : ASSETS) {
      if (p != a.first) continue;
      // Scripts sit beside the page (copied there for the board), or in node_modules.
      string name = a.first + 1;
      http::Response r = asset_response(is_file(WWW + "/" + name) ? WWW + "/" + name : WWW + "/" + a.second, "text/javascript");
      // A worker runs under the policy its own file is sent with: the one for data would not let it run at all. It may run itself, and nothing more.
      if (p == "/vendor/pdf.worker.mjs") r.extra += "Content-Security-Policy: default-src 'none'; script-src 'self'\r\n";
      return r;
    }
    // What PDF.js needs for some PDFs, fetched by the page only for such a PDF: the character maps (a PDF in Chinese,
    // Japanese or Korean, or one that names its characters by an old encoding) and the fourteen standard typefaces a
    // PDF may use without including them. From pdfjs-dist, or beside the page on the board. Plain names only, with the
    // types those folders hold, and nothing else of the package.
    if (starts_with(p, "/vendor/pdfjs/cmaps/") || starts_with(p, "/vendor/pdfjs/standard_fonts/")) {
      const bool cmap = starts_with(p, "/vendor/pdfjs/cmaps/");
      const string name = p.substr(cmap ? 20 : 29);
      const size_t dot = name.rfind('.');
      const string ext = dot == string::npos ? "" : lower(name.substr(dot));
      const char *type = cmap ? (ext == ".bcmap" ? "application/octet-stream" : nullptr)
                              : ext == ".pfb" ? "application/octet-stream" : ext == ".ttf" ? "font/ttf" : nullptr;
      if (!type || dot == 0 || name.size() > 80 || !std::all_of(name.begin(), name.begin() + static_cast<std::ptrdiff_t>(dot), [](unsigned char c) { return std::isalnum(c) || c == '-' || c == '_'; }))
        return http::error(404, "no such file");
      const string folder = cmap ? "cmaps/" : "standard_fonts/";
      return asset_response(is_file(WWW + p) ? WWW + p : WWW + "/node_modules/pdfjs-dist/" + folder + name, type);
    }
    // Two typefaces made for reading, offered beside the reader's serif and sans: Atkinson Hyperlegible and OpenDyslexic
    // (both under the SIL Open Font License, from @fontsource in node_modules, or beside the page on the board). A
    // browser fetches one only when it is chosen. Their files by the names @fontsource gives them, and nothing else.
    if (starts_with(p, "/vendor/fonts/")) {
      const string name = p.substr(14);
      const bool atkinson = starts_with(name, "atkinson-hyperlegible-latin-"), dyslexic = starts_with(name, "opendyslexic-latin-");
      const string rest = name.substr(atkinson ? 28 : dyslexic ? 19 : 0);
      static const std::set<string> CUTS = {"400-normal.woff2", "400-italic.woff2", "700-normal.woff2", "700-italic.woff2"};
      if (!(atkinson || dyslexic) || !(CUTS.count(rest) || (atkinson && starts_with(rest, "ext-") && CUTS.count(rest.substr(4))))) return http::error(404, "no such file");
      const string family = atkinson ? "atkinson-hyperlegible" : "opendyslexic";
      return asset_response(is_file(WWW + p) ? WWW + p : WWW + "/node_modules/@fontsource/" + family + "/files/" + name, "font/woff2");
    }
    // The document engine (marginalia-engine): what reads the text of a PDF or a book and where each character is, for
    // selecting and highlighting on its pages. The seventeen files the reader loads, by name, from the package's dist
    // folder (or beside the page, on the board): the same list sw.js keeps and `make card` copies. The rest of the
    // package (its OCR, its Node and direct entry points) is not served, nor is whatever a newer version adds.
    if (starts_with(p, "/vendor/marginalia/")) {
      static const std::set<string> ENGINE_FILES = {
        "index.js", "client.js", "worker.js", "selection.js", "selection-engine.js", "frame.js", "geometry.js", "overlay.js", "surfaces.js",
        "caret.js", "dom.js", "themes.js", "recolor.js", "recolor-worker.js", "ui.css", "wasm/marginalia_wasm.js", "wasm/marginalia_wasm_bg.wasm"};
      const string name = p.substr(19);
      if (!ENGINE_FILES.count(name)) return http::error(404, "no such file");
      const char *type = ends_with(name, ".js") ? "text/javascript" : ends_with(name, ".css") ? "text/css" : "application/wasm";
      http::Response r = asset_response(is_file(WWW + p) ? WWW + p : WWW + "/node_modules/marginalia-engine/dist/" + name, type);
      // Its workers, like PDF.js's, run under the policy their own file is sent with. The engine's fetches its
      // WebAssembly from here and compiles it, and may do nothing else; the one that recolours pages only runs.
      if (name == "worker.js") r.extra += "Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'\r\n";
      else if (name == "recolor-worker.js") r.extra += "Content-Security-Policy: default-src 'none'; script-src 'self'\r\n";
      return r;
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
      r.extra = "Access-Control-Allow-Methods: GET, POST, PUT, DELETE\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, Range, X-Hub-Workspace\r\nAccess-Control-Max-Age: 600\r\n";
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
    // From a page of another site: only one on a home network, as another hub's reader is (see home_origin).
    if (cross && !home_origin(req.header("origin"))) return http::error(403, "pairing from that site is not allowed");
    std::lock_guard<std::mutex> g(auth_lock);
    bool on_offer = !pair_code.empty() && http::Clock::now() < pair_until;
    // Wrong codes from other sites are counted apart: five, and the code is closed to them, but still open to this
    // hub's own page. So a page elsewhere cannot use up the tries and cancel the code.
    if (cross && on_offer && pair_fails_away >= 5) return http::error(403, "too many wrong codes from other sites: make a new code");
    if (!on_offer || !secure::same(code, pair_code)) {
      // Five wrong tries and the code is withdrawn, so it cannot be guessed at.
      if (on_offer && cross) ++pair_fails_away;
      else if (on_offer && ++pair_fails >= 5) { pair_code.clear(); if (devices.empty()) offer_code(true); }
      return http::error(403, "wrong or expired pairing code");
    }
    pair_code.clear();
    string token = secure::random_token(32);
    Device d{secure::random_hex(8), name.empty() ? "device" : name, secure::sha256_hex(token), now_iso(), now_iso().substr(0, 10)};
    if (token.empty() || d.id.empty()) return http::error(500, "could not pair");
    devices.push_back(d);
    if (!save_devices()) { devices.pop_back(); return http::error(500, "could not save"); }
    std::printf("paired: %s (%s)\n", d.name.c_str(), d.id.c_str());
    notice("Paired: " + d.name);
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
  saw(device, req.conn->peer);

  // A page names the workspace it shows. A request from a page still showing one that is no longer open is refused
  // (412, with the one that is), so it can neither read from the open one nor write into it: a note, a front page, a
  // folder removed. Choosing a workspace and the live line are the exceptions. A request that names none (an older
  // page, a script) is served as before.
  if (const string ws = req.header("x-hub-workspace"); !ws.empty() && ws != workspace_id(ROOT) && p != "/api/workspace" && p != "/api/workspaces" && p != "/api/events") {
    http::Response r = http::error(412, "another workspace has been opened on this hub");
    r.extra += "X-Hub-Workspace: " + workspace_id(ROOT) + "\r\n";
    return r;
  }

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
    notice("Removed: " + it->name);
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
    if (!clean_parts(p.substr(5), parts, true)) return http::error(404, "not found");   // hidden files are not served, as they are not listed
    string abs = ROOT + "/" + join(parts);
    if (!inside(abs)) return http::error(404, "not found");
    // A file inside a book: sent whole, from the zip.
    string book, inner;
    if (in_book(parts, book, inner)) {
      http::Response r;
      if (int bad = book_item(book, inner, r.body)) return book_error(bad);
      r.type = mime_of(parts.back());
      r.extra = CSP_RAW;
      return r;
    }
    bool dir;
    uint64_t size64;
    if (!fs::info(abs, dir, size64) || dir) return http::error(404, "no such file");   // fs::info: sizes past 2 GB on the board
    const unsigned long long size = size64;
    http::Response r;
    r.type = mime_of(parts.back());
    r.extra = "Accept-Ranges: bytes\r\n";
    // A browser's PDF viewer does not start inside a sandbox; a PDF cannot touch the reader anyway.
    // A page listed by its exact path under "scripts" in hub.json may run its own scripts, apart from the reader.
    bool app = false;
    if (is_html(parts.back())) {
      Json cfg(read_config());
      const Strings apps = list_of(cfg.p, "scripts");
      app = std::find(apps.begin(), apps.end(), join(parts)) != apps.end();
    }
    if (r.type != "application/pdf") r.extra += app ? CSP_APP : CSP_RAW;
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
    if (static_cast<int>(clients.size()) >= profile.max_streams || !memory_for_one_more()) return http::error(503, "too many open pages");
    http::Response r;
    req.conn->within(5000);
    if (!req.conn->write_all(string("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n") + COMMON_HEADERS + "\r\n\n")) { r.status = 500; r.close = true; return r; }
    req.conn->who = device;
    clients.push_back(req.conn);
    r.hold = true;
    return r;
  }

  if (p == "/api/search" && m == "GET") {
    auto it = req.query.find("q");
    string q = it == req.query.end() ? "" : lower(squeeze(it->second));
    if (q.size() < 2 || q.size() > 100) return http::error(400, "search for 2 to 100 characters");
    Json cfg(read_config()), hits(cJSON_CreateArray());
    int left = 60;
    search_tree(ROOT, "", list_of(cfg.p, "ignore"), q, hits.p, left);
    return json_response(hits.p);
  }

  if (p == "/api/docs") {
    // Making the list reads the start of every document for its title, so it
    // is kept until something listed changes. On the board only this server
    // changes the card and counts its own changes (generation); elsewhere the
    // folder is also looked over (one stat per file, nothing read, at most once
    // per watch interval: tree_stamp).
    http::Response r;
    Sink out;
    if (!profile.cache_listing) { out.mem = &r.body; make_list(out); return r; }
    std::lock_guard<std::mutex> g(listing_lock);
    const unsigned long long gen = generation.load(), stamp = profile.sole_writer ? 0 : tree_stamp();
    if (!listing_ok || gen != listing_gen || stamp != listing_stamp || ROOT != listing_root) {
      std::shared_ptr<ListFile> file = profile.listing_on_disk ? make_list_file() : nullptr;
      listing_mem.clear();
      if (!file) { out.mem = &listing_mem; make_list(out); listing_mem.shrink_to_fit(); } // in memory, also when the card is too full for the file
      listing_file = file;
      listing_gen = gen;
      listing_stamp = stamp;
      listing_root = ROOT;
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
    cJSON_AddNumberToObject(d.p, "maxUpload", static_cast<double>(profile.max_upload));
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
    cJSON_AddNumberToObject(d.p, "psramFree", static_cast<double>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
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

  // A damaged settings file is not papered over with defaults: those would drop the folder locks.
  if (p == "/api/config" && m == "GET") { if (damaged(ROOT + "/hub.json", false)) return damaged_error("hub.json"); Json cfg(read_config()); return json_response(cfg.p); }
  if (p == "/api/config" && m == "PUT") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    if (!cJSON_IsObject(body.p)) return http::error(400, "json object required");
    std::lock_guard<std::mutex> g(store_lock);
    // Read once: one that cannot be read is refused rather than replaced by this change alone.
    bool intact;
    Json file(read_settings_file(intact));
    if (!intact) return damaged_error("hub.json");
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
    // How the reader looks (its theme, its typeface, its reading settings), as the device that
    // last changed it left it. A device with no choice of its own yet starts from this, so the
    // look outlasts a browser that forgets, and is the same at another address. Only short,
    // plain values are kept: up to 12, names and text of letters, digits and hyphens.
    const cJSON *look = cJSON_GetObjectItemCaseSensitive(body.p, "look");
    if (cJSON_IsObject(look)) {
      auto plain = [](const char *chars, size_t most, bool or_empty) {
        const string t = chars ? chars : "";
        return (or_empty || !t.empty()) && t.size() <= most && std::all_of(t.begin(), t.end(), [](unsigned char c) { return std::isalnum(c) || c == '-'; });
      };
      cJSON *clean = cJSON_CreateObject();
      int kept = 0;
      const cJSON *v;
      cJSON_ArrayForEach(v, look) {
        if (kept >= 12 || !plain(v->string, 20, false)) continue;
        if (cJSON_IsString(v) && plain(v->valuestring, 40, true)) cJSON_AddStringToObject(clean, v->string, v->valuestring);
        else if (cJSON_IsBool(v)) cJSON_AddBoolToObject(clean, v->string, cJSON_IsTrue(v));
        else if (cJSON_IsNumber(v)) cJSON_AddNumberToObject(clean, v->string, v->valuedouble);
        else continue;
        kept++;
      }
      cJSON_DeleteItemFromObjectCaseSensitive(file.p, "look");
      cJSON_AddItemToObject(file.p, "look", clean);
    }
    if (!write_settings(file.p)) return http::error(500, "could not save");
    touch_tree();
    Json cfg(read_config());
    return json_response(cfg.p);
  }

  // Take a folder, and everything in it, out of the workspace. The notes
  // folder is the reader's own and stays. Any lock on the folder goes with it.
  if (p == "/api/files" && m == "GET") {
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || parts.empty()) return http::error(400, "bad path");
    string abs = ROOT + "/" + join(parts);
    if (!is_dir(abs) || sys::is_link(abs) || in_page_folder(abs) || !inside(abs)) return http::error(404, "no such folder");
    Json names(read_names(ROOT));
    http::Response r;
    Sink out;
    bool first = true;
    // On the board a folder of thousands of files would not fit in memory as one answer: it is written to the card
    // and sent from there, as the document list is.
    std::shared_ptr<ListFile> file;
    FILE *f = nullptr;
    if (profile.listing_on_disk) {
      file = std::make_shared<ListFile>();
      { std::lock_guard<std::mutex> g(listing_lock); file->path = CACHE + "/files-" + std::to_string(++listing_made) + ".json"; }
      make_dirs(CACHE);
      if (!(f = std::fopen(file->path.c_str(), "wb"))) return http::error(500, "could not list the folder");
      out.file = f;
    } else {
      out.mem = &r.body;
    }
    out.put("[");
    walk_files(abs, join(parts), names.p, out, first);
    out.put("]");
    out.flush();
    if (!file) return r;
    if (std::fclose(f) != 0 || !out.ok || !fs::file_size(file->path, file->size)) return http::error(507, "storage is full");
    used_more(static_cast<long long>(file->size));
    r = file_response(file->path, "application/json");
    r.keep = file;
    return r;
  }

  if (p == "/api/folder" && m == "DELETE") {
    Strings parts;
    auto it = req.query.find("path");
    struct stat st;
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || lower(parts[0]) == "notes" ||
        sys::is_link(ROOT + "/" + join(parts)) || !inside(ROOT + "/" + join(parts)) || ::stat((ROOT + "/" + join(parts)).c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) return http::error(400, "no such folder");
    string key = join(parts);
    // Not the page's own folder, nor a folder that holds it.
    if (in_page_folder(ROOT + "/" + key) || starts_with(WWW + "/", ROOT + "/" + key + "/")) return http::error(400, "no such folder");
    std::lock_guard<std::mutex> g(store_lock);
    std::lock_guard<std::mutex> rl(removed_lock);
    let_go_old(ROOT);
    // Moved into .removed/, so it can be put back. Where it cannot be moved (another disk), it is deleted, as before.
    const string undo = new_id(), into = ROOT + "/" + REMOVED + "/" + undo;
    make_dirs(into);
    const bool kept = sys::move(ROOT + "/" + key, into + "/" + parts.back());
    if (!kept) { remove_tree(into); if (!remove_tree(ROOT + "/" + key)) return http::error(500, "could not remove"); }
    else changed(ROOT + "/" + key, 0);   // gone from the list: on the board, open pages are told (moved, so nothing is freed yet)
    touch_tree();
    Json taken(cJSON_CreateObject());   // the locks it had, put back with it
    Json file(read_settings_file());
    cJSON *locks = cJSON_GetObjectItemCaseSensitive(file.p, "locks");
    if (cJSON_IsObject(locks) && !damaged(ROOT + "/hub.json", false)) {
      Strings gone;
      const cJSON *l;
      cJSON_ArrayForEach(l, locks) { string k = l->string ? l->string : ""; if (k == key || k.compare(0, key.size() + 1, key + "/") == 0) gone.push_back(k); }
      for (const string &k : gone) cJSON_AddItemToObject(taken.p, k.c_str(), cJSON_DetachItemFromObjectCaseSensitive(locks, k.c_str()));
      if (!gone.empty() && !write_settings(file.p)) return http::error(500, "could not save");
    }
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "removed", key.c_str());
    if (kept) {
      Json info(cJSON_CreateObject());
      cJSON_AddStringToObject(info.p, "from", key.c_str());
      cJSON_AddStringToObject(info.p, "at", now_iso().c_str());
      cJSON_AddItemToObject(info.p, "locks", cJSON_Duplicate(taken.p, true));
      write_file(into + ".json", dump(info.p, true) + "\n");
      cJSON_AddStringToObject(out.p, "undo", undo.c_str());
    }
    return json_response(out.p);
  }

  // Removed folders: what can still be put back, oldest first.
  if (p == "/api/removed" && m == "GET") {
    std::lock_guard<std::mutex> rl(removed_lock);
    let_go_old(ROOT);
    Json list(cJSON_CreateArray());
    for (const Removed &r : removed_list(ROOT)) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "undo", r.undo.c_str());
      cJSON_AddStringToObject(o, "from", r.from.c_str());
      cJSON_AddStringToObject(o, "at", r.at.c_str());
      cJSON_AddNumberToObject(o, "size", static_cast<double>(r.size));
      cJSON_AddBoolToObject(o, "locked", r.locked);   // the reader does not name a locked folder
      cJSON_AddItemToArray(list.p, o);
    }
    return json_response(list.p);
  }
  // Let one go now, for good.
  if (p == "/api/removed" && m == "DELETE") {
    auto it = req.query.find("undo");
    if (it == req.query.end() || !undo_ok(it->second)) return http::error(404, "nothing removed by that name");
    std::lock_guard<std::mutex> rl(removed_lock);
    if (!is_file(ROOT + "/" + REMOVED + "/" + it->second + ".json")) return http::error(404, "nothing removed by that name");
    let_go(ROOT, it->second);
    touch_tree();
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "undo", it->second.c_str());
    cJSON_AddBoolToObject(out.p, "letGo", true);
    return json_response(out.p);
  }
  // Put a removed folder back where it was, with its locks.
  if (p == "/api/folder/restore" && m == "POST") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    const string undo = str_of(body.p, "undo");
    if (!undo_ok(undo)) return http::error(404, "nothing removed by that name");
    std::lock_guard<std::mutex> g(store_lock);
    std::lock_guard<std::mutex> rl(removed_lock);
    const string held = ROOT + "/" + REMOVED + "/" + undo;
    string about;
    if (!read_file(held + ".json", about)) return http::error(404, "nothing removed by that name");
    Json info(cJSON_Parse(about.c_str()));
    Strings parts;
    if (!clean_parts(str_of(info.p, "from"), parts, true) || lower(parts[0]) == "notes") return http::error(404, "nothing removed by that name");
    const string key = join(parts), back = ROOT + "/" + key;
    if (is_dir(back) || is_file(back)) return http::error(409, "something by that name is there now");
    make_dirs(dirname_of(back));
    if (!sys::move(held + "/" + parts.back(), back)) return http::error(500, "could not put it back");
    changed(back, 0);   // in the list again: on the board, open pages are told
    let_go(ROOT, undo);
    const cJSON *locks = cJSON_GetObjectItemCaseSensitive(info.p, "locks");
    if (cJSON_IsObject(locks) && cJSON_GetArraySize(locks) > 0 && !damaged(ROOT + "/hub.json", false)) {
      Json file(read_settings_file());
      cJSON *now = cJSON_GetObjectItemCaseSensitive(file.p, "locks");
      if (!cJSON_IsObject(now)) { cJSON_DeleteItemFromObjectCaseSensitive(file.p, "locks"); now = cJSON_AddObjectToObject(file.p, "locks"); }
      const cJSON *l;
      cJSON_ArrayForEach(l, locks) if (l->string && !cJSON_GetObjectItemCaseSensitive(now, l->string)) cJSON_AddItemToObject(now, l->string, cJSON_Duplicate(l, true));
      if (!write_settings(file.p)) return http::error(500, "could not save");
    }
    touch_tree();
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "restored", key.c_str());
    return json_response(out.p);
  }

  // The web addresses in a text or JSON file: as a list, and as a page of media cards.
  if ((p == "/api/links" && m == "GET") || (starts_with(p, "/cards/") && m == "GET")) {
    const bool page = p != "/api/links";
    Strings parts;
    auto it = req.query.find("path");
    if (!clean_parts(page ? p.substr(7) : it == req.query.end() ? "" : it->second, parts, true) || !(is_link_file(parts.back()) || is_html(parts.back()))) return http::error(404, "no such file");
    const string abs = ROOT + "/" + join(parts);
    struct stat st;
    if (!inside(abs) || ::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return http::error(404, "no such file");
    if (static_cast<unsigned long long>(st.st_size) > most_in_memory()) return http::error(413, "too large to read through");
    string text;
    if (!read_file(abs, text)) return http::error(404, "no such file");
    bool more = false;
    const std::vector<links::Item> list = links::find(parts.back(), text, most_links(), more);
    if (page) {
      // The reader says which colours its pane has, so the gallery matches: six hex digits each, or the plain theme's.
      links::Look look;
      auto colour = [&](const char *name, string &into) {
        const auto q = req.query.find(name);
        if (q != req.query.end() && q->second.size() == 6 && std::all_of(q->second.begin(), q->second.end(), [](unsigned char ch) { return std::isxdigit(ch); })) into = q->second;
      };
      colour("paper", look.paper);
      colour("shade", look.shade);
      colour("ink", look.ink);
      colour("muted", look.muted);
      colour("rule", look.rule);
      colour("accent", look.accent);
      const auto wide = req.query.find("size");
      if (wide != req.query.end() && !wide->second.empty() && wide->second.size() <= 3 && std::all_of(wide->second.begin(), wide->second.end(), [](unsigned char ch) { return std::isdigit(ch); }))
        look.card = std::min(420, std::max(70, std::stoi(wide->second)));
      const auto rev = req.query.find("rev");
      look.reversed = rev != req.query.end() && rev->second == "1";
      // From the reader's find: the item to open the page at, counted as /api/search counts it.
      const auto want = req.query.find("item");
      if (want != req.query.end() && !want->second.empty() && want->second.size() <= 9 && std::all_of(want->second.begin(), want->second.end(), [](unsigned char ch) { return std::isdigit(ch); }))
        look.item = static_cast<size_t>(std::stoul(want->second));
      const string nonce = secure::random_hex(16);
      http::Response r;
      r.type = "text/html";
      r.body = links::cards(parts.back(), list, more, nonce, look);
      r.extra = csp_cards(nonce);
      return r;
    }
    Json out(cJSON_CreateObject());
    cJSON *all = cJSON_AddArrayToObject(out.p, "items");
    for (const links::Item &item : list) {
      cJSON *one = cJSON_CreateObject();
      cJSON_AddStringToObject(one, "title", item.title.c_str());
      cJSON_AddStringToObject(one, "thumb", item.thumb.c_str());
      cJSON_AddStringToObject(one, "preview", item.preview.c_str());
      cJSON_AddStringToObject(one, "page", item.page.c_str());
      cJSON *media = cJSON_AddArrayToObject(one, "media");
      for (const links::Link &l : item.media) {
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "url", l.url.c_str());
        cJSON_AddStringToObject(entry, "kind", l.kind);
        cJSON_AddItemToArray(media, entry);
      }
      cJSON_AddItemToArray(all, one);
    }
    cJSON_AddBoolToObject(out.p, "more", more);
    return json_response(out.p);
  }

  // The blocks of a document, each known by a hash of its words: what a
  // highlight is anchored to (see anchor.hpp).
  if (p == "/api/blocks" && m == "GET") {
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || !readable(parts.back()) || !inside(ROOT + "/" + join(parts))) return http::error(404, "no such doc");
    const string abs = ROOT + "/" + join(parts);
    string text, book, inner;
    if (in_book(parts, book, inner)) {
      if (int bad = book_item(book, inner, text)) return book_error(bad);
    } else {
      struct stat st;
      if (::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return http::error(404, "no such doc");
      if (static_cast<unsigned long long>(st.st_size) > most_in_memory()) return http::error(413, "too large to map");   // the whole file is held in memory
      if (!read_file(abs, text)) return http::error(404, "no such doc");
    }
    const string &name = parts.back();
    // Anything that is neither markdown nor a page is shown as one block of code.
    const std::vector<string> texts = ends_with(name, ".md") ? anchor::markdown_blocks(text) : is_html(name) ? anchor::html_blocks(text) : std::vector<string>{text};
    Json out(cJSON_CreateObject());
    cJSON *list = cJSON_AddArrayToObject(out.p, "blocks");
    for (const anchor::Block &b : anchor::blocks(texts)) {
      cJSON *one = cJSON_CreateObject();
      cJSON_AddStringToObject(one, "hash", b.hash.c_str());
      cJSON_AddNumberToObject(one, "nth", b.nth);
      cJSON_AddNumberToObject(one, "len", static_cast<double>(b.len));
      cJSON_AddItemToArray(list, one);
    }
    return json_response(out.p);
  }

  // A file's SHA-256 (see file_sha256): { path, size, sha256 }.
  if (p == "/api/sha256" && m == "GET") {
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || !inside(ROOT + "/" + join(parts))) return http::error(404, "no such file");
    const string abs = ROOT + "/" + join(parts);
    struct stat st;
    if (::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return http::error(404, "no such file");
    const unsigned long long size = static_cast<unsigned long long>(st.st_size);
    const string hex = file_sha256(abs, size, static_cast<long long>(st.st_mtime));
    if (hex.empty()) return http::error(500, "could not read the file");
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "path", join(parts).c_str());
    cJSON_AddNumberToObject(out.p, "size", static_cast<double>(size));
    cJSON_AddStringToObject(out.p, "sha256", hex.c_str());
    return json_response(out.p);
  }

  if (p == "/api/doc") {
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || !readable(parts.back()) || !inside(ROOT + "/" + join(parts))) return http::error(404, "no such doc");
    string book, inner;
    if (in_book(parts, book, inner)) {
      http::Response page;
      page.type = "text/plain";
      if (int bad = book_item(book, inner, page.body)) return book_error(bad);
      return page;
    }
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
      if (!clean_parts(folder, parts, true) || !is_dir(ROOT + "/" + join(parts)) || !inside(ROOT + "/" + join(parts))) return http::error(400, "no such folder");
      dir = ROOT + "/" + join(parts);
      if (in_page_folder(dir)) return http::error(400, "no such folder");
    }
    std::lock_guard<std::mutex> g(store_lock);
    if (!write_file(dir + "/" + FRONT, md)) return http::error(500, "could not save");
    touch_tree();
    Json cfg(read_config());
    return json_response(cfg.p);
  }

  // Nor is a damaged notes file answered as "no notes": a reader would replace its own copy with nothing.
  if (p == "/api/notes" && m == "GET") {
    bool intact;
    Json notes(read_notes(intact));
    return intact ? json_response(notes.p) : damaged_error("notes.json");
  }
  if (p == "/api/notes" && m == "POST") {
    string raw;
    if (int bad = json_body(req, raw)) return body_error(bad);
    Json body(cJSON_Parse(raw.c_str()));
    // A highlight is a note with a quote and no text yet.
    string doc = str_of(body.p, "doc"), text = str_of(body.p, "text"), quote = str_of(body.p, "quote");
    if (doc.empty() || (text.empty() && quote.empty())) return http::error(400, "doc and text or quote required");
    // A reply answers another note: its id, in the same characters a note's own id may have.
    const string reply_to = str_of(body.p, "replyTo");
    const bool reply_ok = reply_to.size() >= 1 && reply_to.size() <= 40 && std::all_of(reply_to.begin(), reply_to.end(), [](unsigned char c) { return std::isalnum(c) || c == '_' || c == '-'; });
    if (!reply_to.empty() && !reply_ok) return http::error(400, "replyTo is not a note's id");
    std::lock_guard<std::mutex> g(store_lock);
    bool intact;
    Json notes(read_notes(intact));   // read once; one that cannot be read is refused, never replaced
    if (!intact) return damaged_error("notes.json");
    // A note written while the board was out of reach arrives later with the id
    // and time it was given on the device. Sending the same one twice is harmless.
    string own_id = str_of(body.p, "id"), own_ts = str_of(body.p, "ts");
    const cJSON *seen;
    cJSON_ArrayForEach(seen, notes.p) if (!own_id.empty() && str_of(seen, "id") == own_id) return json_response(seen);
    if (!room_for(raw.size())) { notice("Storage is full"); return http::error(507, "storage is full"); }
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
    if (cJSON *a = clean_anchor(cJSON_GetObjectItemCaseSensitive(body.p, "anchor"))) cJSON_AddItemToObject(note, "anchor", a);
    if (cJSON *mg = clean_mg(cJSON_GetObjectItemCaseSensitive(body.p, "mg"))) cJSON_AddItemToObject(note, "mg", mg);
    cJSON_AddStringToObject(note, "text", text.c_str());
    if (reply_ok) cJSON_AddStringToObject(note, "replyTo", reply_to.c_str());
    cJSON_AddStringToObject(note, "ts", ts_ok ? own_ts.c_str() : now_iso().c_str());
    cJSON_AddStringToObject(note, "status", text.empty() ? "highlight" : "open");
    if (const string at = str_of(body.p, "at"); stamp_ok(at)) {
      cJSON *stamps = cJSON_AddObjectToObject(note, "stamps");
      for (const char *part : {"text", "type", "place"}) cJSON_AddStringToObject(stamps, part, at.c_str());
    }
    cJSON_AddItemToArray(notes.p, note);
    if (!write_notes(notes.p)) return http::error(500, "could not save");
    return json_response(note);
  }
  if (starts_with(p, "/api/notes/") && (m == "PUT" || m == "DELETE")) {
    string id = p.substr(11);
    // The body is read before the lock is taken, so a slow sender holds nobody else up.
    string text;
    if (m == "PUT") { if (int bad = json_body(req, text)) return body_error(bad); }
    std::lock_guard<std::mutex> g(store_lock);
    bool intact;
    Json notes(read_notes(intact));   // read once; one that cannot be read is refused, never replaced
    if (!intact) return damaged_error("notes.json");
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
    Json body(cJSON_Parse(text.c_str()));
    if (!cJSON_IsObject(body.p)) return http::error(400, "json object required");
    // Each part of the note a stamped change touches is changed only if the change is newer than the last one that part
    // had (see stamp_ok). A change without a stamp (from a page older than stamps) is applied, as it always was.
    const string at = str_of(body.p, "at");
    const bool stamped = stamp_ok(at);
    auto newer = [&](const char *part) {
      if (!stamped) return true;
      cJSON *stamps = cJSON_GetObjectItemCaseSensitive(note, "stamps");
      if (!cJSON_IsObject(stamps)) { cJSON_DeleteItemFromObjectCaseSensitive(note, "stamps"); stamps = cJSON_AddObjectToObject(note, "stamps"); }
      const string had = str_of(stamps, part);
      if (!had.empty() && at <= had) return false;
      set_str(stamps, part, at);
      return true;
    };
    if (has_str(body.p, "text") && newer("text")) set_str(note, "text", str_of(body.p, "text"));
    if (has_str(body.p, "type") && newer("type")) set_str(note, "type", str_of(body.p, "type"));
    cJSON *a = clean_anchor(cJSON_GetObjectItemCaseSensitive(body.p, "anchor"));
    cJSON *mg = clean_mg(cJSON_GetObjectItemCaseSensitive(body.p, "mg"));
    const bool place = a || mg || has_str(body.p, "quote") || has_str(body.p, "heading") || has_str(body.p, "headingText");
    if (place && newer("place")) {
      for (const char *key : {"quote", "heading", "headingText"}) if (has_str(body.p, key)) set_str(note, key, str_of(body.p, key));
      // A new quote comes with its own anchor, or with none: the old one is for the old quote.
      if (a || has_str(body.p, "quote")) cJSON_DeleteItemFromObjectCaseSensitive(note, "anchor");
      if (a) { cJSON_AddItemToObject(note, "anchor", a); a = nullptr; }
      if (mg || has_str(body.p, "quote")) cJSON_DeleteItemFromObjectCaseSensitive(note, "mg");
      if (mg) { cJSON_AddItemToObject(note, "mg", mg); mg = nullptr; }
    }
    cJSON_Delete(a);
    cJSON_Delete(mg);
    if (str_of(note, "status") == "highlight" && !str_of(note, "text").empty()) set_str(note, "status", "open");
    if (!write_notes(notes.p)) return http::error(500, "could not save");
    return json_response(note);
  }

  if (p == "/api/workspaces") return workspaces_response();
  // Switch to another workspace: the home folder, or one made from an upload.
  if (p == "/api/workspace" && m == "POST") {
    string text;
    if (int bad = json_body(req, text)) return body_error(bad);
    Json body(cJSON_Parse(text.c_str()));
    const string want = str_of(body.p, "root");
    for (const Workspace &w : list_workspaces()) {
      if (w.root != want || want.empty()) continue;
      std::lock_guard<std::mutex> g(store_lock);
      open_workspace(w);
      return workspaces_response();
    }
    return http::error(404, "no such workspace");
  }

  // One file of an uploaded folder. Without "workspace" it is added to the
  // open workspace; with it, to a workspace of its own, made on first use.
  // Existing files are never overwritten. The body goes to disk a piece at a
  // time, under a temporary name until it is complete.
  // A name too long for this system (on Windows, 259 characters for the whole path, the served folder included;
  // elsewhere, 255 bytes a part) is shortened rather than refused (see fit_path), and the answer says what it was saved as.
  if (p == "/api/upload" && m == "POST") {
    Strings parts;
    auto it = req.query.find("path"), ws = req.query.find("workspace");
    string base = ROOT;
    if (ws != req.query.end()) {
      if (WORKSPACES.empty()) return http::error(501, "this server keeps no workspaces of its own");
      if (clean_name(ws->second).empty()) return http::error(400, "bad path");
      base = WORKSPACES + "/" + clean_name(ws->second);
    }
    if (it == req.query.end() || !clean_parts(it->second, parts, true)) return http::error(400, "bad path");
    if (req.content_length > profile.max_upload) return http::error(413, "body too large");
    const string asked = join(parts);
    if (!fit_path(base, parts)) return http::error(400, "the name is too long for this system");
    string abs = base + "/" + join(parts);
    if (!inside(abs, base)) return http::error(400, "bad path");   // not through a link that leads out of the workspace
    if (in_page_folder(abs)) return http::error(400, "bad path");   // the page's own files are not changed through the API
    // A refusal after this point reads the body first: answered while the file
    // is still being sent, the browser sees a broken connection and no answer.
    auto refuse = [&](int status, const char *why) { req.discard_body(profile.max_upload); return http::error(status, why); };
    string tmp = abs + "." + secure::random_hex(4) + ".tmp";
    if (sys::path_too_long(tmp)) return refuse(400, "the name is too long for this system");
    Json out(cJSON_CreateObject());
    if (join(parts) != asked) { cJSON_AddStringToObject(out.p, "path", join(parts).c_str()); cJSON_AddBoolToObject(out.p, "shortened", true); }
    // A file that is here already is left as it is, unless the upload says it is a newer
    // copy of it ("replace=1": an update of a folder that was uploaded before). A folder
    // of that name is never replaced by a file. (fs::info: one look, and sizes past 2 GB on the board.)
    bool exists_dir = false;
    uint64_t exists_size = 0;
    const bool exists = fs::info(abs, exists_dir, exists_size), replace = exists && !exists_dir && req.query.count("replace");
    if (exists && !replace) {
      req.discard_body(profile.max_upload);
      cJSON_AddBoolToObject(out.p, "skipped", true);
      return json_response(out.p);
    }
    const unsigned long long old_size = replace ? exists_size : 0;
    if (!room_in(base, req.content_length)) { notice("Storage is full"); return http::error(507, "storage is full"); }
    // On the board the file is written in the small cache folder and then moved
    // into place: FAT searches a folder from its start to add a name, so a
    // temporary name beside the file would cost a big folder a second search.
    // Its folders are made once it has all arrived, so a failed upload leaves none.
    if (profile.sole_writer) tmp = CACHE + "/up-" + secure::random_hex(4) + ".tmp";
    make_dirs(profile.sole_writer ? CACHE : dirname_of(abs));
    if (int bad = req.save_body(tmp, profile.max_upload, profile.piece)) return bad == 507 ? http::error(507, "storage is full") : bad == 500 ? refuse(500, "could not save") : body_error(bad);
    if (profile.sole_writer) make_dirs(dirname_of(abs));
    if (!sys::replace(tmp, abs)) { ::unlink(tmp.c_str()); return http::error(500, "could not save"); }
    changed(abs, static_cast<long long>(req.content_length) - static_cast<long long>(old_size));   // what it adds; less than nothing if it shrank
    if (join(parts) != asked) { std::lock_guard<std::mutex> g(store_lock); remember_name(base, join(parts), asked); }
    touch_tree();
    cJSON_AddBoolToObject(out.p, "saved", true);
    if (replace) cJSON_AddBoolToObject(out.p, "replaced", true);
    cJSON_AddStringToObject(out.p, "root", base.c_str());
    return json_response(out.p);
  }

  return http::error(404, "not found");
}

void hub_status(HubStatus &out) {
  out = HubStatus();
  out.running = serving.load();
#ifdef ESP_PLATFORM
  const char *ip = board_ip();
  std::snprintf(out.host, sizeof out.host, "%s", ip ? ip : "");
#else
  std::snprintf(out.host, sizeof out.host, "%s", bind_host.c_str());
#endif
  out.port = serve_port;
  out.tls = tls_on;
  std::snprintf(out.fingerprint, sizeof out.fingerprint, "%s", ca_fingerprint_text.c_str());
  std::map<string, string> names;
  {
    std::lock_guard<std::mutex> g(auth_lock);
    auto left = std::chrono::duration_cast<std::chrono::seconds>(pair_until - http::Clock::now()).count();
    if (!pair_code.empty() && left > 0) {
      std::snprintf(out.pair_code, sizeof out.pair_code, "%s-%s", pair_code.substr(0, 4).c_str(), pair_code.substr(4).c_str());
      out.pair_seconds = static_cast<int>(left);
    }
    for (const Device &d : devices) names[d.id] = d.name;
    names["local"] = "this computer";
  }
  std::set<string> live;
  {
    std::lock_guard<std::mutex> g(clients_lock);
    for (const auto &c : clients) if (!c->gone()) live.insert(c->who); // a closed page is dropped at the next announcement; not shown as open meanwhile
  }
  // Devices with a page open, then those heard from in the last two minutes; most recent first.
  std::vector<std::pair<http::Clock::time_point, HubPeer>> found;
  {
    std::lock_guard<std::mutex> g(seen_lock);
    const auto recent = http::Clock::now() - std::chrono::minutes(2);
    for (const auto &kv : seen_devices) {
      auto name = names.find(kv.first);
      bool is_live = live.count(kv.first) != 0;
      if (name == names.end() || (!is_live && kv.second.at < recent)) continue;
      HubPeer p;
      std::snprintf(p.name, sizeof p.name, "%s", name->second.c_str());
      std::snprintf(p.ip, sizeof p.ip, "%s", kv.second.ip.c_str());
      p.live = is_live;
      found.push_back({kv.second.at, p});
    }
  }
  std::sort(found.begin(), found.end(), [](const auto &a, const auto &b) { return a.second.live != b.second.live ? a.second.live : a.first > b.first; });
  for (const auto &f : found) if (out.peer_count < static_cast<int>(sizeof out.peers / sizeof out.peers[0])) out.peers[out.peer_count++] = f.second;
  {
    std::lock_guard<std::mutex> g(notice_lock);
    if (http::Clock::now() < notice_until) std::snprintf(out.notice, sizeof out.notice, "%s", notice_text.c_str());
  }
  // Only once serving, and only what is already counted: a screen asking must never set off a walk of the card.
  if (out.running) {
    { std::lock_guard<std::mutex> g(usage_lock); if (usage_known && usage_count > 0) out.used = static_cast<uint64_t>(usage_count); }
    const unsigned long long free = free_bytes();
    out.free = free == ~0ULL ? 0 : free;
  }
}
int hub_busy() { return http::active().load(); }

// Every answer leaves with the headers that say what a browser may do with it.
static http::Response route(http::Request &req) {
  ROOT = root_now();
  renew_cookie.clear();
  http::Response r = answer(req);
  if (r.hold) return r;
  if (!renew_cookie.empty() && r.extra.find("Set-Cookie") == string::npos) r.extra += device_cookie(renew_cookie, req.tls);

  bool page = req.method == "GET" && (req.path == "/" || req.path == "/trust") && r.status == 200;
  if (page) {
    // The page may also talk to the other hubs it has been told about.
    string csp = CSP_PAGE, also;
    if (req.path == "/") for (const Hub &h : read_hubs()) also += " " + h.url;
    size_t at = csp.find("connect-src 'self'");
    if (at != string::npos) csp.insert(at + 18, also);
    r.extra += csp;
    // The other hubs are part of what the page is: a device that kept the page before one was added is told it has
    // changed (its tag differs), as when the page's own file changes, and so does not keep a policy that leaves it out.
    if (!also.empty() && !r.etag.empty()) r.etag.insert(r.etag.size() - 1, "-" + workspace_id(also));
  }
  else if (r.extra.find("Content-Security-Policy") == string::npos && r.type != "application/pdf") r.extra += CSP_DATA;
  r.extra += COMMON_HEADERS;
  // A reader loaded from another hub may read the answer (see cross_site, above).
  if (cross_site(req) && plain_origin(req.header("origin"))) r.extra += "Access-Control-Allow-Origin: " + req.header("origin") + "\r\nAccess-Control-Expose-Headers: X-Hub-Workspace\r\nVary: Origin\r\n";
  // A page file the browser already has: say so, and send nothing. Done last,
  // so the answer carries the same headers the file itself would (a browser
  // applies them to the copy it holds).
  if (!r.etag.empty() && r.status == 200 && req.header("if-none-match") == r.etag) { r.status = 304; r.body.clear(); r.file.clear(); r.length = 0; }
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
  string folder = ".", host = "127.0.0.1", www, forced, workspaces;
  int port = 4321;
  bool want_tls = false, insecure = false, make_cert = false, new_authority = false;
  long long quota_mb = -1;
  const char *state_env = std::getenv("HUB_STATE");
  STATE = state_env ? state_env : sys::default_state_dir();
  for (int i = 1; i < argc; i++) {
    string a = argv[i];
    if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
    else if (a == "--host" && i + 1 < argc) host = argv[++i];
    else if (a == "--www" && i + 1 < argc) www = argv[++i];
    else if (a == "--profile" && i + 1 < argc) forced = argv[++i];
    else if (a == "--state" && i + 1 < argc) STATE = argv[++i];
    else if (a == "--workspaces" && i + 1 < argc) workspaces = argv[++i];
    else if (a == "--allow-host" && i + 1 < argc) extra_hosts.push_back(argv[++i]);
    else if (a == "--quota-mb" && i + 1 < argc) quota_mb = std::atoll(argv[++i]);
    else if (a == "--tls") want_tls = true;
    else if (a == "--insecure-http") insecure = true;
    else if (a == "--pair-local") pair_local = true;
    else if (a == "--make-cert") make_cert = true;
    else if (a == "--new-authority") make_cert = new_authority = true;
    else if (a == "--help" || a == "-h") {
      std::printf("usage: hubd [folder] [--port 4321] [--host 127.0.0.1] [--www <folder>/hub] [--profile desktop|small|esp32]\n"
                  "            [--state <dir>] [--workspaces <dir>] [--tls] [--insecure-http] [--pair-local] [--allow-host <name>] [--quota-mb <n>]\n"
                  "       hubd --make-cert [--state <dir>] [--allow-host <name>]\n"
                  "       hubd --new-authority [--state <dir>] [--allow-host <name>]\n\n"
                  "  --state         where certificates and the list of paired devices are kept (default ~/.config/hub)\n"
                  "  --workspaces    where uploads opened as workspaces of their own are kept (default: workspaces/ beside the page,\n"
                  "                  when the page is not inside the folder being served; otherwise none are kept)\n"
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
  sys::owner_only(STATE, 0700);
  recover_folder(STATE); // certificates and paired devices, before they are read
  if (!sys::net_start()) { std::fprintf(stderr, "the network could not be started\n"); return 1; }   // before the machine's names are asked for
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
    // Where to go to trust it, and the fingerprint to check there, together (23). The trust page comes over a connection
    // that is not encrypted yet, so what it shows can be swapped on the way; what is printed here cannot.
    std::printf("To trust this hub on another device (once for each device):\n");
    if (!loopback(host)) {
      Strings at;
      for (const string &n : names) if (n != "localhost" && n != "127.0.0.1" && n != "hub.local" && (secure::home_address(n) || ends_with(n, ".local"))) at.push_back(n);
      for (size_t i = 0; i < at.size() && i < 4; i++) std::printf("  %s http://%s:%d/trust\n", i ? "or  " : "open", at[i].c_str(), port);
    } else {
      std::printf("  (this hub answers this machine only: start it with --host 0.0.0.0 for other devices)\n");
    }
    std::printf("  and check that the page shows this fingerprint, the one printed here (SHA-256):\n    %s\n"
                "  If it does not, do not install it: someone on the network may be in between.\n"
                "  Without the network at all: copy %s to the device (AirDrop, a cable, a USB stick) and install it from there.\n",
                certs.ca_fingerprint.c_str(), certs.ca_path.c_str());
    if (make_cert) return 0;
    if (!tls.load(certs.cert_path, certs.key_path, err)) { std::fprintf(stderr, "TLS: %s\n", err.c_str()); return 1; }
    tls_on = true;
    ca_fingerprint_text = certs.ca_fingerprint.substr(0, 23);
  } else if (!loopback(host)) {
    std::printf("WARNING: serving the network without encryption. Anyone on it can read and change what is sent.\n");
  }

  string resolved;
  if (!sys::real_path(folder, resolved) || !is_dir(resolved)) { std::fprintf(stderr, "not a folder: %s\n", folder.c_str()); return 1; }
  HOME_DIR = open_root = ROOT = resolved;
  if (sys::real_path(STATE, resolved)) STATE = resolved;
  if (starts_with(STATE + "/", ROOT + "/")) { std::fprintf(stderr, "the state folder must not be inside the folder being served\n"); return 1; }
  // The page lives beside the server (../hub from server-cpp/), or inside the folder being served.
  if (www.empty()) www = is_file(ROOT + "/hub/index.html") ? ROOT + "/hub" : is_file("../hub/index.html") ? "../hub" : "hub";
  if (!sys::real_path(www, resolved) || !is_file(resolved + "/index.html")) { std::fprintf(stderr, "no index.html in %s\n", www.c_str()); return 1; }
  WWW = resolved;
  // Workspaces of their own are kept beside the page, unless the page is part
  // of what is being served (as on the board), or where --workspaces says.
  if (workspaces.empty() && !starts_with(WWW + "/", HOME_DIR + "/")) workspaces = WWW + "/workspaces";
  if (!workspaces.empty()) {
    make_dirs(workspaces);
    if (!sys::real_path(workspaces, resolved)) { std::fprintf(stderr, "cannot use %s for workspaces\n", workspaces.c_str()); return 1; }
    WORKSPACES = resolved;
    if (starts_with(STATE + "/", WORKSPACES + "/") || starts_with(WORKSPACES + "/", HOME_DIR + "/")) { std::fprintf(stderr, "the workspaces folder must not hold the state folder, or be inside the folder being served\n"); return 1; }
    // Start on the workspace that was open last time, if it is still there.
    string last;
    if (secure::slurp(WORKSPACES + "/.current", last) && !trim(last).empty() && is_dir(WORKSPACES + "/" + trim(last))) open_root = ROOT = WORKSPACES + "/" + trim(last);
  }
  if (port <= 0 || port > 65535) { std::fprintf(stderr, "bad port\n"); return 1; }

  detect_profile(forced);
  quota_bytes = (quota_mb >= 0 ? static_cast<unsigned long long>(quota_mb) : profile.quota_mb) << 20;
  CACHE = HOME_DIR + "/.hub-cache";
  if (is_dir(CACHE)) { unsigned long long freed = 0; remove_tree(CACHE, freed); } // lists left by an earlier run
  load_devices();
  std::printf("hubd: %s://%s:%d  (reading %s)\n", tls_on ? "https" : "http", host == "0.0.0.0" ? "localhost" : host.c_str(), port, ROOT.c_str());
  if (tls_on) std::printf("On this computer, open http://localhost:%d (no certificate needed). Other devices use https:// and the authority above.\n", port);
  std::printf("device: %s profile, %u cores, %llu MB memory; uploads up to %zu MB, %d connections at once\n", profile.name, device_cores, device_memory_mb, profile.max_upload >> 20, profile.max_conns);
  if (profile.sole_writer) {
    // Nothing else writes here: measure once now, then keep count as files are
    // written. Saves cut short by a power cut are put right first.
    Strings temporary;
    Scan s = look_over(nullptr, &temporary);
    bool fixed = false;
    for (const string &t : temporary) fixed = recover(t) || fixed;
    if (fixed) s = look_over();
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
  COOKIE = "hub_device_" + std::to_string(port);
  opt.tls = tls_on ? &tls : nullptr;
  opt.max_conns = profile.max_conns;
  opt.keepalive_ms = profile.keepalive_ms;
  opt.piece = profile.piece;
  opt.admit = memory_for_one_more;
  opt.listening = [] { serving = true; };
  serve_port = port;
  return http::serve(opt, route);
}
