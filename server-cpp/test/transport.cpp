// Real loopback sockets exercise the receive callback registered with mbedTLS.
// Run against the same platform and TLS libraries as hubd-own.
#include "../src/http.hpp"
#include <cassert>

struct Pair {
  int server, client;
  Pair() {
    int listener = sys::tcp_socket();
    assert(listener >= 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(sys::bind_and_listen(listener, address, 1));
    socklen_t size = sizeof address;
    assert(getsockname(listener, reinterpret_cast<sockaddr *>(&address), &size) == 0);
    client = sys::tcp_socket();
    assert(connect(client, reinterpret_cast<sockaddr *>(&address), sizeof address) == 0);
    sockaddr_in peer{};
    server = sys::accept_from(listener, peer);
    assert(server >= 0);
    sys::close_socket(listener);
  }
  ~Pair() { if (client >= 0) sys::close_socket(client); }
  void close_peer() { sys::close_socket(client); client = -1; }
};

int main() {
  assert(sys::net_start());
  http::Tls settings;
  assert(mbedtls_ssl_config_defaults(&settings.conf, MBEDTLS_SSL_IS_SERVER,
         MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT) == 0);
  mbedtls_ssl_conf_rng(&settings.conf, secure::rng_cb, nullptr);
  auto receive = [](http::Conn &conn, unsigned char *out, size_t size) {
    return conn.ssl.MBEDTLS_PRIVATE(f_recv)(conn.ssl.MBEDTLS_PRIVATE(p_bio), out, size);
  };
  unsigned char byte = 0;
  {
    Pair pair;
    http::Conn conn(pair.server, true, "127.0.0.1");
    assert(!conn.handshake(settings, 0)); // install the real callbacks; no client hello
    conn.within(1000);
    assert(sys::send_some(pair.client, "x", 1) == 1);
    assert(receive(conn, &byte, 1) == 1 && byte == 'x');
    pair.close_peer();
    assert(receive(conn, &byte, 1) == 0); // FIN must never become NET_CONN_RESET
    assert(conn.transport_error == 0 && std::string(conn.transport) == "eof");
    assert(conn.received_bytes == 1);
  }
  {
    Pair pair;
    http::Conn conn(pair.server, true, "127.0.0.1");
    assert(!conn.handshake(settings, 0));
    conn.within(0);
    assert(receive(conn, &byte, 1) == MBEDTLS_ERR_SSL_TIMEOUT);
    assert(conn.transport_error == 0);
    linger reset{1, 0};
    assert(setsockopt(pair.client, SOL_SOCKET, SO_LINGER,
                     reinterpret_cast<const char *>(&reset), sizeof reset) == 0);
    pair.close_peer();
    conn.within(1000);
    assert(receive(conn, &byte, 1) == MBEDTLS_ERR_NET_CONN_RESET);
    assert(sys::socket_reset(conn.transport_error));
  }
  {
    Pair pair;
    auto conn = std::make_shared<http::Conn>(pair.server, true, "127.0.0.1");
    pair.close_peer();
    http::Request request;
    request.conn = conn;
    request.content_length = request.body_left = 10;
    std::string body;
    assert(request.read_body(body, 100) == 408); // incomplete uploads remain rejected
  }
  std::puts("Transport: bytes, TCP EOF, deadline, reset and truncated body passed");
}
