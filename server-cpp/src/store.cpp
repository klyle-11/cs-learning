// The small file store used by the ESP32 reader.  Unlike hub.cpp it never
// scans the whole workspace, reads document contents for a listing, or keeps
// state proportional to the number of files.  The browser does that work.
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "version.h"
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "../vendor/cJSON.h"
#include "http.hpp"
#include "status.hpp"

using std::string;
using Strings = std::vector<string>;

static string ROOT, WWW, TLS_CERT;
static string desktop_password, desktop_setup_code;
static bool desktop_password_set = false;
static int desktop_bad_codes = 0;
static std::mutex auth_lock, write_lock, changes_lock, status_lock;
static std::atomic<unsigned> list_number{0};
static unsigned long long change_counter = 1;
static const size_t MAX_UPLOAD = 0xFFFFFFFFu;
static const size_t MAX_JSON = 2048;
static const uint64_t RESERVED_FREE = 16ull << 20;

struct Change { unsigned long long number; string first, second; };
static std::deque<Change> recent_changes; // exactly bounded: at most 64 operations

static HubStatus current_status;
struct RecentPeer { string ip; http::Clock::time_point at; };
static std::deque<RecentPeer> recent_peers; // bounded independently of request count

#ifdef ESP_PLATFORM
// WP3 owns the NVS representation.  Weak fallbacks keep this file independently
// buildable while allowing board.cpp to provide the persistent implementation.
extern "C" __attribute__((weak)) bool board_store_password_is_set() { return false; }
extern "C" __attribute__((weak)) bool board_store_check_password(const char *) { return false; }
extern "C" __attribute__((weak)) bool board_store_set_password(const char *) { return false; }
extern "C" __attribute__((weak)) const char *board_store_setup_code() { return ""; }
extern "C" __attribute__((weak)) void board_store_bad_setup_code() {}
#endif

static bool starts_with(const string &s, const string &head) { return s.compare(0, head.size(), head) == 0; }
static bool ends_with(const string &s, const string &tail) {
  return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0;
}
static string lower(string s) {
  for (char &c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}
static string dirname_of(const string &path) {
  size_t slash = path.rfind('/');
  return slash == string::npos ? "" : path.substr(0, slash);
}
static bool is_dir(const string &path) {
  bool dir = false; uint64_t size = 0;
  return fs::info(path, dir, size) && dir;
}
static bool exists(const string &path) {
  bool dir = false; uint64_t size = 0;
  return fs::info(path, dir, size);
}
static void make_dirs(const string &path) {
  if (path.empty() || is_dir(path)) return;
  Strings missing;
  string at = path;
  while (!at.empty() && !is_dir(at)) {
    missing.push_back(at);
    const string parent = dirname_of(at);
    if (parent == at) break;
    at = parent;
  }
  for (auto it = missing.rbegin(); it != missing.rend(); ++it) sys::make_dir(*it);
}

// Empty a private temporary tree.  Links are removed rather than followed.
static bool remove_tree(const string &path, int depth = 0) {
  if (depth > 64) return false;
  if (sys::is_link(path)) return sys::remove_link(path);
  bool dir = false; uint64_t size = 0;
  if (!fs::info(path, dir, size)) return true;
  if (!dir) return ::unlink(path.c_str()) == 0;
  bool ok = true;
  fs::each(path, [&](const fs::Entry &entry) {
    if (!remove_tree(path + "/" + entry.name, depth + 1)) ok = false;
  });
  return ::rmdir(path.c_str()) == 0 && ok;
}

// An API path.  The empty path is allowed only for listing the root.  Hidden
// names are refused except .removed, which is part of the public store model.
static bool clean_path(const string &rel, Strings &parts, bool root_ok = false) {
  parts.clear();
  if (rel.empty()) return root_ok;
  if (rel.front() == '/' || rel.back() == '/') return false;
  size_t at = 0;
  while (at < rel.size()) {
    size_t slash = rel.find('/', at);
    if (slash == string::npos) slash = rel.size();
    string part = rel.substr(at, slash - at);
    if (part.empty() || part == "." || part == ".." || part.find('\\') != string::npos || part.find('\0') != string::npos) return false;
    if (part[0] == '.' && part != ".removed") return false;
#ifdef _WIN32
    if (sys::odd_on_windows(part)) return false;
#endif
    parts.push_back(part);
    at = slash + 1;
  }
  return !parts.empty();
}

// Reject links in existing prefixes.  A link inside the workspace must never
// turn an otherwise-clean relative path into access outside the workspace.
static bool safe_path(const Strings &parts, string &absolute) {
  absolute = ROOT;
  for (const string &part : parts) {
    absolute += "/" + part;
    if (sys::is_link(absolute)) return false;
  }
  return true;
}

static string json_quote(const string &text) {
  string out = "\"";
  for (char raw : text) {
    const unsigned char c = static_cast<unsigned char>(raw);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char escaped[7]; std::snprintf(escaped, sizeof escaped, "\\u%04x", c); out += escaped; }
        else out += static_cast<char>(c);
    }
  }
  return out + "\"";
}

static const char *mime_of(const string &name) {
  static const std::pair<const char *, const char *> types[] = {
      {".html", "text/html"}, {".htm", "text/html"}, {".css", "text/css"}, {".js", "text/javascript"},
      {".mjs", "text/javascript"}, {".json", "application/json"}, {".svg", "image/svg+xml"}, {".png", "image/png"},
      {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}, {".gif", "image/gif"}, {".webp", "image/webp"},
      {".pdf", "application/pdf"}, {".wasm", "application/wasm"}, {".woff2", "font/woff2"}, {".mp4", "video/mp4"},
      {".m4v", "video/mp4"}, {".mov", "video/quicktime"}, {".webm", "video/webm"}, {".ogv", "video/ogg"},
      {".mp3", "audio/mpeg"}, {".m4a", "audio/mp4"}, {".wav", "audio/wav"}, {".ogg", "audio/ogg"}};
  const size_t dot = name.rfind('.');
  const string ext = dot == string::npos ? "" : lower(name.substr(dot));
  for (const auto &type : types) if (ext == type.first) return type.second;
  return "text/plain";
}

static long long mtime_of(const string &path) {
  struct stat st;
  return ::stat(path.c_str(), &st) == 0 ? static_cast<long long>(st.st_mtime) : 0;
}
static string etag_of(uint64_t size, long long mtime) {
  return "\"" + std::to_string(size) + "-" + std::to_string(mtime) + "\"";
}

static void note_change(const string &first, const string &second = "") {
  std::lock_guard<std::mutex> guard(changes_lock);
  ++change_counter;
  recent_changes.push_back({change_counter, first, second});
  while (recent_changes.size() > 64) recent_changes.pop_front();
}

static bool password_is_set() {
#ifdef ESP_PLATFORM
  return board_store_password_is_set();
#else
  return desktop_password_set;
#endif
}
static bool password_matches(const string &password) {
#ifdef ESP_PLATFORM
  return board_store_check_password(password.c_str());
#else
  return desktop_password_set && secure::same(password, desktop_password);
#endif
}
static bool set_password(const string &password) {
#ifdef ESP_PLATFORM
  return board_store_set_password(password.c_str());
#else
  desktop_password = password;
  desktop_password_set = true;
  desktop_bad_codes = 0;
  return true;
#endif
}
static string setup_code() {
#ifdef ESP_PLATFORM
  const char *code = board_store_setup_code();
  return code ? code : "";
#else
  return desktop_setup_code;
#endif
}
static void bad_setup_code() {
#ifdef ESP_PLATFORM
  board_store_bad_setup_code();
#else
  if (++desktop_bad_codes >= 5) {
    desktop_bad_codes = 0;
    desktop_setup_code = secure::random_code(6);
    std::printf("store setup code: %s\n", desktop_setup_code.c_str());
    std::fflush(stdout);
  }
#endif
}

static string bearer(const http::Request &request) {
  const string &header = request.header("authorization");
  if (!starts_with(header, "Bearer ")) return "";
  size_t first = header.find_first_not_of(" \t", 7);
  size_t last = header.find_last_not_of(" \t");
  return first == string::npos ? "" : header.substr(first, last - first + 1);
}
static bool cross_site(const http::Request &request) {
  const string &origin = request.header("origin"), &site = request.header("sec-fetch-site");
  if (!origin.empty()) {
    size_t scheme = origin.find("://");
    if (scheme == string::npos || origin.substr(scheme + 3) != request.header("host")) return true;
  }
  return !site.empty() && site != "same-origin" && site != "none";
}

static void saw_peer(const string &ip) {
  std::lock_guard<std::mutex> guard(status_lock);
  const auto now = http::Clock::now();
  recent_peers.erase(std::remove_if(recent_peers.begin(), recent_peers.end(), [&](const RecentPeer &peer) {
    return now - peer.at > std::chrono::minutes(2);
  }), recent_peers.end());
  auto found = std::find_if(recent_peers.begin(), recent_peers.end(), [&](const RecentPeer &peer) { return peer.ip == ip; });
  if (found != recent_peers.end()) found->at = now;
  else {
    if (recent_peers.size() == 8) recent_peers.pop_front();
    recent_peers.push_back({ip, now});
  }
}

void hub_status(HubStatus &out) {
  std::lock_guard<std::mutex> guard(status_lock);
  const auto now = http::Clock::now();
  recent_peers.erase(std::remove_if(recent_peers.begin(), recent_peers.end(), [&](const RecentPeer &peer) {
    return now - peer.at > std::chrono::minutes(2);
  }), recent_peers.end());
  current_status.peer_count = static_cast<int>(recent_peers.size());
  for (size_t i = 0; i < recent_peers.size(); ++i) {
    std::snprintf(current_status.peers[i].ip, sizeof current_status.peers[i].ip, "%s", recent_peers[i].ip.c_str());
    current_status.peers[i].name[0] = '\0';
    current_status.peers[i].live = false;
  }
  const string code = password_is_set() ? "" : setup_code();
  std::snprintf(current_status.pair_code, sizeof current_status.pair_code, "%s", code.c_str());
  uint64_t total = 0, free = 0;
  if (fs::space(ROOT, total, free)) { current_status.free = free; current_status.used = total - free; }
  out = current_status;
}
int hub_busy() { return http::active().load(); }
void hub_tick() {}

static bool memory_for_connection() {
#ifdef ESP_PLATFORM
  return heap_caps_get_free_size(MALLOC_CAP_INTERNAL) > 40 * 1024 &&
         heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) > 16 * 1024 &&
         heap_caps_get_free_size(MALLOC_CAP_SPIRAM) > 96 * 1024;
#else
  return true;
#endif
}

static const char *CSP_PAGE =
    "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'\r\n"
    "X-Frame-Options: DENY\r\nCross-Origin-Opener-Policy: same-origin\r\n";
static const char *CSP_RAW =
    "Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'\r\n";
static const char *CSP_DATA = "Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'\r\n";
static const char *COMMON_HEADERS = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\nX-DNS-Prefetch-Control: off\r\n";

static http::Response file_response(const string &path, const char *type, bool page) {
  bool dir = false; uint64_t size = 0;
  if (!fs::info(path, dir, size) || dir) return http::error(404, "no such file");
  http::Response response;
  response.type = type;
  response.file = path;
  response.length = size;
  response.etag = etag_of(size, mtime_of(path));
  response.extra = page ? CSP_PAGE : "";
  return response;
}

// Page files are public.  WWW is trusted server input; client path parts are
// still checked and node_modules is never exposed directly.
static http::Response page_file(const http::Request &request) {
  string rel = request.path == "/" ? "index.html" : request.path == "/trust" ? "store-trust.html" :
               request.path == "/trust.js" ? "store-trust.js" : request.path.substr(1);
  Strings parts;
  if (!clean_path(rel, parts) || std::find(parts.begin(), parts.end(), "node_modules") != parts.end()) return http::error(404, "no such file");
  string path = WWW;
  for (const string &part : parts) { path += "/" + part; if (sys::is_link(path)) return http::error(404, "no such file"); }
  const char *type = request.path == "/manifest.webmanifest" ? "application/manifest+json" : mime_of(parts.back());
  http::Response response = file_response(path, type, request.path == "/" || ends_with(rel, ".html"));
  // A worker runs under the policy its own file is sent with, and the one for
  // data (route) would leave it unable to fetch, or to use the page's cache:
  // with it, the service worker broke every reload. The same policies as the
  // full server's (hub.cpp): each worker may do what it needs and nothing more.
  if (response.status == 200) {
    const string &p = request.path;
    if (p == "/sw.js") response.extra += "Content-Security-Policy: default-src 'none'; connect-src 'self'\r\n";
    else if (p == "/js/engine-worker.js" || p == "/vendor/marginalia/worker.js")
      response.extra += "Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'\r\n";
    else if (p == "/vendor/pdf.worker.mjs" || p == "/vendor/marginalia/recolor-worker.js")
      response.extra += "Content-Security-Policy: default-src 'none'; script-src 'self'\r\n";
  }
  return response;
}

struct TempFile {
  string path;
  explicit TempFile(string value) : path(std::move(value)) {}
  ~TempFile() { if (!path.empty()) ::unlink(path.c_str()); }
};

static http::Response list_folder(const http::Request &request) {
  auto it = request.query.find("path");
  const string rel = it == request.query.end() ? "" : it->second;
  Strings parts;
  if (!clean_path(rel, parts, true)) return http::error(400, "bad path");
  string folder;
  if (!safe_path(parts, folder) || !is_dir(folder)) return http::error(404, "no such folder");
  const bool hidden = request.query.count("hidden") && request.query.at("hidden") == "1";
  const string temp = ROOT + "/.hub-cache/list-" + std::to_string(++list_number) + ".tmp";
  FILE *out = std::fopen(temp.c_str(), "wb");
  if (!out) return http::error(500, "could not list folder");
  bool first = true, write_ok = std::fputc('[', out) != EOF;
  const bool read_ok = fs::each(folder, [&](const fs::Entry &entry) {
    const string name = entry.name;
    if (!write_ok || (!hidden && !name.empty() && name[0] == '.') || name == ".hub-cache") return;
    const string item = string(first ? "" : ",") + "{\"name\":" + json_quote(name) + ",\"dir\":" + (entry.dir ? "true" : "false") +
                        ",\"size\":" + std::to_string(entry.size) + ",\"mtime\":" + std::to_string(entry.time) + "}";
    write_ok = std::fwrite(item.data(), 1, item.size(), out) == item.size();
    first = false;
  });
  write_ok = std::fputc(']', out) != EOF && write_ok;
  write_ok = std::fclose(out) == 0 && write_ok;
  if (!read_ok || !write_ok) { ::unlink(temp.c_str()); return http::error(read_ok ? 507 : 404, read_ok ? "could not write listing" : "no such folder"); }
  uint64_t size = 0;
  if (!fs::file_size(temp, size)) { ::unlink(temp.c_str()); return http::error(500, "could not list folder"); }
  http::Response response;
  response.file = temp;
  response.length = size;
  response.keep = std::make_shared<TempFile>(temp);
  return response;
}

static http::Response raw_get(const http::Request &request, const string &absolute, const string &name) {
  bool dir = false; uint64_t size = 0;
  if (!fs::info(absolute, dir, size) || dir) return http::error(404, "no such file");
  const string etag = etag_of(size, mtime_of(absolute));
  http::Response response;
  response.type = mime_of(name);
  response.etag = etag;
  response.extra = "Accept-Ranges: bytes\r\n";
  if (response.type != "application/pdf") response.extra += CSP_RAW;
  if (request.header("if-none-match") == etag) { response.status = 304; return response; }
  uint64_t start = 0, end = size == 0 ? 0 : size - 1;
  bool partial = false;
  const string range = request.header("range");
  if (!range.empty() && starts_with(range, "bytes=")) {
    const string spec = range.substr(6);
    const size_t dash = spec.find('-');
    const string a = dash == string::npos ? "" : spec.substr(0, dash), b = dash == string::npos ? "" : spec.substr(dash + 1);
    auto digits = [](const string &value) {
      return !value.empty() && value.size() < 21 && std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isdigit(c); });
    };
    if (dash != string::npos && (a.empty() || digits(a)) && (b.empty() || digits(b)) && !(a.empty() && b.empty())) {
      partial = true;
      if (a.empty()) { const uint64_t count = std::strtoull(b.c_str(), nullptr, 10); start = count >= size ? 0 : size - count; }
      else { start = std::strtoull(a.c_str(), nullptr, 10); if (!b.empty()) end = std::strtoull(b.c_str(), nullptr, 10); }
      if (size == 0 || start >= size || start > end) {
        response.status = 416;
        response.extra += "Content-Range: bytes */" + std::to_string(size) + "\r\n";
        return response;
      }
      end = std::min(end, size - 1);
    }
  }
  response.file = absolute;
  response.length = size;
  if (partial) {
    response.status = 206;
    response.offset = start;
    response.length = end - start + 1;
    response.extra += "Content-Range: bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(size) + "\r\n";
  }
  return response;
}

static http::Response raw_put(http::Request &request, const string &relative, const string &absolute) {
  if (request.content_length > MAX_UPLOAD) return http::error(413, "file too large");
  std::lock_guard<std::mutex> guard(write_lock); // one card writer, including its incoming body
  bool was_dir = false; uint64_t before = 0;
  const bool was_there = fs::info(absolute, was_dir, before);
  if (was_there && was_dir) return http::error(409, "a folder has that name");
  const string current_etag = was_there ? etag_of(before, mtime_of(absolute)) : "";
  if (request.header("if-none-match") == "*" && was_there) return http::error(412, "file already exists");
  if (!request.header("if-match").empty() && (!was_there || request.header("if-match") != current_etag)) return http::error(412, "file changed");
  uint64_t total = 0, free = 0;
  if (!fs::space(ROOT, total, free) || free < RESERVED_FREE || static_cast<uint64_t>(request.content_length) > free - RESERVED_FREE)
    return http::error(507, "not enough free space");
  const string temporary = ROOT + "/.hub-cache/uploads/" + relative + ".tmp";
  make_dirs(dirname_of(temporary));
  const int bad = request.save_body(temporary, MAX_UPLOAD, 8192);
  if (bad) return http::error(bad, bad == 408 ? "upload stalled" : bad == 413 ? "file too large" : "could not save file");
  make_dirs(dirname_of(absolute)); // only after the complete body is on the card
  if (!sys::replace(temporary, absolute)) { ::unlink(temporary.c_str()); return http::error(500, "could not replace file"); }
  uint64_t size = 0;
  if (!fs::file_size(absolute, size)) return http::error(500, "could not read saved file");
  note_change(relative);
  http::Response response;
  response.status = was_there ? 200 : 201;
  response.body = "{\"etag\":" + json_quote(etag_of(size, mtime_of(absolute))) + ",\"size\":" + std::to_string(size) + "}";
  return response;
}

static http::Response raw_delete(const string &relative, const string &absolute) {
  std::lock_guard<std::mutex> guard(write_lock);
  bool dir = false; uint64_t size = 0;
  if (!fs::info(absolute, dir, size)) return http::error(404, "not found");
  bool ok = dir ? ::rmdir(absolute.c_str()) == 0 : ::unlink(absolute.c_str()) == 0;
  if (!ok) return http::error(dir ? 409 : 500, dir ? "folder is not empty" : "could not delete file");
  note_change(relative);
  http::Response response;
  response.body = "{\"ok\":true}";
  return response;
}

struct Json { cJSON *value; explicit Json(cJSON *v) : value(v) {} ~Json() { cJSON_Delete(value); } };
static string json_string(cJSON *object, const char *name) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(object, name);
  return cJSON_IsString(value) && value->valuestring ? value->valuestring : "";
}

static http::Response move_path(http::Request &request) {
  string body;
  const int bad = request.read_body(body, MAX_JSON);
  if (bad) return http::error(bad, bad == 408 ? "body stalled" : "body too large");
  Json json(cJSON_ParseWithLength(body.c_str(), body.size()));
  const string from = json_string(json.value, "from"), to = json_string(json.value, "to");
  Strings from_parts, to_parts;
  if (!json.value || !clean_path(from, from_parts) || !clean_path(to, to_parts)) return http::error(400, "bad path");
  string from_abs, to_abs;
  if (!safe_path(from_parts, from_abs) || !safe_path(to_parts, to_abs)) return http::error(400, "bad path");
  std::lock_guard<std::mutex> guard(write_lock);
  if (!exists(from_abs)) return http::error(404, "not found");
  if (exists(to_abs)) return http::error(409, "destination exists");
  make_dirs(dirname_of(to_abs));
  if (!sys::move(from_abs, to_abs)) return http::error(500, "could not move");
  note_change(from, to);
  http::Response response;
  response.body = "{\"ok\":true}";
  return response;
}

static http::Response password_route(http::Request &request) {
  string body;
  const int bad = request.read_body(body, MAX_JSON);
  if (bad) return http::error(bad, bad == 408 ? "body stalled" : "body too large");
  Json json(cJSON_ParseWithLength(body.c_str(), body.size()));
  const string password = json_string(json.value, "password");
  if (!json.value || password.size() < 8 || password.size() > 128) return http::error(400, "password must be 8 to 128 characters");
  std::lock_guard<std::mutex> guard(auth_lock);
  if (!password_is_set()) {
    if (!secure::same(json_string(json.value, "code"), setup_code())) { bad_setup_code(); return http::error(403, "wrong setup code"); }
  } else if (!password_matches(json_string(json.value, "old"))) {
    return http::error(403, "wrong password");
  }
  if (!set_password(password)) return http::error(500, "could not save password");
  http::Response response;
  response.status = 204;
  return response;
}

static http::Response device_route() {
  uint64_t total = 0, free = 0;
  fs::space(ROOT, total, free);
  unsigned long long changes;
  { std::lock_guard<std::mutex> guard(changes_lock); changes = change_counter; }
#ifdef ESP_PLATFORM
  const unsigned heap_free = static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
  const unsigned psram_free = static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  wifi_ap_record_t ap;
  const int rssi = esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0; // dBm: above -60 good, below -75 poor
#else
  const unsigned heap_free = 0, psram_free = 0;
  const int rssi = 0;
#endif
#ifdef HUB_VERSION
  const string version = std::to_string(HUB_VERSION);
#else
  const string version = "dev";
#endif
  http::Response response;
  response.body = "{\"store\":true,\"profile\":\"store-t3s3\",\"version\":" + json_quote(version) +
                  ",\"passwordSet\":" + (password_is_set() ? "true" : "false") + ",\"maxUpload\":" + std::to_string(MAX_UPLOAD) +
                  ",\"free\":" + std::to_string(free) + ",\"total\":" + std::to_string(total) + ",\"changes\":" + std::to_string(changes) +
                  ",\"heapFree\":" + std::to_string(heap_free) + ",\"psramFree\":" + std::to_string(psram_free) +
                  (rssi ? ",\"wifiRssi\":" + std::to_string(rssi) : string()) + "}";
  return response;
}

static http::Response changes_route(const http::Request &request) {
  unsigned long long since = 0;
  auto found = request.query.find("since");
  if (found == request.query.end() || found->second.empty() || !std::all_of(found->second.begin(), found->second.end(), [](unsigned char c) { return std::isdigit(c); }))
    return http::error(400, "bad change counter");
  since = std::strtoull(found->second.c_str(), nullptr, 10);
  std::lock_guard<std::mutex> guard(changes_lock);
  http::Response response;
  response.body = "{\"changes\":" + std::to_string(change_counter);
  if (since > change_counter || (!recent_changes.empty() && since + 1 < recent_changes.front().number)) {
    response.body += ",\"all\":true}";
    return response;
  }
  response.body += ",\"paths\":[";
  bool first = true;
  for (const Change &change : recent_changes) if (change.number > since) {
    response.body += (first ? "" : ",") + json_quote(change.first);
    first = false;
    if (!change.second.empty()) { response.body += "," + json_quote(change.second); }
  }
  response.body += "]}";
  return response;
}

static http::Response answer(http::Request &request) {
  const string &method = request.method, &path = request.path;
  // A mistyped http:// URL reaches the TLS listener as a plain request.  Send
  // a browser to the public trust page instead of serving the reader without
  // encryption.  The full server makes the same exception for this case.
  if (request.plain_on_tls) {
    http::Response response;
    response.status = 308;
    response.type = "text/plain";
    response.extra = "Location: https://" + request.header("host") + (path == "/" ? "/trust" : request.target) + "\r\n";
    response.body = "This store only speaks HTTPS.\n";
    return response;
  }
  if (method == "GET" && path == "/hub-store.crt" && !TLS_CERT.empty()) return file_response(TLS_CERT, "application/x-x509-ca-cert", false);
  if (method == "GET" && !starts_with(path, "/api/") && !starts_with(path, "/raw/")) return page_file(request);
  if (cross_site(request)) return http::error(403, "requests from other sites are not allowed");
  if (method == "GET" && path == "/api/trust" && !TLS_CERT.empty()) {
    string pem;
    if (!secure::slurp(TLS_CERT, pem)) return http::error(500, "certificate unavailable");
    http::Response response;
    response.body = "{\"fingerprint\":" + json_quote(secure::fingerprint(pem)) + ",\"encrypted\":" + (request.tls ? "true" : "false") + "}";
    return response;
  }
  if (method == "GET" && path == "/api/device") return device_route();
  if (method == "POST" && path == "/api/password" && !password_is_set()) return password_route(request);
  if (!password_matches(bearer(request))) return http::error(401, "password required");
  saw_peer(request.conn->peer);
  if (method == "POST" && path == "/api/password") return password_route(request);
  if (method == "GET" && path == "/api/list") return list_folder(request);
  if (method == "GET" && path == "/api/changes") return changes_route(request);
  if (method == "POST" && path == "/api/move") return move_path(request);
  if (starts_with(path, "/raw/")) {
    const string relative = path.substr(5);
    Strings parts;
    if (!clean_path(relative, parts)) return http::error(400, "bad path");
    string absolute;
    if (!safe_path(parts, absolute)) return http::error(400, "bad path");
    if (method == "GET") return raw_get(request, absolute, parts.back());
    if (method == "PUT") return raw_put(request, relative, absolute);
    if (method == "DELETE") return raw_delete(relative, absolute);
  }
  return http::error(404, "not found");
}

static http::Response route(http::Request &request) {
  http::Response response = answer(request);
  if (response.extra.find("Content-Security-Policy") == string::npos && response.type != "application/pdf") response.extra += CSP_DATA;
  response.extra += COMMON_HEADERS;
  response.close = true; // store clients poll; an idle connection must not occupy one of four places
  return response;
}

// A completed upload in .hub-cache/uploads is one whose destination rename
// was interrupted by loss of power.  Put it in place only when the old path is
// absent; otherwise the old complete file wins.  Then the cache can be emptied.
static void recover_uploads(const string &dir, const string &relative = "", int depth = 0) {
  if (depth > 64 || !is_dir(dir)) return;
  fs::each(dir, [&](const fs::Entry &entry) {
    const string here = dir + "/" + entry.name;
    const string rel = relative.empty() ? entry.name : relative + "/" + entry.name;
    if (entry.dir) recover_uploads(here, rel, depth + 1);
    else if (ends_with(rel, ".tmp")) {
      const string target_rel = rel.substr(0, rel.size() - 4);
      const string target = ROOT + "/" + target_rel;
      if (!exists(target)) { make_dirs(dirname_of(target)); sys::move(here, target); }
    }
  });
}

static unsigned long long initial_counter() {
  const string random = secure::random_hex(4);
  if (random.size() == 8) return std::strtoull(random.c_str(), nullptr, 16) + 1;
  return static_cast<unsigned long long>(std::chrono::steady_clock::now().time_since_epoch().count() & 0x7FFFFFFF) + 1;
}

#ifdef ESP_PLATFORM
int store_main(int argc, char **argv) {
#else
int main(int argc, char **argv) {
#endif
  string folder = ".", host = "127.0.0.1", www, cert, key;
  int port = 4321;
  bool want_tls = false;
  for (int i = 1; i < argc; ++i) {
    const string arg = argv[i];
    if (arg == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
    else if (arg == "--host" && i + 1 < argc) host = argv[++i];
    else if (arg == "--www" && i + 1 < argc) www = argv[++i];
    else if (arg == "--password" && i + 1 < argc) { desktop_password = argv[++i]; desktop_password_set = true; }
    else if (arg == "--setup-code" && i + 1 < argc) desktop_setup_code = argv[++i];
    else if (arg == "--tls") want_tls = true;
    else if (arg == "--cert" && i + 1 < argc) cert = argv[++i];
    else if (arg == "--key" && i + 1 < argc) key = argv[++i];
    else if (arg == "--help" || arg == "-h") {
      std::printf("usage: store <folder> [--www <folder>] [--host 127.0.0.1] [--port 4321] [--password <password>]\n"
                  "             [--setup-code <six digits>] [--tls --cert <pem> --key <pem>]\n");
      return 0;
    } else if (!arg.empty() && arg[0] == '-') { std::fprintf(stderr, "unknown option: %s\n", arg.c_str()); return 1; }
    else folder = arg;
  }
#ifndef ESP_PLATFORM
  if (!desktop_password_set) {
    const char *password = std::getenv("HUB_PASSWORD");
    if (password && *password) { desktop_password = password; desktop_password_set = true; }
    const char *code = std::getenv("HUB_SETUP_CODE");
    if (desktop_setup_code.empty()) desktop_setup_code = code && *code ? code : secure::random_code(6);
  }
#endif
  if (port <= 0 || port > 65535) { std::fprintf(stderr, "bad port\n"); return 1; }
  string resolved;
  if (!sys::real_path(folder, resolved) || !is_dir(resolved)) { std::fprintf(stderr, "not a folder: %s\n", folder.c_str()); return 1; }
  ROOT = resolved;
  if (www.empty()) www = is_dir(ROOT + "/www") ? ROOT + "/www" : "../hub";
  if (!sys::real_path(www, resolved) || !exists(resolved + "/index.html")) { std::fprintf(stderr, "no index.html in %s\n", www.c_str()); return 1; }
  WWW = resolved;
  recover_uploads(ROOT + "/.hub-cache/uploads");
  remove_tree(ROOT + "/.hub-cache");
  make_dirs(ROOT + "/.hub-cache/uploads");
  change_counter = initial_counter();
  if (!password_is_set()) {
    std::printf("store setup code: %s\n", setup_code().c_str());
  }
  static http::Tls tls;
  if (want_tls) {
    string error;
    if (cert.empty() || key.empty() || !tls.load(cert, key, error)) { std::fprintf(stderr, "TLS: %s\n", error.empty() ? "certificate and key required" : error.c_str()); return 1; }
    TLS_CERT = cert;
  }
  std::printf("store: %s://%s:%d (reading %s)\n", want_tls ? "https" : "http", host == "0.0.0.0" ? "localhost" : host.c_str(), port, ROOT.c_str());
  std::fflush(stdout);
  http::Options options;
  options.host = host;
  options.port = port;
  options.tls = want_tls ? &tls : nullptr;
  options.max_conns = 4;
  options.keepalive_ms = 0; // the board never holds an idle connection
  options.piece = 8192;
  options.admit = memory_for_connection;
  options.listening = [host, port, want_tls] {
    std::lock_guard<std::mutex> guard(status_lock);
    current_status.running = true;
    current_status.port = port;
    current_status.tls = want_tls;
    std::snprintf(current_status.host, sizeof current_status.host, "%s", host.c_str());
  };
  return http::serve(options, route);
}
