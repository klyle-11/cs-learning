// The hub's server, in C++: the same HTTP API as hub/server.js (see ../API.md),
// serving the same hub/index.html.
//
//   hubd [folder] [--port 4321] [--host 127.0.0.1] [--www <folder>/hub] [--profile desktop|small|esp32]
//
// File access goes through dirent/stat/stdio only, which ESP-IDF maps onto an
// SD card, so these handlers are meant to move to the ESP32 unchanged.
#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <chrono>
#include <ctime>
#include <fstream>
#include <mutex>
#include <random>
#include <sstream>
#include <vector>

#include "../vendor/cJSON.h"
#include "http.hpp"

using std::string;
using Strings = std::vector<string>;

static string ROOT;                    // the folder of documents
static string WWW;                     // where index.html and the vendor scripts live
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
};
static const Profile PROFILES[] = {
    {"desktop", 200u << 20, 500, true, true},   // a computer: plenty of memory, fast disk
    {"small", 50u << 20, 1000, true, true},     // a Raspberry Pi class board: under 1 GB of memory
    {"esp32", 4u << 20, 5000, false, true},     // a microcontroller: SD card, a few hundred KB free
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
static void make_dirs(const string &dir) {
  for (size_t i = 1; i <= dir.size(); i++) {
    if (i == dir.size() || dir[i] == '/') ::mkdir(dir.substr(0, i).c_str(), 0755);
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
  return ::rename(tmp.c_str(), p.c_str()) == 0;
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
static const char *mime_of(const string &name) {
  static const std::pair<const char *, const char *> types[] = {
      {".html", "text/html"}, {".htm", "text/html"}, {".css", "text/css"}, {".js", "text/javascript"},
      {".mjs", "text/javascript"}, {".json", "application/json"}, {".svg", "image/svg+xml"}, {".png", "image/png"},
      {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}, {".gif", "image/gif"}, {".webp", "image/webp"},
      {".pdf", "application/pdf"}, {".woff2", "font/woff2"}};
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
    if (read_file(abs, text)) {
      string low = lower(text);
      size_t open = low.find("<title");
      size_t start = open == string::npos ? string::npos : low.find('>', open);
      size_t end = start == string::npos ? string::npos : low.find("</title>", start);
      if (end != string::npos && !trim(text.substr(start + 1, end - start - 1)).empty()) return trim(text.substr(start + 1, end - start - 1));
    }
    return name;
  }
  if (!ends_with(name, ".md")) return name;
  if (read_file(abs, text) && first_h1(text, title)) return title;
  return name.substr(0, name.size() - 3);
}

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
    } else if (readable(name)) {
      cJSON *doc = cJSON_CreateObject();
      cJSON_AddStringToObject(doc, "path", r.c_str());
      cJSON_AddStringToObject(doc, "group", rel.c_str());
      cJSON_AddStringToObject(doc, "title", title_of(abs).c_str());
      cJSON_AddBoolToObject(doc, "side", matches(r, side));
      cJSON_AddBoolToObject(doc, "front", r == FRONT);
      cJSON_AddItemToArray(out, doc);
    }
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
  static std::mt19937_64 rng{std::random_device{}()};
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  string id;
  for (auto v = static_cast<unsigned long long>(ms); v > 0; v /= 36) id.insert(id.begin(), digits[v % 36]);
  for (int i = 0; i < 4; i++) id += digits[rng() % 36];
  return id;
}
static string now_iso() {
  auto now = std::chrono::system_clock::now();
  std::time_t t = std::chrono::system_clock::to_time_t(now);
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
  std::tm tm{};
  ::gmtime_r(&t, &tm);
  char buf[40];
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
  return buf;
}

// ---- live reload: tell open pages which file changed --------------------------------
// No file-watching API is assumed (the ESP32 has none): the tree's modification
// times are compared once a second.

static std::mutex clients_lock;
static std::vector<int> clients;

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
static void watch_loop() {
  std::map<string, long long> before;
  snapshot(ROOT, "", before);
  for (;;) {
    std::this_thread::sleep_for(std::chrono::milliseconds(profile.watch_ms));
    { std::lock_guard<std::mutex> g(clients_lock); if (clients.empty()) continue; }
    std::map<string, long long> after;
    snapshot(ROOT, "", after);
    Strings changed;
    for (const auto &kv : after) { auto it = before.find(kv.first); if (it == before.end() || it->second != kv.second) changed.push_back(kv.first); }
    for (const auto &kv : before) if (!after.count(kv.first)) changed.push_back(kv.first);
    before.swap(after);
    for (const string &file : changed) {
      Json msg(cJSON_CreateObject());
      cJSON_AddStringToObject(msg.p, "file", file.c_str());
      string line = "data: " + dump(msg.p) + "\n\n";
      std::lock_guard<std::mutex> g(clients_lock);
      for (size_t i = 0; i < clients.size();) {
        if (http::send_all(clients[i], line)) i++;
        else { ::close(clients[i]); clients.erase(clients.begin() + static_cast<long>(i)); }
      }
    }
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
static http::Response file_response(const string &abs, const char *type);
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
// One number that changes whenever any file in the folder is added, removed,
// resized or modified. Costs one stat per file and reads none of them.
static unsigned long long tree_stamp() {
  std::map<string, long long> snap;
  snapshot(ROOT, "", snap);
  unsigned long long h = 1469598103934665603ULL;
  for (const auto &kv : snap) {
    for (char ch : kv.first) h = (h ^ static_cast<unsigned char>(ch)) * 1099511628211ULL;
    h = (h ^ static_cast<unsigned long long>(kv.second)) * 1099511628211ULL;
  }
  return h;
}

static http::Response file_response(const string &abs, const char *type) {
  http::Response r;
  if (!is_file(abs) || !read_file(abs, r.body)) return http::error(404, "no such file");
  r.type = type;
  return r;
}

static http::Response route(http::Request &req) {
  const string &p = req.path, &m = req.method;

  // A page on another website must not be able to change anything here. Browsers
  // put the calling site in the Origin header; if it is not this server, refuse.
  auto origin = req.headers.find("origin");
  if (m != "GET" && origin != req.headers.end()) {
    auto host = req.headers.find("host");
    size_t scheme = origin->second.find("://");
    string from = scheme == string::npos ? "" : origin->second.substr(scheme + 3);
    if (host == req.headers.end() || from != host->second) return http::error(403, "requests from other sites are not allowed");
  }

  if (p == "/") return asset_response(WWW + "/index.html", "text/html");
  if (p == "/vendor/marked.js") return asset_response(is_file(WWW + "/vendor/marked.js") ? WWW + "/vendor/marked.js" : WWW + "/node_modules/marked/lib/marked.umd.js", "text/javascript");
  if (p == "/vendor/highlight.js") return asset_response(is_file(WWW + "/vendor/highlight.js") ? WWW + "/vendor/highlight.js" : WWW + "/node_modules/@highlightjs/cdn-assets/highlight.min.js", "text/javascript");

  // Files as they are on disk (HTML documents, images and the like).
  if (starts_with(p, "/raw/")) {
    Strings parts;
    if (!clean_parts(p.substr(5), parts, false)) return http::error(404, "not found");
    return file_response(ROOT + "/" + join(parts), mime_of(parts.back()));
  }

  // The event stream: answer the headers here and keep the socket for watch_loop.
  if (p == "/api/events") {
    http::Response r;
    if (!http::send_all(req.fd, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n\n")) return http::error(500, "stream failed");
    std::lock_guard<std::mutex> g(clients_lock);
    clients.push_back(req.fd);
    r.hold = true;
    return r;
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
    return json_response(d.p);
  }

  if (p == "/api/config" && m == "GET") { Json cfg(read_config()); return json_response(cfg.p); }
  if (p == "/api/config" && m == "PUT") {
    Json body(cJSON_Parse(req.body.c_str()));
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
    if (!write_file(ROOT + "/hub.json", dump(file.p, true) + "\n")) return http::error(500, "could not save");
    Json cfg(read_config());
    return json_response(cfg.p);
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
    Json body(cJSON_Parse(req.body.c_str()));
    if (!has_str(body.p, "markdown")) return http::error(400, "markdown required");
    string md = str_of(body.p, "markdown");
    if (md.empty() || md.back() != '\n') md += '\n';
    std::lock_guard<std::mutex> g(store_lock);
    if (!write_file(ROOT + "/" + FRONT, md)) return http::error(500, "could not save");
    Json cfg(read_config());
    return json_response(cfg.p);
  }

  if (p == "/api/notes" && m == "GET") { Json notes(read_notes()); return json_response(notes.p); }
  if (p == "/api/notes" && m == "POST") {
    Json body(cJSON_Parse(req.body.c_str()));
    // A highlight is a note with a quote and no text yet.
    string doc = str_of(body.p, "doc"), text = str_of(body.p, "text"), quote = str_of(body.p, "quote");
    if (doc.empty() || (text.empty() && quote.empty())) return http::error(400, "doc and text or quote required");
    std::lock_guard<std::mutex> g(store_lock);
    Json notes(read_notes());
    cJSON *note = cJSON_CreateObject();
    cJSON_AddStringToObject(note, "id", new_id().c_str());
    cJSON_AddStringToObject(note, "doc", doc.c_str());
    cJSON_AddStringToObject(note, "heading", str_of(body.p, "heading").c_str());
    cJSON_AddStringToObject(note, "headingText", str_of(body.p, "headingText").c_str());
    cJSON_AddStringToObject(note, "quote", quote.c_str());
    cJSON_AddStringToObject(note, "type", str_of(body.p, "type").c_str());
    cJSON_AddStringToObject(note, "text", text.c_str());
    cJSON_AddStringToObject(note, "ts", now_iso().c_str());
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
    Json body(cJSON_Parse(req.body.c_str()));
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

  // One file of an uploaded folder, added to this folder. Existing files are never overwritten.
  if (p == "/api/upload" && m == "POST") {
    if (req.query.count("workspace")) return http::error(501, "opening an upload as its own workspace is not in the C++ server yet");
    Strings parts;
    auto it = req.query.find("path");
    if (it == req.query.end() || !clean_parts(it->second, parts, true)) return http::error(400, "bad path");
    string abs = ROOT + "/" + join(parts);
    Json out(cJSON_CreateObject());
    if (is_file(abs) || is_dir(abs)) {
      cJSON_AddBoolToObject(out.p, "skipped", true);
    } else {
      if (!write_file(abs, req.body)) return http::error(500, "could not save");
      cJSON_AddBoolToObject(out.p, "saved", true);
      cJSON_AddStringToObject(out.p, "root", ROOT.c_str());
    }
    return json_response(out.p);
  }

  return http::error(404, "not found");
}

int main(int argc, char **argv) {
  string folder = ".", host = "127.0.0.1", www, forced;
  int port = 4321;
  for (int i = 1; i < argc; i++) {
    string a = argv[i];
    if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
    else if (a == "--host" && i + 1 < argc) host = argv[++i];
    else if (a == "--www" && i + 1 < argc) www = argv[++i];
    else if (a == "--profile" && i + 1 < argc) forced = argv[++i];
    else if (a == "--help" || a == "-h") { std::printf("usage: hubd [folder] [--port 4321] [--host 127.0.0.1] [--www <folder>/hub] [--profile desktop|small|esp32]\n"); return 0; }
    else folder = a;
  }
  char resolved[4096];
  if (!::realpath(folder.c_str(), resolved) || !is_dir(resolved)) { std::fprintf(stderr, "not a folder: %s\n", folder.c_str()); return 1; }
  ROOT = resolved;
  if (www.empty()) www = ROOT + "/hub";
  if (!::realpath(www.c_str(), resolved) || !is_file(string(resolved) + "/index.html")) { std::fprintf(stderr, "no index.html in %s\n", www.c_str()); return 1; }
  WWW = resolved;
  if (port <= 0 || port > 65535) { std::fprintf(stderr, "bad port\n"); return 1; }

  detect_profile(forced);
  std::thread(watch_loop).detach();
  std::printf("hubd: http://%s:%d  (reading %s)\n", host == "0.0.0.0" ? "localhost" : host.c_str(), port, ROOT.c_str());
  std::printf("device: %s profile, %u cores, %llu MB memory; uploads up to %zu MB, folder checked every %d ms\n", profile.name, device_cores, device_memory_mb, profile.max_upload >> 20, profile.watch_ms);
  std::fflush(stdout);
  return http::serve(host, port, route, [](const string &path) { return path == "/api/upload" ? profile.max_upload : MAX_JSON; });
}
