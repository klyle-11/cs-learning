// A small HTTP/1.1 server over POSIX sockets: one thread per connection, one
// request per connection. It uses only calls that ESP-IDF also provides (lwIP
// sockets), but on the board the plan is to put Espressif's own HTTP server in
// front of the same handlers instead of this file.
//
// Everything arriving here is untrusted, so sizes are capped before anything is
// allocated: 16 KB of headers, and a body limit chosen per route by the caller.
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cctype>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <thread>

namespace http {

struct Request {
  std::string method, path;                   // path is already percent-decoded
  std::map<std::string, std::string> query;   // decoded
  std::map<std::string, std::string> headers; // names lower-cased
  std::string body;
  int fd = -1;
};

struct Response {
  int status = 200;
  std::string type = "application/json";
  std::string body;
  bool hold = false; // the handler wrote its own response and keeps the socket (event stream)
};

using Handler = std::function<Response(Request &)>;
using BodyLimit = std::function<size_t(const std::string &path)>;

inline const char *reason(int status) {
  switch (status) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 413: return "Payload Too Large";
    case 431: return "Request Header Fields Too Large";
    case 501: return "Not Implemented";
    default: return status >= 500 ? "Internal Server Error" : "Error";
  }
}

inline bool send_all(int fd, const char *data, size_t len) {
  while (len > 0) {
    ssize_t n = ::send(fd, data, len, 0);
    if (n <= 0) return false;
    data += n;
    len -= static_cast<size_t>(n);
  }
  return true;
}
inline bool send_all(int fd, const std::string &s) { return send_all(fd, s.data(), s.size()); }

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

inline void write_response(int fd, const Response &r) {
  std::string head = "HTTP/1.1 " + std::to_string(r.status) + " " + reason(r.status) + "\r\n";
  head += "Content-Type: " + r.type + "; charset=utf-8\r\n";
  head += "Content-Length: " + std::to_string(r.body.size()) + "\r\n";
  head += "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
  if (send_all(fd, head)) send_all(fd, r.body);
}

inline Response error(int status, const std::string &message) {
  Response r;
  r.status = status;
  r.body = "{\"error\":\"" + message + "\"}"; // messages are fixed strings chosen by the server
  return r;
}

// Read and parse one request. Returns false (after answering, where it can) if
// the request is malformed, too large, or the client went quiet.
inline bool read_request(int fd, Request &req, const BodyLimit &limit) {
  static const size_t MAX_HEAD = 16 * 1024;
  std::string buf;
  char chunk[4096];
  size_t head_end = std::string::npos;
  while (head_end == std::string::npos) {
    ssize_t n = ::recv(fd, chunk, sizeof chunk, 0);
    if (n <= 0) return false;
    buf.append(chunk, static_cast<size_t>(n));
    head_end = buf.find("\r\n\r\n");
    if (head_end == std::string::npos && buf.size() > MAX_HEAD) { write_response(fd, error(431, "headers too large")); return false; }
  }
  if (head_end > MAX_HEAD) { write_response(fd, error(431, "headers too large")); return false; }

  // Request line: METHOD SP target SP version
  size_t line_end = buf.find("\r\n");
  std::string line = buf.substr(0, line_end);
  size_t a = line.find(' '), b = line.rfind(' ');
  if (a == std::string::npos || b == a) { write_response(fd, error(400, "bad request line")); return false; }
  req.method = line.substr(0, a);
  std::string target = line.substr(a + 1, b - a - 1);
  size_t q = target.find('?');
  req.path = url_decode(target.substr(0, q), false);
  if (req.path.empty() || req.path[0] != '/' || req.path.find('\0') != std::string::npos) { write_response(fd, error(400, "bad path")); return false; }
  if (q != std::string::npos) {
    std::string qs = target.substr(q + 1);
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
  size_t pos = line_end + 2;
  while (pos < head_end) {
    size_t eol = buf.find("\r\n", pos);
    std::string h = buf.substr(pos, eol - pos);
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
  size_t want = 0;
  auto cl = req.headers.find("content-length");
  if (cl != req.headers.end()) {
    char *end = nullptr;
    unsigned long long v = std::strtoull(cl->second.c_str(), &end, 10);
    if (end == cl->second.c_str() || *end != '\0') { write_response(fd, error(400, "bad content-length")); return false; }
    if (v > limit(req.path)) { write_response(fd, error(413, "body too large")); return false; }
    want = static_cast<size_t>(v);
  } else if (req.headers.count("transfer-encoding")) {
    write_response(fd, error(400, "chunked bodies are not supported"));
    return false;
  }
  req.body = buf.substr(head_end + 4);
  if (req.body.size() > want) req.body.resize(want);
  req.body.reserve(want);
  while (req.body.size() < want) {
    ssize_t n = ::recv(fd, chunk, std::min(sizeof chunk, want - req.body.size()), 0);
    if (n <= 0) return false;
    req.body.append(chunk, static_cast<size_t>(n));
  }
  req.fd = fd;
  return true;
}

inline void handle_connection(int fd, Handler handler, BodyLimit limit) {
  timeval tv{15, 0}; // a silent client is dropped
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  Request req;
  if (read_request(fd, req, limit)) {
    Response res = handler(req);
    if (res.hold) return; // the handler owns the socket now
    write_response(fd, res);
  }
  ::close(fd);
}

// Listen and serve until the process ends. Returns non-zero if it cannot start.
inline int serve(const std::string &host, int port, Handler handler, BodyLimit limit) {
  std::signal(SIGPIPE, SIG_IGN);
  int srv = ::socket(AF_INET, SOCK_STREAM, 0);
  if (srv < 0) { std::perror("socket"); return 1; }
  int yes = 1;
  ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (::inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) { std::fprintf(stderr, "bad host address: %s\n", host.c_str()); return 1; }
  if (::bind(srv, reinterpret_cast<sockaddr *>(&addr), sizeof addr) < 0) { std::perror("bind"); return 1; }
  if (::listen(srv, 16) < 0) { std::perror("listen"); return 1; }
  for (;;) {
    int fd = ::accept(srv, nullptr, nullptr);
    if (fd < 0) continue;
    std::thread(handle_connection, fd, handler, limit).detach();
  }
}

} // namespace http
