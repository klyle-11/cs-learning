// A small HTTP/1.1 server over POSIX sockets, with TLS from mbedTLS: one thread
// per connection, several requests per connection. It uses only calls that
// ESP-IDF also provides (lwIP sockets, pthreads, mbedTLS).
//
// Everything arriving here is untrusted, so every size and every wait has a
// limit, set before anything is allocated:
//   - 16 KB of headers; a body limit chosen per route by the handler
//   - a fixed number of connections at once; the rest are turned away
//   - a deadline for the handshake, for the headers, and for the body (which
//     grows with its size, so a slow upload is fine but a stalled one is not)
// Bodies and files are moved in pieces, never held whole in memory.
#pragma once

#include "platform.hpp"

#include <mbedtls/net_sockets.h>
#include <mbedtls/ssl.h>
#include <mbedtls/ssl_cache.h>

#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "secure.hpp"

namespace http {

using Clock = std::chrono::steady_clock;

// ---- TLS settings, shared by every connection ---------------------------------

struct Tls {
  mbedtls_ssl_config conf;
  mbedtls_x509_crt chain;
  mbedtls_pk_context key;
  mbedtls_ssl_cache_context cache;
  Tls() {
    mbedtls_ssl_config_init(&conf);
    mbedtls_x509_crt_init(&chain);
    mbedtls_pk_init(&key);
    mbedtls_ssl_cache_init(&cache);
  }
  Tls(const Tls &) = delete;
  Tls &operator=(const Tls &) = delete;
  bool load(const std::string &cert_path, const std::string &key_path, std::string &err) {
    static const char *protocols[] = {"http/1.1", nullptr};
    // Read here rather than by mbedTLS, whose file functions are not built in on the board.
    std::string cert_pem, key_pem;
    if (!secure::slurp(cert_path, cert_pem) || !secure::slurp(key_path, key_pem)) { err = "cannot read the certificate or its key"; return false; }
    int rc = secure::parse_certs(&chain, cert_pem);
    if (!rc) rc = mbedtls_pk_parse_key(&key, reinterpret_cast<const unsigned char *>(key_pem.c_str()), key_pem.size() + 1, nullptr, 0, secure::rng_cb, nullptr);
    if (!rc) rc = mbedtls_ssl_config_defaults(&conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
    if (rc) { err = secure::mbed_error(rc); return false; }
    mbedtls_ssl_conf_rng(&conf, secure::rng_cb, nullptr);
    mbedtls_ssl_conf_min_tls_version(&conf, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_authmode(&conf, MBEDTLS_SSL_VERIFY_NONE); // devices prove themselves with a token, not a certificate
    // Remembered sessions let a returning device skip most of the handshake,
    // which is the slow part on a microcontroller.
    // (The cache is shared between threads, so it needs mbedTLS built with locking.)
#if !defined(ESP_PLATFORM) || defined(MBEDTLS_THREADING_C)
    mbedtls_ssl_conf_session_cache(&conf, &cache, mbedtls_ssl_cache_get, mbedtls_ssl_cache_set);
#endif
    mbedtls_ssl_conf_alpn_protocols(&conf, protocols);
    rc = mbedtls_ssl_conf_own_cert(&conf, &chain, &key);
    if (rc) { err = secure::mbed_error(rc); return false; }
    return true;
  }
};

// ---- one connection: a socket, with or without TLS on top -------------------------

class Conn {
 public:
  int fd;
  bool local;                 // the other end is this machine itself
  bool tls = false;
  mbedtls_ssl_context ssl;
  Clock::time_point deadline; // nothing waits past this
  std::string ahead;          // bytes already read from the wire but not yet used

  Conn(int socket, bool is_local) : fd(socket), local(is_local) {
    sys::nonblocking(fd);
    within(15000);
  }
  ~Conn() {
    if (tls) {
      within(500);
      mbedtls_ssl_close_notify(&ssl);
      mbedtls_ssl_free(&ssl);
    }
    sys::close_socket(fd);
  }
  Conn(const Conn &) = delete;
  Conn &operator=(const Conn &) = delete;

  void within(long ms) { deadline = Clock::now() + std::chrono::milliseconds(ms); }

  // Start TLS. False if the other side does not finish the handshake in time.
  bool handshake(Tls &settings, long ms) {
    mbedtls_ssl_init(&ssl);
    tls = true;
    if (mbedtls_ssl_setup(&ssl, &settings.conf) != 0) return false;
    mbedtls_ssl_set_bio(&ssl, this, bio_send, bio_recv, nullptr);
    within(ms);
    for (;;) {
      int rc = mbedtls_ssl_handshake(&ssl);
      if (rc == 0) return true;
      if (rc != MBEDTLS_ERR_SSL_WANT_READ && rc != MBEDTLS_ERR_SSL_WANT_WRITE) return false;
    }
  }

  // The first byte the client sent, without consuming it (-1 if none came).
  int peek() {
    unsigned char b;
    for (;;) {
      long n = sys::receive(fd, &b, 1, true);
      if (n == 1) return b;
      if (n == 0) return -1;
      sys::Why why = sys::why();
      if (why == sys::Why::failed) return -1;
      if (why == sys::Why::again && !wait(true)) return -1;
    }
  }

  // Up to `len` bytes. 0 when the other side has closed, negative on error or deadline.
  long read(char *out, size_t len) {
    if (!ahead.empty()) {
      size_t n = std::min(len, ahead.size());
      std::memcpy(out, ahead.data(), n);
      ahead.erase(0, n);
      return static_cast<long>(n);
    }
    if (!tls) return raw_recv(reinterpret_cast<unsigned char *>(out), len);
    for (;;) {
      int rc = mbedtls_ssl_read(&ssl, reinterpret_cast<unsigned char *>(out), len);
      if (rc >= 0) return rc;
      if (rc == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) return 0;
      if (rc != MBEDTLS_ERR_SSL_WANT_READ && rc != MBEDTLS_ERR_SSL_WANT_WRITE && rc != MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) return -1;
    }
  }

  bool write_all(const char *data, size_t len) {
    while (len > 0) {
      long n;
      if (!tls) n = raw_send(reinterpret_cast<const unsigned char *>(data), len);
      else {
        n = mbedtls_ssl_write(&ssl, reinterpret_cast<const unsigned char *>(data), len);
        if (n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
      }
      if (n <= 0) return false;
      data += n;
      len -= static_cast<size_t>(n);
    }
    return true;
  }
  bool write_all(const std::string &s) { return write_all(s.data(), s.size()); }

 private:
  bool wait(bool to_read) {
    auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (left <= 0) return false;
    return sys::wait_ready(fd, to_read, static_cast<int>(std::min<long long>(left, 60000)));
  }
  long raw_recv(unsigned char *out, size_t len) {
    for (;;) {
      long n = sys::receive(fd, out, len);
      if (n >= 0) return n;
      sys::Why why = sys::why();
      if (why == sys::Why::interrupted) continue;
      if (why == sys::Why::failed) return -1;
      if (!wait(true)) return -2;
    }
  }
  long raw_send(const unsigned char *data, size_t len) {
    for (;;) {
      long n = sys::send_some(fd, data, len);
      if (n >= 0) return n;
      sys::Why why = sys::why();
      if (why == sys::Why::interrupted) continue;
      if (why == sys::Why::failed) return -1;
      if (!wait(false)) return -2;
    }
  }
  static int bio_send(void *self, const unsigned char *data, size_t len) {
    long n = static_cast<Conn *>(self)->raw_send(data, len);
    return n >= 0 ? static_cast<int>(n) : n == -2 ? MBEDTLS_ERR_SSL_TIMEOUT : MBEDTLS_ERR_NET_SEND_FAILED;
  }
  static int bio_recv(void *self, unsigned char *out, size_t len) {
    long n = static_cast<Conn *>(self)->raw_recv(out, len);
    return n > 0 ? static_cast<int>(n) : n == 0 ? MBEDTLS_ERR_NET_CONN_RESET : n == -2 ? MBEDTLS_ERR_SSL_TIMEOUT : MBEDTLS_ERR_NET_RECV_FAILED;
  }
};

// ---- requests and responses ---------------------------------------------------------

struct Request {
  std::string method, path;                   // path is already percent-decoded
  std::string target;                         // as sent, with its query
  std::map<std::string, std::string> query;   // decoded
  std::map<std::string, std::string> headers; // names lower-cased
  std::shared_ptr<Conn> conn;
  size_t content_length = 0, body_left = 0;
  bool local = false;   // sent from this machine
  bool tls = false;     // arrived encrypted
  bool plain_on_tls = false; // sent unencrypted to a port that expects TLS

  const std::string &header(const char *name) const {
    static const std::string none;
    auto it = headers.find(name);
    return it == headers.end() ? none : it->second;
  }
  // How long a body of this size may take: half a minute, plus its size at 32 KB a second.
  void body_deadline() const { conn->within(30000 + static_cast<long>(content_length / 32)); }

  // The body as a string. Returns 0, or the status to answer with.
  int read_body(std::string &out, size_t max) {
    if (content_length > max) return 413;
    body_deadline();
    out.clear();
    out.reserve(body_left);
    char chunk[4096];
    while (body_left > 0) {
      long n = conn->read(chunk, std::min(sizeof chunk, body_left));
      if (n <= 0) return 408;
      out.append(chunk, static_cast<size_t>(n));
      body_left -= static_cast<size_t>(n);
    }
    return 0;
  }
  // The body written straight to a file, a piece at a time.
  int save_body(const std::string &file, size_t max, size_t piece) {
    if (content_length > max) return 413;
    body_deadline();
    FILE *f = std::fopen(file.c_str(), "wb");
    if (!f) return 500;
    std::vector<char> chunk(piece);
    int status = 0;
    while (body_left > 0 && !status) {
      long n = conn->read(chunk.data(), std::min(chunk.size(), body_left));
      if (n <= 0) status = 408;
      else if (std::fwrite(chunk.data(), 1, static_cast<size_t>(n), f) != static_cast<size_t>(n)) status = 507;
      else body_left -= static_cast<size_t>(n);
    }
    if (std::fclose(f) != 0 && !status) status = 507;
    if (status) ::unlink(file.c_str());
    return status;
  }
  // Read the body and throw it away, so the answer is not lost on a client that is still sending.
  bool discard_body(size_t max) {
    if (body_left > max) return false;
    body_deadline();
    char chunk[4096];
    while (body_left > 0) {
      long n = conn->read(chunk, std::min(sizeof chunk, body_left));
      if (n <= 0) return false;
      body_left -= static_cast<size_t>(n);
    }
    return true;
  }
};

struct Response {
  int status = 200;
  std::string type = "application/json";
  std::string body;
  std::string extra;  // further header lines, each ending in \r\n
  // When `file` is set the body is that file's bytes [offset, offset + length), sent in pieces.
  std::string file;
  unsigned long long offset = 0, length = 0;
  std::string etag;   // set for the page's own files: the browser may keep them and ask "still this one?"
  bool hold = false;  // the handler wrote its own response and keeps the connection (event stream)
  bool close = false; // do not reuse the connection after this
};

using Handler = std::function<Response(Request &)>;

struct Options {
  std::string host = "127.0.0.1";
  int port = 4321;
  Tls *tls = nullptr;
  int max_conns = 64;      // connections served at once
  long keepalive_ms = 5000; // how long an idle connection is kept for its next request
  size_t piece = 16384;    // bytes moved at a time when sending a file
};

inline const char *reason(int status) {
  switch (status) {
    case 200: return "OK";
    case 204: return "No Content";
    case 206: return "Partial Content";
    case 304: return "Not Modified";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 408: return "Request Timeout";
    case 413: return "Payload Too Large";
    case 416: return "Range Not Satisfiable";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    case 507: return "Insufficient Storage";
    default: return status >= 500 ? "Internal Server Error" : "Error";
  }
}

inline std::string url_decode(const std::string &in, bool plus_is_space) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); i++) {
    if (in[i] == '%' && i + 2 < in.size() && std::isxdigit(static_cast<unsigned char>(in[i + 1])) &&
        std::isxdigit(static_cast<unsigned char>(in[i + 2]))) {
      out += static_cast<char>(std::strtol(in.substr(i + 1, 2).c_str(), nullptr, 16));
      i += 2;
    } else if (in[i] == '+' && plus_is_space) {
      out += ' ';
    } else {
      out += in[i];
    }
  }
  return out;
}

inline Response error(int status, const std::string &message) {
  Response r;
  r.status = status;
  r.body = "{\"error\":\"" + message + "\"}"; // messages are fixed strings chosen by the server
  return r;
}

// Send a response. Returns false if the connection can no longer be used.
inline bool write_response(Conn &conn, const Response &r, bool keep, size_t piece) {
  const unsigned long long length = r.file.empty() ? r.body.size() : r.length;
  std::string head = "HTTP/1.1 " + std::to_string(r.status) + " " + reason(r.status) + "\r\n";
  bool text = r.type.compare(0, 5, "text/") == 0 || r.type.find("javascript") != std::string::npos || r.type.find("json") != std::string::npos;
  head += "Content-Type: " + r.type + (text ? "; charset=utf-8" : "") + "\r\n";
  head += r.extra;
  head += "Content-Length: " + std::to_string(length) + "\r\n";
  if (!r.etag.empty()) head += "ETag: " + r.etag + "\r\n";
  // Kept by the browser only where it can ask whether its copy is still current; everything else, never.
  head += std::string(r.etag.empty() ? "Cache-Control: no-store" : "Cache-Control: no-cache") + "\r\nConnection: " + (keep ? "keep-alive" : "close") + "\r\n\r\n";
  conn.within(30000 + static_cast<long>(length / 8)); // at least 8 KB a second
  if (!conn.write_all(head)) return false;
  if (r.file.empty()) return conn.write_all(r.body);
  FILE *f = std::fopen(r.file.c_str(), "rb");
  bool ok = f && sys::seek(f, r.offset);
  std::vector<char> chunk(piece);
  unsigned long long left = r.length;
  while (ok && left > 0) {
    size_t n = std::fread(chunk.data(), 1, static_cast<size_t>(std::min<unsigned long long>(chunk.size(), left)), f);
    if (n == 0) ok = false; // the file shrank after its size was announced
    else { ok = conn.write_all(chunk.data(), n); left -= n; }
  }
  if (f) std::fclose(f);
  return ok && left == 0;
}

// Read and parse the head of one request (the body stays on the wire for the
// handler). Returns 0, a status to answer with, or -1 if the client went away.
inline int read_head(const std::shared_ptr<Conn> &conn, Request &req) {
  static const size_t MAX_HEAD = 16 * 1024;
  std::string &buf = conn->ahead;
  char chunk[2048];
  size_t head_end = buf.find("\r\n\r\n");
  while (head_end == std::string::npos) {
    if (buf.size() > MAX_HEAD) return 431;
    std::string kept;
    kept.swap(buf); // read() hands out `ahead` first, so take it aside while reading more
    long n = conn->read(chunk, sizeof chunk);
    buf.swap(kept);
    if (n <= 0) return buf.empty() ? -1 : 408;
    buf.append(chunk, static_cast<size_t>(n));
    head_end = buf.find("\r\n\r\n");
  }
  if (head_end > MAX_HEAD) return 431;
  std::string head = buf.substr(0, head_end);
  buf.erase(0, head_end + 4);

  // Request line: METHOD SP target SP version
  size_t line_end = head.find("\r\n");
  std::string line = head.substr(0, line_end);
  size_t a = line.find(' '), b = line.rfind(' ');
  if (a == std::string::npos || b == a) return 400;
  req.method = line.substr(0, a);
  req.target = line.substr(a + 1, b - a - 1);
  size_t q = req.target.find('?');
  req.path = url_decode(req.target.substr(0, q), false);
  if (req.path.empty() || req.path[0] != '/' || req.path.find('\0') != std::string::npos) return 400;
  if (q != std::string::npos) {
    std::string qs = req.target.substr(q + 1);
    size_t pos = 0;
    while (pos <= qs.size()) {
      size_t amp = qs.find('&', pos);
      if (amp == std::string::npos) amp = qs.size();
      std::string pair = qs.substr(pos, amp - pos);
      size_t eq = pair.find('=');
      if (!pair.empty()) req.query[url_decode(pair.substr(0, eq), true)] = eq == std::string::npos ? "" : url_decode(pair.substr(eq + 1), true);
      pos = amp + 1;
    }
  }

  // Headers
  size_t pos = line_end == std::string::npos ? head.size() : line_end + 2;
  while (pos < head.size()) {
    size_t eol = head.find("\r\n", pos);
    if (eol == std::string::npos) eol = head.size();
    std::string h = head.substr(pos, eol - pos);
    size_t colon = h.find(':');
    if (colon != std::string::npos) {
      std::string name = h.substr(0, colon), value = h.substr(colon + 1);
      for (char &c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      size_t s = value.find_first_not_of(" \t");
      req.headers[name] = s == std::string::npos ? "" : value.substr(s);
    }
    pos = eol + 2;
  }

  // Body, by Content-Length only (no chunked uploads).
  auto cl = req.headers.find("content-length");
  if (cl != req.headers.end()) {
    char *end = nullptr;
    unsigned long long v = std::strtoull(cl->second.c_str(), &end, 10);
    if (end == cl->second.c_str() || *end != '\0' || !std::isdigit(static_cast<unsigned char>(cl->second[0]))) return 400;
    req.content_length = req.body_left = static_cast<size_t>(v);
  } else if (req.headers.count("transfer-encoding")) {
    return 400;
  }
  req.conn = conn;
  req.local = conn->local;
  req.tls = conn->tls;
  return 0;
}

inline std::atomic<int> &active() { static std::atomic<int> n{0}; return n; }

inline void handle_connection(std::shared_ptr<Conn> conn, const Handler &handler, const Options &opt) {
  bool plain_on_tls = false;
  if (opt.tls) {
    // TLS records start with byte 22. Anything else is someone who typed
    // http://: answer in plain text so they can be pointed at https://.
    conn->within(10000);
    int first = conn->peek();
    if (first < 0) return;
    if (first == 22) { if (!conn->handshake(*opt.tls, 10000)) return; }
    else plain_on_tls = true;
  }
  for (int served = 0; served < 1000; served++) {
    conn->within(served == 0 ? 15000 : opt.keepalive_ms);
    if (!conn->ahead.empty() || conn->tls || served == 0 || conn->peek() >= 0) conn->within(15000); // the headers get 15 s in all
    else return;
    Request req;
    int bad = read_head(conn, req);
    if (bad < 0) return;
    if (bad) {
      const char *why = bad == 431 ? "headers too large" : bad == 408 ? "too slow" : "bad request";
      write_response(*conn, error(bad, why), false, opt.piece);
      return;
    }
    req.plain_on_tls = plain_on_tls;
    Response res;
    try {
      res = handler(req);
    } catch (const std::bad_alloc &) {
      res = error(503, "out of memory");
      res.close = true;
    } catch (...) {
      res = error(500, "server error");
      res.close = true;
    }
    if (res.hold) return; // the handler keeps its own reference to the connection
    // A body the handler did not read would be taken for the next request.
    if (req.body_left > 0 && !req.discard_body(64 * 1024)) res.close = true;
    const std::string &want = req.header("connection");
    bool keep = !res.close && !plain_on_tls && want != "close" && active().load() * 4 < opt.max_conns * 3;
    if (!write_response(*conn, res, keep, opt.piece) || !keep) return;
  }
}

// Listen and serve until the process ends. Returns non-zero if it cannot start.
inline int serve(const Options &opt, Handler handler) {
  if (!sys::net_start()) { std::fprintf(stderr, "the network could not be started\n"); return 1; }
  int srv = sys::tcp_socket();
  if (srv < 0) { std::fprintf(stderr, "no socket to be had\n"); return 1; }
#ifndef _WIN32
  sys::set_option(srv, SOL_SOCKET, SO_REUSEADDR);   // on Windows this option would let a second server take the port
#endif
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(opt.port));
  if (::inet_pton(AF_INET, opt.host.c_str(), &addr.sin_addr) != 1) { std::fprintf(stderr, "bad host address: %s\n", opt.host.c_str()); return 1; }
  if (!sys::bind_and_listen(srv, addr, 16)) { std::fprintf(stderr, "port %d is in use, or may not be used\n", opt.port); return 1; }
  for (;;) {
    sockaddr_in peer{};
    int fd = sys::accept_from(srv, peer);
    if (fd < 0) continue;
#ifdef SO_NOSIGPIPE
    sys::set_option(fd, SOL_SOCKET, SO_NOSIGPIPE);
#endif
    sys::set_option(fd, IPPROTO_TCP, TCP_NODELAY);
    // Full: turn the newcomer away rather than start a thread for it.
    if (active().load() >= opt.max_conns) { sys::close_socket(fd); continue; }
    bool local = (ntohl(peer.sin_addr.s_addr) >> 24) == 127;
    active()++;
    try {
      std::thread([fd, local, handler, opt] {
        // Nothing that goes wrong with one connection may end the process.
        try { handle_connection(std::make_shared<Conn>(fd, local), handler, opt); } catch (...) {}
        active()--;
      }).detach();
    } catch (...) { // no thread to be had
      active()--;
      sys::close_socket(fd);
    }
  }
}

} // namespace http
