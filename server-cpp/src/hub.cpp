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
// File access goes through dirent/stat/stdio only, which ESP-IDF maps onto an
// SD card, so these handlers are meant to move to the ESP32 unchanged.
#include <algorithm>
#include <chrono>
#include <cstring>
#include <ctime>
#include <fstream>
#include <mutex>
#include <set>
#include <sstream>
#include <vector>

#include "../vendor/cJSON.h"
#include "anchor.hpp"
#include "epub.hpp"
#include "http.hpp"
#include "links.hpp"

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
static string WWW;                     // where index.html and the vendor scripts live
static string STATE;                   // certificates and the list of paired devices: never inside ROOT
static const char *FRONT = "FRONTPAGE.md";
static const size_t MAX_JSON = 1 << 20;          // 1 MB for API bodies

// What the server allows itself depends on what it is running on. The profile
// is picked once at start-up (see detect_profile) and can be forced with --profile.
struct Profile {
  const char *name;
  size_t max_upload;   // largest file accepted by /api/upload
  int watch_ms;        // how often the folder is checked for changes
  bool cache_assets;   // keep index.html and the scripts in memory between requests
  bool cache_listing;  // keep the document list until a file changes
  int max_conns;       // connections served at once (each TLS connection costs tens of KB)
  int max_streams;     // open pages listening for changes
  size_t piece;        // bytes moved at a time when sending or receiving a file
  long keepalive_ms;   // how long an idle connection is kept
  unsigned long long quota_mb; // most the folder may hold in total
};
static const Profile PROFILES[] = {
    {"desktop", 200u << 20, 500, true, true, 64, 16, 64 * 1024, 5000, 20480},  // a computer: plenty of memory, fast disk
    {"small", 50u << 20, 1000, true, true, 24, 8, 16 * 1024, 5000, 8192},      // a Raspberry Pi class board: under 1 GB of memory
    {"esp32", 4u << 20, 5000, false, true, 4, 2, 4 * 1024, 2000, 3072},        // a microcontroller: SD card, a few hundred KB free
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

static bool read_file(const string &p, string &out) {
  std::ifstream f(p, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}
// The first `max` bytes of a file: enough to find a title without reading a large file whole.
static bool read_start(const string &p, string &out, size_t max) {
  FILE *f = std::fopen(p.c_str(), "rb");
  if (!f) return false;
  out.resize(max);
  out.resize(std::fread(&out[0], 1, max, f));
  std::fclose(f);
  return true;
}
static void make_dirs(const string &dir) {
  for (size_t i = 1; i <= dir.size(); i++) {
    if (i == dir.size() || dir[i] == '/') sys::make_dir(dir.substr(0, i));
  }
}
// Write to a temporary file and rename, so a crash or power cut never leaves a
// half-written file behind.
static bool write_file(const string &p, const string &data) {
  make_dirs(dirname_of(p));
  string tmp = p + ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f.write(data.data(), static_cast<std::streamsize>(data.size()));
    if (!f) return false;
  }
  return secure::replace(tmp, p);
}

// Delete a folder and everything in it. Links are removed, never followed.
static bool remove_tree(const string &dir) {
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
    if (S_ISDIR(st.st_mode)) ok = remove_tree(abs) && ok;
    else ok = ::unlink(abs.c_str()) == 0 && ok;
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
    if (strict && (part[0] == '.' || lower(part) == "node_modules")) return false;
#ifdef _WIN32
    if (sys::odd_on_windows(part)) return false;
#endif
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
  profile = PROFILES[2];
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
  string md, title;
  if (read_file(ROOT + "/" + FRONT, md)) {
    cJSON_AddStringToObject(cfg, "front", FRONT);
    if (first_h1(md, title)) set_str(cfg, "title", title);
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
static bool natural_less(const string &a, const string &b) {
  size_t i = 0, j = 0;
  while (i < a.size() && j < b.size()) {
    if (std::isdigit(static_cast<unsigned char>(a[i])) && std::isdigit(static_cast<unsigned char>(b[j]))) {
      size_t i2 = i, j2 = j;
      while (i2 < a.size() && std::isdigit(static_cast<unsigned char>(a[i2]))) i2++;
      while (j2 < b.size() && std::isdigit(static_cast<unsigned char>(b[j2]))) j2++;
      string na = a.substr(i, i2 - i), nb = b.substr(j, j2 - j);
      na.erase(0, std::min(na.find_first_not_of('0'), na.size() - 1));
      nb.erase(0, std::min(nb.find_first_not_of('0'), nb.size() - 1));
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

static string title_of(const string &abs) {
  string name = basename_of(abs), text, title;
  if (is_html(name)) {
    if (read_start(abs, text, 64 * 1024)) {
      string low = lower(text);
      size_t open = low.find("<title");
      size_t start = open == string::npos ? string::npos : low.find('>', open);
      size_t end = start == string::npos ? string::npos : low.find("</title>", start);
      if (end != string::npos && !trim(text.substr(start + 1, end - start - 1)).empty()) return trim(text.substr(start + 1, end - start - 1));
    }
    return name;
  }
  if (!ends_with(name, ".md")) return name;
  if (read_start(abs, text, 64 * 1024) && first_h1(text, title)) return title;
  return name.substr(0, name.size() - 3);
}

// ---- books -------------------------------------------------------------------
// An EPUB is listed as a folder of its pages, in reading order:
// "shelf/book.epub/OEBPS/ch1.xhtml". Such a path names a file inside the zip
// and is answered from there, so a page of a book is read, highlighted and
// annotated like any other page, and its pictures and styles are found beside it.

// The most of one file that is held in memory at once: an entry of a book, a document being mapped.
static size_t most_in_memory() { return profile.piece * 256; }
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
  if (!zip::list(book, entries)) return 404;
  const zip::Entry *e = zip::find(entries, inner);
  return e ? zip::read(book, *e, out, most_in_memory()) : 404;
}
static http::Response book_error(int status) { return http::error(status, status == 413 ? "too large to read from the book" : status == 500 ? "the book is damaged, or packed in a way not handled" : "no such file"); }
// The pages of a book, as documents.
static void list_book(const string &abs, const string &rel, bool side, cJSON *out) {
  std::vector<zip::Entry> entries;
  epub::Book book;
  if (!zip::list(abs, entries) || !epub::open(abs, entries, book, most_in_memory())) return;
  for (const epub::Chapter &c : book.chapters) {
    Strings parts;
    const string path = rel + "/" + c.path;
    if (!is_html(c.path) || !clean_parts(path, parts, true) || join(parts) != path) continue;   // not a page, or not a path the reader could ask for
    cJSON *doc = cJSON_CreateObject();
    cJSON_AddStringToObject(doc, "path", path.c_str());
    cJSON_AddStringToObject(doc, "group", rel.c_str());
    cJSON_AddStringToObject(doc, "title", c.title.c_str());
    if (!book.title.empty()) cJSON_AddStringToObject(doc, "bookTitle", book.title.c_str());   // whose page it is, for wherever the page is named away from its book
    cJSON_AddBoolToObject(doc, "side", side);
    cJSON_AddBoolToObject(doc, "front", false);
    cJSON_AddItemToArray(out, doc);
  }
}

// When a file was last changed, in seconds: the reader puts the folders that were added to most recently first.
static double changed_at(const string &abs) {
  struct stat st;
  return ::stat(abs.c_str(), &st) == 0 ? static_cast<double>(st.st_mtime) : 0;
}
// What makes a file one of saved links, judged by its beginning so a long file is not read through for the list:
// a browser's export of bookmarks, and a text or JSON file with a web address in it.
static bool is_bookmarks(const string &abs) { string start; return read_start(abs, start, 512) && start.find("NETSCAPE-Bookmark-file") != string::npos; }
static bool has_addresses(const string &abs) {
  string start;
  return read_start(abs, start, 64 * 1024) && (start.find("https://") != string::npos || start.find("https:\\/\\/") != string::npos);
}
// How many items of such a file are read: all of them. Only the microcontroller, with its few hundred KB, stops at 2000.
static size_t most_links() { return string(profile.name) == "esp32" ? 2000 : static_cast<size_t>(-1); }
static void walk(const string &dir, const string &rel, const Strings &ignore, const Strings &side, cJSON *out) {
  DIR *d = ::opendir(dir.c_str());
  if (!d) return;
  Strings names;
  while (dirent *e = ::readdir(d)) names.push_back(e->d_name);
  ::closedir(d);
  std::sort(names.begin(), names.end(), natural_less);
  for (const string &name : names) {
    string r = rel.empty() ? name : rel + "/" + name, abs = dir + "/" + name;
    if (name[0] == '.' || matches(r, ignore)) continue;
    if (is_dir(abs)) {
      if (name == "node_modules" || name == "notes" || abs == WWW) continue;
      walk(abs, r, ignore, side, out);
    } else if (readable(name) || is_media(name)) {
      cJSON *doc = cJSON_CreateObject();
      cJSON_AddStringToObject(doc, "path", r.c_str());
      cJSON_AddStringToObject(doc, "group", rel.c_str());
      cJSON_AddStringToObject(doc, "title", title_of(abs).c_str());
      cJSON_AddBoolToObject(doc, "side", matches(r, side));
      cJSON_AddBoolToObject(doc, "front", r == FRONT);
      cJSON_AddNumberToObject(doc, "changed", changed_at(abs));
      // A browser's export of bookmarks is a page of links: shown as cards, like a file of saved links.
      if (is_html(name) && is_bookmarks(abs)) cJSON_AddBoolToObject(doc, "links", true);
      cJSON_AddItemToArray(out, doc);
    } else if (lower(ext_of(name)) == ".epub") {
      list_book(abs, r, matches(r, side), out);
    } else if (is_link_file(name)) {
      if (!has_addresses(abs)) continue;
      cJSON *doc = cJSON_CreateObject();
      cJSON_AddStringToObject(doc, "path", r.c_str());
      cJSON_AddStringToObject(doc, "group", rel.c_str());
      cJSON_AddStringToObject(doc, "title", name.c_str());
      cJSON_AddBoolToObject(doc, "side", matches(r, side));
      cJSON_AddBoolToObject(doc, "front", false);
      cJSON_AddBoolToObject(doc, "links", true);
      cJSON_AddNumberToObject(doc, "changed", changed_at(abs));
      cJSON_AddItemToArray(out, doc);
    }
  }
}

// Every file under a folder, with its size and when it was last changed. A device that
// holds the folder these came from works out from this what it has that is new or
// changed, and sends only that (see "update" in the reader). Hidden names and
// node_modules are left out, as an upload leaves them out.
static void walk_files(const string &dir, const string &rel, cJSON *out) {
  DIR *d = ::opendir(dir.c_str());
  if (!d) return;
  Strings names;
  while (dirent *e = ::readdir(d)) names.push_back(e->d_name);
  ::closedir(d);
  std::sort(names.begin(), names.end(), natural_less);
  for (const string &name : names) {
    if (name[0] == '.' || name == "node_modules") continue;
    string r = rel + "/" + name, abs = dir + "/" + name;
    struct stat st;
    if (::stat(abs.c_str(), &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { if (abs != WWW) walk_files(abs, r, out); continue; }
    cJSON *f = cJSON_CreateObject();
    cJSON_AddStringToObject(f, "path", r.c_str());
    cJSON_AddNumberToObject(f, "size", static_cast<double>(st.st_size));
    cJSON_AddNumberToObject(f, "changed", static_cast<double>(st.st_mtime));
    cJSON_AddItemToArray(out, f);
  }
}

// ---- notes --------------------------------------------------------------------------

static cJSON *read_notes() {
  string text;
  cJSON *notes = read_file(ROOT + "/notes/notes.json", text) ? cJSON_Parse(text.c_str()) : nullptr;
  if (!cJSON_IsArray(notes)) { cJSON_Delete(notes); notes = cJSON_CreateArray(); }
  return notes;
}
static bool write_notes(const cJSON *notes) { return write_file(ROOT + "/notes/notes.json", dump(notes, true) + "\n"); }

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
  char buf[40];
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
  return buf;
}

// ---- who is asking: host names, paired devices -----------------------------------------
// See ../API.md, "Security". State lives in STATE/devices.json; only a hash of
// each device's token is kept, so the file alone lets nobody in.

#ifdef ESP_PLATFORM
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
  // Letters, digits, dots, hyphens, colons and brackets only: the address is
  // written into the page's content policy, where ";" or "," would start a new rule.
  return std::all_of(o.begin() + static_cast<long>(at), o.end(), [](unsigned char c) { return std::isalnum(c) || c == '.' || c == '-' || c == ':' || c == '[' || c == ']'; });
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

static unsigned long long quota_bytes = 0;      // 0: no limit
static std::mutex usage_lock;
static unsigned long long usage_cache = 0;
static http::Clock::time_point usage_at;
static bool usage_known = false;

static unsigned long long tree_size(const string &dir) {
  unsigned long long total = 0;
  DIR *d = ::opendir(dir.c_str());
  if (!d) return 0;
  while (dirent *e = ::readdir(d)) {
    string name = e->d_name;
    if (name == "." || name == "..") continue;
    string abs = dir + "/" + name;
    struct stat st;
    if (::stat(abs.c_str(), &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { if (abs != WWW) total += tree_size(abs); }
    else if (S_ISREG(st.st_mode)) total += static_cast<unsigned long long>(st.st_size);
  }
  ::closedir(d);
  return total;
}
static unsigned long long used_bytes() {
  std::lock_guard<std::mutex> g(usage_lock);
  if (!usage_known || http::Clock::now() - usage_at > std::chrono::seconds(3)) {
    usage_cache = tree_size(ROOT);
    usage_at = http::Clock::now();
    usage_known = true;
  }
  return usage_cache;
}
static unsigned long long free_bytes() {
  return sys::free_bytes(ROOT);
}
// Whether `more` bytes may be added: under the quota, and leaving the disk 16 MB to breathe.
static bool room_for(unsigned long long more) {
  if (free_bytes() < more + (16ULL << 20)) return false;
  return quota_bytes == 0 || used_bytes() + more <= quota_bytes;
}
// The same for a folder other than the open workspace, measured as it is now.
static bool room_in(const string &dir, unsigned long long more) {
  if (dir == ROOT) return room_for(more);
  if (free_bytes() < more + (16ULL << 20)) return false;
  return quota_bytes == 0 || tree_size(dir) + more <= quota_bytes;
}
static void used_more(unsigned long long n) { std::lock_guard<std::mutex> g(usage_lock); usage_cache += n; }

// ---- live reload: tell open pages which file changed --------------------------------
// No file-watching API is assumed (the ESP32 has none): the tree's modification
// times are compared once a second.

static std::mutex clients_lock;
static std::vector<std::shared_ptr<http::Conn>> clients;

static void snapshot(const string &dir, const string &rel, std::map<string, long long> &out) {
  DIR *d = ::opendir(dir.c_str());
  if (!d) return;
  while (dirent *e = ::readdir(d)) {
    string name = e->d_name;
    if (name[0] == '.' || name == "node_modules" || ends_with(name, ".tmp")) continue;
    string abs = dir + "/" + name, r = rel.empty() ? name : rel + "/" + name;
    struct stat st;
    if (::stat(abs.c_str(), &st) != 0) continue;
    if (S_ISDIR(st.st_mode)) { if (abs != WWW) snapshot(abs, r, out); }
    else out[r] = static_cast<long long>(st.st_mtime) * 1000003LL + static_cast<long long>(st.st_size);
  }
  ::closedir(d);
}
// Send one line to every open page; a page that cannot take it is dropped.
static void tell_clients(const string &line) {
  std::lock_guard<std::mutex> g(clients_lock);
  for (size_t i = 0; i < clients.size();) {
    clients[i]->within(2000);
    if (clients[i]->write_all(line)) i++;
    else clients.erase(clients.begin() + static_cast<long>(i));
  }
}
static void watch_loop() {
  std::map<string, long long> before;
  ROOT = root_now();
  string watching = ROOT;
  snapshot(ROOT, "", before);
  auto pinged = http::Clock::now();
  for (;;) {
    std::this_thread::sleep_for(std::chrono::milliseconds(profile.watch_ms));
    try {
    ROOT = root_now();
    // Another workspace was opened: start afresh there, with nothing to announce.
    if (ROOT != watching) { watching = ROOT; before.clear(); snapshot(ROOT, "", before); continue; }
    { std::lock_guard<std::mutex> g(clients_lock); if (clients.empty()) continue; }
    // A comment line now and then finds pages that have gone away, freeing their place.
    if (http::Clock::now() - pinged > std::chrono::seconds(20)) { tell_clients(": ping\n\n"); pinged = http::Clock::now(); }
    std::map<string, long long> after;
    snapshot(ROOT, "", after);
    Strings changed;
    for (const auto &kv : after) { auto it = before.find(kv.first); if (it == before.end() || it->second != kv.second) changed.push_back(kv.first); }
    for (const auto &kv : before) if (!after.count(kv.first)) changed.push_back(kv.first);
    before.swap(after);
    for (const string &file : changed) {
      Json msg(cJSON_CreateObject());
      cJSON_AddStringToObject(msg.p, "file", file.c_str());
      tell_clients("data: " + dump(msg.p) + "\n\n");
    }
    } catch (...) { before.clear(); }   // out of memory on a large folder must not end the server: start the comparison again
  }
}

// ---- routes ----------------------------------------------------------------------------

// The page and its scripts, kept in memory on machines that can spare it and
// re-read only when the file on disk changes.
struct CachedFile { long long stamp; string body; };
static std::mutex cache_lock;
static std::map<string, CachedFile> asset_cache;
static string listing_cache;
static unsigned long long listing_stamp = 0;

static long long stamp_of(const string &abs) {
  struct stat st;
  return ::stat(abs.c_str(), &st) == 0 && S_ISREG(st.st_mode) ? static_cast<long long>(st.st_mtime) * 1000003LL + static_cast<long long>(st.st_size) : -1;
}
// A file sent a piece at a time, straight from disk.
static http::Response file_response(const string &abs, const char *type) {
  struct stat st;
  if (::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return http::error(404, "no such file");
  http::Response r;
  r.type = type;
  r.file = abs;
  r.length = static_cast<unsigned long long>(st.st_size);
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
// One number that changes whenever any file in the folder is added, removed,
// resized or modified. Costs one stat per file and reads none of them.
static unsigned long long tree_stamp_now();
// The same, worked out at most once per watch interval: a burst of requests
// for the list costs one walk of the folder, not one each. A change made
// through this server (touch_tree) makes the next request look again at once.
static std::mutex stamp_lock;
static unsigned long long stamp_value = 0;
static http::Clock::time_point stamp_at;
static string stamp_root;
static bool stamp_fresh = false;
static void touch_tree() { std::lock_guard<std::mutex> g(stamp_lock); stamp_fresh = false; }
static unsigned long long tree_stamp() {
  std::lock_guard<std::mutex> g(stamp_lock);
  if (!stamp_fresh || stamp_root != ROOT || http::Clock::now() - stamp_at > std::chrono::milliseconds(profile.watch_ms)) {
    stamp_value = tree_stamp_now();
    stamp_at = http::Clock::now();
    stamp_root = ROOT;
    stamp_fresh = true;
  }
  return stamp_value;
}
static unsigned long long tree_stamp_now() {
  std::map<string, long long> snap;
  snapshot(ROOT, "", snap);
  unsigned long long h = 1469598103934665603ULL;
  for (char ch : ROOT) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;   // two workspaces never share a list
  for (const auto &kv : snap) {
    for (char ch : kv.first) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;
    h = (h ^ static_cast<unsigned long long>(kv.second)) * 1099511628211ULL;
  }
  return h;
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
static void search_tree(const string &dir, const string &rel, const Strings &ignore, const string &needle, cJSON *out, int &left) {
  DIR *d = ::opendir(dir.c_str());
  if (!d) return;
  Strings names;
  while (dirent *e = ::readdir(d)) names.push_back(e->d_name);
  ::closedir(d);
  std::sort(names.begin(), names.end(), natural_less);
  for (const string &name : names) {
    if (left <= 0) return;
    string r = rel.empty() ? name : rel + "/" + name, abs = dir + "/" + name;
    if (name[0] == '.' || matches(r, ignore)) continue;
    if (is_dir(abs)) {
      if (name == "node_modules" || name == "notes" || abs == WWW) continue;
      search_tree(abs, r, ignore, needle, out, left);
      continue;
    }
    if (is_link_file(name) ? has_addresses(abs) : is_html(name) && is_bookmarks(abs)) { search_links(abs, name, r, needle, out, left); continue; }
    if (!readable(name)) continue;
    string text;
    if (!read_start(abs, text, 2u << 20)) continue;
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
  }
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
        std::all_of(p.begin() + 4, p.end() - 3, [](unsigned char c) { return std::islower(c) || std::isdigit(c) || c == '-'; }))
      return asset_response(WWW + p, "text/javascript");
    for (const auto &a : ASSETS) {
      if (p != a.first) continue;
      // Scripts sit beside the page (copied there for the board), or in node_modules.
      string name = a.first + 1;
      http::Response r = asset_response(is_file(WWW + "/" + name) ? WWW + "/" + name : WWW + "/" + a.second, "text/javascript");
      // A worker runs under the policy its own file is sent with: the one for data would not let it run at all. It may run itself, and nothing more.
      if (p == "/vendor/pdf.worker.mjs") r.extra += "Content-Security-Policy: default-src 'none'; script-src 'self'\r\n";
      return r;
    }
    // The document engine (marginalia-engine): what reads a PDF's text and where each character is, for selecting and
    // highlighting on its pages. Many small modules, so they are served by name and not listed: plain names only, a
    // script, the style sheet or the WebAssembly, from the package's dist folder and its wasm folder and nowhere else.
    if (starts_with(p, "/vendor/marginalia/")) {
      const string name = p.substr(19), leaf = starts_with(name, "wasm/") ? name.substr(5) : name;
      const size_t dot = leaf.rfind('.');
      const string ext = dot == string::npos ? "" : leaf.substr(dot);
      const char *type = ext == ".js" ? "text/javascript" : ext == ".css" ? "text/css" : ext == ".wasm" ? "application/wasm" : nullptr;
      if (!type || dot == 0 || !std::all_of(leaf.begin(), leaf.begin() + static_cast<std::ptrdiff_t>(dot), [](unsigned char c) { return std::islower(c) || std::isdigit(c) || c == '-' || c == '_'; }))
        return http::error(404, "no such file");
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
    cJSON_AddNumberToObject(out.p, "free", static_cast<double>(free_bytes() == ~0ULL ? 0 : free_bytes()));
    return json_response(out.p);
  }

  // Files as they are on disk (HTML documents, images and the like).
  if (starts_with(p, "/raw/")) {
    Strings parts;
    if (!clean_parts(p.substr(5), parts, true)) return http::error(404, "not found");   // hidden files are not served, as they are not listed
    string abs = ROOT + "/" + join(parts);
    // A file inside a book: sent whole, from the zip.
    string book, inner;
    if (in_book(parts, book, inner)) {
      http::Response r;
      if (int bad = book_item(book, inner, r.body)) return book_error(bad);
      r.type = mime_of(parts.back());
      r.extra = CSP_RAW;
      return r;
    }
    struct stat st;
    if (::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return http::error(404, "no such file");
    const unsigned long long size = static_cast<unsigned long long>(st.st_size);
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
    if (static_cast<int>(clients.size()) >= profile.max_streams) return http::error(503, "too many open pages");
    http::Response r;
    req.conn->within(5000);
    if (!req.conn->write_all(string("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n") + COMMON_HEADERS + "\r\n\n")) { r.status = 500; r.close = true; return r; }
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
    // Building the list reads every file for its title, so keep the answer
    // until something in the folder changes.
    unsigned long long stamp = profile.cache_listing ? tree_stamp() : 0;
    if (profile.cache_listing) {
      std::lock_guard<std::mutex> g(cache_lock);
      if (stamp == listing_stamp && !listing_cache.empty()) { http::Response r; r.body = listing_cache; return r; }
    }
    Json cfg(read_config()), docs(cJSON_CreateArray());
    walk(ROOT, "", list_of(cfg.p, "ignore"), list_of(cfg.p, "side"), docs.p);
    http::Response r = json_response(docs.p);
    if (profile.cache_listing) { std::lock_guard<std::mutex> g(cache_lock); listing_cache = r.body; listing_stamp = stamp; }
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
    if (damaged(ROOT + "/hub.json", false)) return damaged_error("hub.json");
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
    if (!write_file(ROOT + "/hub.json", dump(file.p, true) + "\n")) return http::error(500, "could not save");
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
    if (!is_dir(abs) || sys::is_link(abs) || in_page_folder(abs)) return http::error(404, "no such folder");
    Json out(cJSON_CreateArray());
    walk_files(abs, join(parts), out.p);
    return json_response(out.p);
  }

  if (p == "/api/folder" && m == "DELETE") {
    Strings parts;
    auto it = req.query.find("path");
    struct stat st;
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || lower(parts[0]) == "notes" ||
        sys::is_link(ROOT + "/" + join(parts)) || ::stat((ROOT + "/" + join(parts)).c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) return http::error(400, "no such folder");
    string key = join(parts);
    // Not the page's own folder, nor a folder that holds it.
    if (in_page_folder(ROOT + "/" + key) || starts_with(WWW + "/", ROOT + "/" + key + "/")) return http::error(400, "no such folder");
    std::lock_guard<std::mutex> g(store_lock);
    if (!remove_tree(ROOT + "/" + key)) return http::error(500, "could not remove");
    touch_tree();
    Json file(read_settings_file());
    cJSON *locks = cJSON_GetObjectItemCaseSensitive(file.p, "locks");
    if (cJSON_IsObject(locks) && !damaged(ROOT + "/hub.json", false)) {
      Strings gone;
      const cJSON *l;
      cJSON_ArrayForEach(l, locks) { string k = l->string ? l->string : ""; if (k == key || k.compare(0, key.size() + 1, key + "/") == 0) gone.push_back(k); }
      for (const string &k : gone) cJSON_DeleteItemFromObjectCaseSensitive(locks, k.c_str());
      if (!write_file(ROOT + "/hub.json", dump(file.p, true) + "\n")) return http::error(500, "could not save");
    }
    Json out(cJSON_CreateObject());
    cJSON_AddStringToObject(out.p, "removed", key.c_str());
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
    if (::stat(abs.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return http::error(404, "no such file");
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
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || !readable(parts.back())) return http::error(404, "no such doc");
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

  if (p == "/api/doc") {
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true) || !readable(parts.back())) return http::error(404, "no such doc");
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
      if (!clean_parts(folder, parts, true) || !is_dir(ROOT + "/" + join(parts))) return http::error(400, "no such folder");
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
  if (p == "/api/notes" && m == "GET") { if (damaged(ROOT + "/notes/notes.json", true)) return damaged_error("notes.json"); Json notes(read_notes()); return json_response(notes.p); }
  if (p == "/api/notes" && m == "POST") {
    string raw;
    if (int bad = json_body(req, raw)) return body_error(bad);
    Json body(cJSON_Parse(raw.c_str()));
    // A highlight is a note with a quote and no text yet.
    string doc = str_of(body.p, "doc"), text = str_of(body.p, "text"), quote = str_of(body.p, "quote");
    if (doc.empty() || (text.empty() && quote.empty())) return http::error(400, "doc and text or quote required");
    std::lock_guard<std::mutex> g(store_lock);
    if (damaged(ROOT + "/notes/notes.json", true)) return damaged_error("notes.json");
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
    if (cJSON *a = clean_anchor(cJSON_GetObjectItemCaseSensitive(body.p, "anchor"))) cJSON_AddItemToObject(note, "anchor", a);
    if (cJSON *mg = clean_mg(cJSON_GetObjectItemCaseSensitive(body.p, "mg"))) cJSON_AddItemToObject(note, "mg", mg);
    cJSON_AddStringToObject(note, "text", text.c_str());
    cJSON_AddStringToObject(note, "ts", ts_ok ? own_ts.c_str() : now_iso().c_str());
    cJSON_AddStringToObject(note, "status", text.empty() ? "highlight" : "open");
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
    if (damaged(ROOT + "/notes/notes.json", true)) return damaged_error("notes.json");
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
    Json body(cJSON_Parse(text.c_str()));
    if (!cJSON_IsObject(body.p)) return http::error(400, "json object required");
    for (const char *key : {"text", "quote", "heading", "headingText", "type"}) if (has_str(body.p, key)) set_str(note, key, str_of(body.p, key));
    // A new quote comes with its own anchor, or with none: the old one is for the old quote.
    cJSON *a = clean_anchor(cJSON_GetObjectItemCaseSensitive(body.p, "anchor"));
    if (a || has_str(body.p, "quote")) cJSON_DeleteItemFromObjectCaseSensitive(note, "anchor");
    if (a) cJSON_AddItemToObject(note, "anchor", a);
    cJSON *mg = clean_mg(cJSON_GetObjectItemCaseSensitive(body.p, "mg"));
    if (mg || has_str(body.p, "quote")) cJSON_DeleteItemFromObjectCaseSensitive(note, "mg");
    if (mg) cJSON_AddItemToObject(note, "mg", mg);
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
    string abs = base + "/" + join(parts);
    if (in_page_folder(abs)) return http::error(400, "bad path");   // the page's own files are not changed through the API
    // A refusal after this point reads the body first: answered while the file
    // is still being sent, the browser sees a broken connection and no answer.
    auto refuse = [&](int status, const char *why) { req.discard_body(profile.max_upload); return http::error(status, why); };
    string tmp = abs + "." + secure::random_hex(4) + ".tmp";
    if (sys::path_too_long(tmp)) return refuse(400, "the name is too long for this system");
    Json out(cJSON_CreateObject());
    // A file that is here already is left as it is, unless the upload says it is a newer
    // copy of it ("replace=1": an update of a folder that was uploaded before). A folder
    // of that name is never replaced by a file.
    const bool replace = req.query.count("replace") && is_file(abs);
    if (!replace && (is_file(abs) || is_dir(abs))) {
      req.discard_body(profile.max_upload);
      cJSON_AddBoolToObject(out.p, "skipped", true);
      return json_response(out.p);
    }
    struct stat was;
    const unsigned long long old_size = replace && ::stat(abs.c_str(), &was) == 0 ? static_cast<unsigned long long>(was.st_size) : 0;
    if (!room_in(base, req.content_length)) return http::error(507, "storage is full");
    make_dirs(dirname_of(abs));
    if (int bad = req.save_body(tmp, profile.max_upload, profile.piece)) return bad == 507 ? http::error(507, "storage is full") : bad == 500 ? refuse(500, "could not save") : body_error(bad);
    if (!sys::replace(tmp, abs)) { ::unlink(tmp.c_str()); return http::error(500, "could not save"); }
    if (base == ROOT) used_more(static_cast<unsigned long long>(req.content_length) - old_size);   // what it adds; less than nothing if it shrank (the count wraps round and back)
    touch_tree();
    cJSON_AddBoolToObject(out.p, "saved", true);
    if (replace) cJSON_AddBoolToObject(out.p, "replaced", true);
    cJSON_AddStringToObject(out.p, "root", base.c_str());
    return json_response(out.p);
  }

  return http::error(404, "not found");
}

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
  }
  else if (r.extra.find("Content-Security-Policy") == string::npos && r.type != "application/pdf") r.extra += CSP_DATA;
  r.extra += COMMON_HEADERS;
  // A reader loaded from another hub may read the answer (see cross_site, above).
  if (cross_site(req) && plain_origin(req.header("origin"))) r.extra += "Access-Control-Allow-Origin: " + req.header("origin") + "\r\nVary: Origin\r\n";
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
    std::printf("To trust this hub on a device, install its authority once: %s\n  (or open http://<this address>:%d/ on the device and follow the steps)\n  fingerprint (SHA-256) %s\n", certs.ca_path.c_str(), port, certs.ca_fingerprint.c_str());
    if (make_cert) return 0;
    if (!tls.load(certs.cert_path, certs.key_path, err)) { std::fprintf(stderr, "TLS: %s\n", err.c_str()); return 1; }
    tls_on = true;
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
  load_devices();
  std::thread(watch_loop).detach();
  std::printf("hubd: %s://%s:%d  (reading %s)\n", tls_on ? "https" : "http", host == "0.0.0.0" ? "localhost" : host.c_str(), port, ROOT.c_str());
  if (tls_on) std::printf("On this computer, open http://localhost:%d (no certificate needed). Other devices use https:// and the authority above.\n", port);
  std::printf("device: %s profile, %u cores, %llu MB memory; uploads up to %zu MB, folder checked every %d ms, %d connections at once\n", profile.name, device_cores, device_memory_mb, profile.max_upload >> 20, profile.watch_ms, profile.max_conns);
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
  return http::serve(opt, route);
}
