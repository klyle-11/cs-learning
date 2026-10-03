// Cryptography for the hub, all of it from mbedTLS (the library ESP-IDF ships,
// so the same code runs on the board): random bytes, SHA-256, and the hub's own
// certificates.
//
// Certificates: the hub is its own small certificate authority, in two steps.
//
//   ca.pem      the authority a device installs, once. Its private key is used
//               one time, to sign the issuer below, and is never written down.
//   issuer.pem  the only thing the authority ever signed. It may vouch for this
//               hub's own names and for addresses on a home network, and for
//               nothing else: the certificate says so (name constraints), and
//               every browser enforces it. Its key stays here (issuer-key.pem).
//   cert.pem    what the server presents: signed by the issuer, re-issued
//               whenever the machine's addresses change or it nears its end.
//
// So a device that trusts this authority trusts the hub and only the hub.
// Whoever copies the state folder gets a key that can pretend to be the hub,
// not one that can pretend to be a bank.
#pragma once

#include <mbedtls/ctr_drbg.h>
#include <mbedtls/ecp.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/oid.h>
#include <mbedtls/pem.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include <mbedtls/x509_crt.h>
#include <psa/crypto.h>

#include "platform.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace secure {

using std::string;

// ---- random bytes -------------------------------------------------------------

struct Rng {
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context drbg;
  std::mutex lock;
  bool ok = false;
  Rng() {
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&drbg);
    static const unsigned char tag[] = "hubd";
    ok = mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy, tag, sizeof tag) == 0;
    psa_crypto_init(); // TLS 1.3 in mbedTLS runs on the PSA layer
  }
};
inline Rng &rng() { static Rng r; return r; }
// The callback shape mbedTLS wants.
inline int rng_cb(void *, unsigned char *out, size_t len) {
  Rng &r = rng();
  std::lock_guard<std::mutex> g(r.lock);
  return r.ok ? mbedtls_ctr_drbg_random(&r.drbg, out, len) : MBEDTLS_ERR_CTR_DRBG_ENTROPY_SOURCE_FAILED;
}
inline bool random_bytes(unsigned char *out, size_t len) { return rng_cb(nullptr, out, len) == 0; }

// ---- encodings ------------------------------------------------------------------

inline string hex(const unsigned char *data, size_t len) {
  static const char d[] = "0123456789abcdef";
  string out;
  for (size_t i = 0; i < len; i++) { out += d[data[i] >> 4]; out += d[data[i] & 15]; }
  return out;
}
inline string base64url(const unsigned char *data, size_t len) {
  static const char d[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  string out;
  for (size_t i = 0; i < len; i += 3) {
    unsigned v = static_cast<unsigned>(data[i]) << 16 | (i + 1 < len ? static_cast<unsigned>(data[i + 1]) << 8 : 0u) | (i + 2 < len ? data[i + 2] : 0u);
    out += d[v >> 18 & 63];
    out += d[v >> 12 & 63];
    if (i + 1 < len) out += d[v >> 6 & 63];
    if (i + 2 < len) out += d[v & 63];
  }
  return out;
}
inline string sha256_hex(const string &s) {
  unsigned char out[32];
  mbedtls_sha256(reinterpret_cast<const unsigned char *>(s.data()), s.size(), out, 0);
  return hex(out, sizeof out);
}
// Compare without stopping at the first difference, so timing says nothing
// about how much of a secret was right.
inline bool same(const string &a, const string &b) {
  unsigned char diff = static_cast<unsigned char>(a.size() != b.size());
  for (size_t i = 0; i < a.size() && i < b.size(); i++) diff = static_cast<unsigned char>(diff | (a[i] ^ b[i]));
  return diff == 0;
}
inline string random_token(size_t bytes) {
  std::vector<unsigned char> b(bytes);
  if (!random_bytes(b.data(), bytes)) return "";
  return base64url(b.data(), bytes);
}
inline string random_hex(size_t bytes) {
  std::vector<unsigned char> b(bytes);
  if (!random_bytes(b.data(), bytes)) return "";
  return hex(b.data(), bytes);
}
// A code a person reads off one screen and types on another: no 0/O or 1/I.
inline string random_code(size_t chars) {
  static const char d[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  std::vector<unsigned char> b(chars);
  if (!random_bytes(b.data(), chars)) return "";
  string out;
  for (unsigned char c : b) out += d[c & 31];
  return out;
}

// ---- small file helpers (secrets are written readable by the owner only) ------------

inline bool slurp(const string &path, string &out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}
// Put `tmp` in place of `path`. On a computer that is one step that cannot be
// half done. The FAT filesystem on the board's card cannot rename onto an
// existing file, so there the old one is removed first.
inline bool replace(const string &tmp, const string &path) { return sys::replace(tmp, path); }
inline bool spit(const string &path, const string &data, int mode) {
  string tmp = path + ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f.write(data.data(), static_cast<std::streamsize>(data.size()));
    if (!f) return false;
  }
  sys::owner_only(tmp, mode);
  return replace(tmp, path);
}

// ---- certificates -------------------------------------------------------------------

inline string mbed_error(int code) {
  char buf[160];
  mbedtls_strerror(code, buf, sizeof buf);
  return buf;
}

// Read certificates from PEM text. mbedTLS does not check name constraints
// itself and so refuses a certificate that carries them; the hub only reads
// its own certificates here (to present them, and to read their dates and
// fingerprints), so that one extension is let through.
inline int allow_name_constraints(void *, mbedtls_x509_crt const *, mbedtls_x509_buf const *oid, int, const unsigned char *, const unsigned char *) {
  return oid->len == MBEDTLS_OID_SIZE(MBEDTLS_OID_NAME_CONSTRAINTS) && std::memcmp(oid->p, MBEDTLS_OID_NAME_CONSTRAINTS, oid->len) == 0 ? 0 : -1;
}
inline int parse_certs(mbedtls_x509_crt *out, const string &pem) {
  static const char *begin = "-----BEGIN CERTIFICATE-----", *end = "-----END CERTIFICATE-----";
  const char *at = pem.c_str();
  int found = 0;
  while ((at = std::strstr(at, begin)) != nullptr) {
    mbedtls_pem_context ctx;
    mbedtls_pem_init(&ctx);
    size_t used = 0, len = 0;
    int rc = mbedtls_pem_read_buffer(&ctx, begin, end, reinterpret_cast<const unsigned char *>(at), nullptr, 0, &used);
    if (rc == 0) {
      const unsigned char *der = mbedtls_pem_get_buffer(&ctx, &len);
      rc = mbedtls_x509_crt_parse_der_with_ext_cb(out, der, len, 1, allow_name_constraints, nullptr);
    }
    mbedtls_pem_free(&ctx);
    if (rc != 0) return rc;
    found++;
    at += used ? used : 1;
  }
  return found ? 0 : MBEDTLS_ERR_X509_INVALID_FORMAT;
}

// ---- what the hub's authority may vouch for ---------------------------------------------
// Names: anything under ".local", "localhost", and this machine's own names.
// Addresses: the ranges set aside for private networks, which no website has.
struct Net { unsigned char addr[4]; int bits; };
static const Net HOME_NETS[] = {{{127, 0, 0, 0}, 8}, {{10, 0, 0, 0}, 8}, {{172, 16, 0, 0}, 12}, {{192, 168, 0, 0}, 16}, {{169, 254, 0, 0}, 16}, {{100, 64, 0, 0}, 10}};

inline bool home_address(const string &name) {
  in_addr ip{};
  if (::inet_pton(AF_INET, name.c_str(), &ip) != 1) return false;
  const uint32_t a = ntohl(ip.s_addr);
  for (const Net &n : HOME_NETS) {
    const uint32_t base = static_cast<uint32_t>(n.addr[0]) << 24 | static_cast<uint32_t>(n.addr[1]) << 16 | static_cast<uint32_t>(n.addr[2]) << 8 | n.addr[3];
    const uint32_t mask = ~uint32_t{0} << (32 - n.bits);
    if ((a & mask) == base) return true;
  }
  return false;
}
inline bool is_address(const string &name) { in_addr ip{}; return ::inet_pton(AF_INET, name.c_str(), &ip) == 1; }
// Whether `name` is `zone` itself or a name under it.
inline bool under(const string &name, const string &zone) {
  return name == zone || (name.size() > zone.size() && name.compare(name.size() - zone.size(), zone.size(), zone) == 0 && name[name.size() - zone.size() - 1] == '.');
}
// The name zones an authority made for these names is limited to.
inline std::vector<string> zones_for(const std::vector<string> &names) {
  std::vector<string> zones = {"local", "localhost"};
  for (const string &n : names) {
    if (is_address(n) || n.find(':') != string::npos) continue;
    if (!std::any_of(zones.begin(), zones.end(), [&](const string &z) { return under(n, z); })) zones.push_back(n);
  }
  return zones;
}
inline bool in_scope(const string &name, const std::vector<string> &zones) {
  if (is_address(name)) return home_address(name);
  return std::any_of(zones.begin(), zones.end(), [&](const string &z) { return under(name, z); });
}

// The "name constraints" extension, written out by hand (mbedTLS has no call
// for it). In DER every value is a tag, a length, then the contents:
//   NameConstraints  ::= SEQUENCE { permittedSubtrees [0] SEQUENCE OF GeneralSubtree }
//   GeneralSubtree   ::= SEQUENCE { base GeneralName }
//   GeneralName      ::= dNSName [2] text  |  iPAddress [7] address then mask
inline std::vector<unsigned char> der(unsigned char tag, const std::vector<unsigned char> &body) {
  std::vector<unsigned char> out{tag};
  if (body.size() < 128) out.push_back(static_cast<unsigned char>(body.size()));
  else if (body.size() < 256) { out.push_back(0x81); out.push_back(static_cast<unsigned char>(body.size())); }
  else { out.push_back(0x82); out.push_back(static_cast<unsigned char>(body.size() >> 8)); out.push_back(static_cast<unsigned char>(body.size() & 0xff)); }
  out.insert(out.end(), body.begin(), body.end());
  return out;
}
inline std::vector<unsigned char> name_constraints(const std::vector<string> &zones) {
  std::vector<unsigned char> subtrees;
  auto add = [&](unsigned char tag, const std::vector<unsigned char> &base) {
    const std::vector<unsigned char> tree = der(0x30, der(tag, base));
    subtrees.insert(subtrees.end(), tree.begin(), tree.end());
  };
  for (const string &z : zones) add(0x82, std::vector<unsigned char>(z.begin(), z.end()));
  for (const Net &n : HOME_NETS) {
    const uint32_t mask = ~uint32_t{0} << (32 - n.bits);
    add(0x87, {n.addr[0], n.addr[1], n.addr[2], n.addr[3],
               static_cast<unsigned char>(mask >> 24), static_cast<unsigned char>(mask >> 16 & 0xff), static_cast<unsigned char>(mask >> 8 & 0xff), static_cast<unsigned char>(mask & 0xff)});
  }
  return der(0x30, der(0xA0, subtrees));
}

struct Key { // an owned key pair
  mbedtls_pk_context pk;
  Key() { mbedtls_pk_init(&pk); }
  ~Key() { mbedtls_pk_free(&pk); }
  Key(const Key &) = delete;
  Key &operator=(const Key &) = delete;
  // A new P-256 key: small, and quick to make and use on a microcontroller.
  bool generate() {
    return mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) == 0 &&
           mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(pk), rng_cb, nullptr) == 0;
  }
  bool load(const string &pem) {
    return mbedtls_pk_parse_key(&pk, reinterpret_cast<const unsigned char *>(pem.c_str()), pem.size() + 1, nullptr, 0, rng_cb, nullptr) == 0;
  }
  string pem() {
    unsigned char buf[2048];
    return mbedtls_pk_write_key_pem(&pk, buf, sizeof buf) == 0 ? string(reinterpret_cast<char *>(buf)) : "";
  }
};

inline string cert_time(std::time_t t) { // YYYYMMDDhhmmss, UTC
  std::tm tm{};
  sys::utc(t, tm);
  char buf[20];
  std::strftime(buf, sizeof buf, "%Y%m%d%H%M%S", &tm);
  return buf;
}

// Write one certificate. `names` (host names and IPv4 addresses) go in as
// subject alternative names, which is what browsers check. `signs` is how
// many further authorities may hang below this one (-1: it is not an
// authority at all); `limits` is the name-constraints extension, if any.
inline string write_cert(Key &subject, Key &issuer, const string &subject_name, const string &issuer_name, int signs, int days,
                         const std::vector<string> &names, const std::vector<unsigned char> &limits, string &err) {
  const bool is_ca = signs >= 0;
  mbedtls_x509write_cert crt;
  mbedtls_x509write_crt_init(&crt);
  unsigned char serial[16];
  random_bytes(serial, sizeof serial);
  serial[0] = static_cast<unsigned char>((serial[0] & 0x7f) | 0x01); // positive and non-zero
  std::time_t now = std::time(nullptr);
  string from = cert_time(now - 86400), to = cert_time(now + static_cast<std::time_t>(days) * 86400);

  std::vector<mbedtls_x509_san_list> sans(names.size());
  std::vector<std::vector<unsigned char>> bytes(names.size());
  for (size_t i = 0; i < names.size(); i++) {
    in_addr ip{};
    if (::inet_pton(AF_INET, names[i].c_str(), &ip) == 1) {
      bytes[i].assign(reinterpret_cast<unsigned char *>(&ip), reinterpret_cast<unsigned char *>(&ip) + 4);
      sans[i].node.type = MBEDTLS_X509_SAN_IP_ADDRESS;
    } else {
      bytes[i].assign(names[i].begin(), names[i].end());
      sans[i].node.type = MBEDTLS_X509_SAN_DNS_NAME;
    }
    sans[i].node.san.unstructured_name.tag = 0;
    sans[i].node.san.unstructured_name.p = bytes[i].data();
    sans[i].node.san.unstructured_name.len = bytes[i].size();
    sans[i].next = i + 1 < names.size() ? &sans[i + 1] : nullptr;
  }
  mbedtls_asn1_sequence server_auth{};
  server_auth.buf.tag = MBEDTLS_ASN1_OID;
  server_auth.buf.p = reinterpret_cast<unsigned char *>(const_cast<char *>(MBEDTLS_OID_SERVER_AUTH));
  server_auth.buf.len = MBEDTLS_OID_SIZE(MBEDTLS_OID_SERVER_AUTH);

  int rc = 0;
  mbedtls_x509write_crt_set_subject_key(&crt, &subject.pk);
  mbedtls_x509write_crt_set_issuer_key(&crt, &issuer.pk);
  mbedtls_x509write_crt_set_version(&crt, MBEDTLS_X509_CRT_VERSION_3);
  mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
  if (!rc) rc = mbedtls_x509write_crt_set_subject_name(&crt, subject_name.c_str());
  if (!rc) rc = mbedtls_x509write_crt_set_issuer_name(&crt, issuer_name.c_str());
  if (!rc) rc = mbedtls_x509write_crt_set_serial_raw(&crt, serial, sizeof serial);
  if (!rc) rc = mbedtls_x509write_crt_set_validity(&crt, from.c_str(), to.c_str());
  if (!rc) rc = mbedtls_x509write_crt_set_basic_constraints(&crt, is_ca ? 1 : 0, signs);
  if (!rc) rc = mbedtls_x509write_crt_set_subject_key_identifier(&crt);
  if (!rc) rc = mbedtls_x509write_crt_set_authority_key_identifier(&crt);
  if (!rc) rc = mbedtls_x509write_crt_set_key_usage(&crt, is_ca ? MBEDTLS_X509_KU_KEY_CERT_SIGN | MBEDTLS_X509_KU_CRL_SIGN : MBEDTLS_X509_KU_DIGITAL_SIGNATURE);
  if (!rc && !is_ca) rc = mbedtls_x509write_crt_set_ext_key_usage(&crt, &server_auth);
  if (!rc && !names.empty()) rc = mbedtls_x509write_crt_set_subject_alternative_name(&crt, sans.data());
  // Critical: a program that does not understand the limits must refuse the certificate, not ignore them.
  if (!rc && !limits.empty()) rc = mbedtls_x509write_crt_set_extension(&crt, MBEDTLS_OID_NAME_CONSTRAINTS, MBEDTLS_OID_SIZE(MBEDTLS_OID_NAME_CONSTRAINTS), 1, limits.data(), limits.size());
  unsigned char buf[4096];
  if (!rc) rc = mbedtls_x509write_crt_pem(&crt, buf, sizeof buf, rng_cb, nullptr);
  mbedtls_x509write_crt_free(&crt);
  if (rc) { err = mbed_error(rc); return ""; }
  return reinterpret_cast<char *>(buf);
}

// SHA-256 of a certificate, as browsers and phones show it: AA:BB:…
inline string fingerprint(const string &pem) {
  mbedtls_x509_crt crt;
  mbedtls_x509_crt_init(&crt);
  string out;
  if (parse_certs(&crt, pem) == 0) {
    unsigned char sum[32];
    mbedtls_sha256(crt.raw.p, crt.raw.len, sum, 0);
    static const char d[] = "0123456789ABCDEF";
    for (size_t i = 0; i < sizeof sum; i++) { if (i) out += ':'; out += d[sum[i] >> 4]; out += d[sum[i] & 15]; }
  }
  mbedtls_x509_crt_free(&crt);
  return out;
}
// Days until the first certificate in `pem` ends (negative if it already has).
inline long days_left(const string &pem) {
  mbedtls_x509_crt crt;
  mbedtls_x509_crt_init(&crt);
  long days = -1;
  if (parse_certs(&crt, pem) == 0) {
    std::tm tm{};
    tm.tm_year = crt.valid_to.year - 1900;
    tm.tm_mon = crt.valid_to.mon - 1;
    tm.tm_mday = crt.valid_to.day;
    // The year and day are enough here; avoids timegm, which the board's C library lacks.
    long long end = (static_cast<long long>(tm.tm_year) - 70) * 365 + (tm.tm_year - 69) / 4 + tm.tm_mon * 30 + tm.tm_mday;
    days = static_cast<long>(end - static_cast<long long>(std::time(nullptr) / 86400));
  }
  mbedtls_x509_crt_free(&crt);
  return days;
}

struct Certs {
  string cert_path, key_path, ca_path; // what the server presents, its key, and the authority to install on devices
  string ca_fingerprint;
  bool issued = false;                 // a new server certificate was written this time
  bool new_authority = false;          // a new authority was made: every device installs it once
  bool replaced_open = false;          // ...in place of an older one that could vouch for any site
  std::vector<string> covered, left_out; // names in the certificate, and names it may not carry
};

// Make sure `dir` holds an authority and a server certificate that covers
// `names` and has at least a month left. Creates or re-issues what is missing.
// The server certificate lasts 820 days: Apple devices refuse longer ones.
// `renew` makes a new authority even if there is a good one.
inline bool ensure_certs(const string &dir, std::vector<string> names, Certs &out, string &err, bool renew = false) {
  std::sort(names.begin(), names.end());
  names.erase(std::unique(names.begin(), names.end()), names.end());
  out.cert_path = dir + "/cert.pem";
  out.key_path = dir + "/key.pem";
  out.ca_path = dir + "/ca.pem";
  const string issuer_path = dir + "/issuer.pem", issuer_key_path = dir + "/issuer-key.pem", zones_path = dir + "/issuer.zones";
  const string old_key_path = dir + "/ca-key.pem", names_path = dir + "/cert.names";
  const char *ca_name = "CN=Hub authority (this hub only),O=Hub", *issuer_name = "CN=Hub issuer,O=Hub";

  Key issuer_key;
  string ca_pem, issuer_pem, issuer_key_pem, zone_text;
  std::vector<string> zones;
  const bool have = !renew && slurp(out.ca_path, ca_pem) && slurp(issuer_path, issuer_pem) && slurp(issuer_key_path, issuer_key_pem) && slurp(zones_path, zone_text);
  if (have) {
    if (!issuer_key.load(issuer_key_pem)) { err = "cannot read " + issuer_key_path; return false; }
    std::istringstream lines(zone_text);
    for (string z; std::getline(lines, z);) if (!z.empty()) zones.push_back(z);
  } else {
    // A new authority. Its key lives in memory for the next few lines only.
    struct stat st;
    out.replaced_open = ::stat(old_key_path.c_str(), &st) == 0;
    zones = zones_for(names);
    const std::vector<unsigned char> limits = name_constraints(zones);
    Key ca_key;
    if (!ca_key.generate() || !issuer_key.generate()) { err = "could not make a key"; return false; }
    ca_pem = write_cert(ca_key, ca_key, ca_name, ca_name, 1, 3650, {}, limits, err);
    if (ca_pem.empty()) return false;
    issuer_pem = write_cert(issuer_key, ca_key, issuer_name, ca_name, 0, 3649, {}, limits, err);
    if (issuer_pem.empty()) return false;
    for (const string &z : zones) zone_text += z + "\n";
    if (!spit(issuer_key_path, issuer_key.pem(), 0600) || !spit(issuer_path, issuer_pem, 0644) || !spit(zones_path, zone_text, 0644) || !spit(out.ca_path, ca_pem, 0644)) { err = "cannot write to " + dir; return false; }
    // Earlier versions kept the authority's own key, and that authority had no
    // limits. Neither it nor anything it signed may be used again.
    ::unlink(old_key_path.c_str());
    ::unlink(out.cert_path.c_str());
    out.new_authority = true;
  }
  out.ca_fingerprint = fingerprint(ca_pem);

  // Only names the issuer may vouch for go into the certificate: one name
  // outside its limits would make browsers refuse the whole certificate.
  for (const string &n : names) (in_scope(n, zones) ? out.covered : out.left_out).push_back(n);
  string want, have_names, cert_pem, key_pem;
  for (const string &n : out.covered) want += n + "\n";
  bool keep = slurp(names_path, have_names) && have_names == want && slurp(out.cert_path, cert_pem) && slurp(out.key_path, key_pem) && days_left(cert_pem) > 30;
  if (keep) return true;

  Key key;
  if (!key.generate()) { err = "could not make a key"; return false; }
  cert_pem = write_cert(key, issuer_key, "CN=Hub,O=Hub", issuer_name, -1, 820, out.covered, {}, err);
  if (cert_pem.empty()) return false;
  // The file holds the server's certificate followed by the issuer's, which is the order TLS sends them in.
  if (!spit(out.key_path, key.pem(), 0600) || !spit(out.cert_path, cert_pem + issuer_pem, 0644) || !spit(names_path, want, 0644)) { err = "cannot write to " + dir; return false; }
  out.issued = true;
  return true;
}

} // namespace secure
