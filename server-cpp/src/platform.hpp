// What differs between operating systems, in one place. The rest of the
// server is written against the small set of functions in `sys` below, and
// against the POSIX calls that Windows (built with MinGW-w64) also provides
// under the same names: stat, opendir/readdir, unlink, rmdir, fopen.
//
//   POSIX   macOS, Linux, and ESP-IDF on the board. This half is what the
//           tests run against.
//   Windows built with MinGW-w64 from MSYS2 (see ../../WINDOWS.md). Compiled
//           and run there; the same tests pass.
#pragma once

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef _WIN32_WINNT
#    define _WIN32_WINNT 0x0A00   // Windows 10: inet_pton, WSAPoll
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <iphlpapi.h>
#  include <windows.h>
#  include <direct.h>
#  include <dirent.h>
#  include <io.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#else
#  include <arpa/inet.h>
#  include <dirent.h>
#  include <fcntl.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <sys/poll.h>
#  include <sys/socket.h>
#  include <sys/stat.h>
#  include <unistd.h>
#  ifndef ESP_PLATFORM
#    include <ifaddrs.h>
#    include <sys/statvfs.h>
#  endif
#endif

#include <cerrno>
#include <climits>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <string>
#include <vector>

namespace sys {

// ---- sockets ----------------------------------------------------------------------
// A socket is kept as an int everywhere. On Windows the real type is wider,
// but the values handed out fit, and "invalid" becomes -1 either way.

// Call once before anything else touches the network.
inline bool net_start() {
#ifdef _WIN32
  WSADATA data;
  return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
#  ifndef ESP_PLATFORM
  std::signal(SIGPIPE, SIG_IGN);   // a write to a closed connection is an error to handle, not a reason to stop
#  endif
  return true;
#endif
}
inline void close_socket(int fd) {
#ifdef _WIN32
  ::closesocket(static_cast<SOCKET>(fd));
#else
  ::close(fd);
#endif
}
inline void nonblocking(int fd) {
#ifdef _WIN32
  u_long on = 1;
  ::ioctlsocket(static_cast<SOCKET>(fd), FIONBIO, &on);
#else
  ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
#endif
}
inline void set_option(int fd, int level, int name) {
  int yes = 1;
#ifdef _WIN32
  ::setsockopt(static_cast<SOCKET>(fd), level, name, reinterpret_cast<const char *>(&yes), sizeof yes);
#else
  ::setsockopt(fd, level, name, &yes, sizeof yes);
#endif
}
// Why the last receive or send did not move any bytes.
enum class Why { again, interrupted, failed };
inline Why why() {
#ifdef _WIN32
  int e = WSAGetLastError();
  return e == WSAEWOULDBLOCK ? Why::again : e == WSAEINTR ? Why::interrupted : Why::failed;
#else
  return errno == EINTR ? Why::interrupted : (errno == EAGAIN || errno == EWOULDBLOCK) ? Why::again : Why::failed;
#endif
}
// Bytes moved, 0 when the other side has closed (receive), or negative: then ask why().
inline long receive(int fd, void *out, size_t len, bool peek = false) {
#ifdef _WIN32
  return ::recv(static_cast<SOCKET>(fd), static_cast<char *>(out), static_cast<int>(len), peek ? MSG_PEEK : 0);
#else
  return static_cast<long>(::recv(fd, out, len, peek ? MSG_PEEK : 0));
#endif
}
inline long send_some(int fd, const void *data, size_t len) {
#ifdef _WIN32
  return ::send(static_cast<SOCKET>(fd), static_cast<const char *>(data), static_cast<int>(len), 0);
#else
  return static_cast<long>(::send(fd, data, len, 0));
#endif
}
// Wait until the socket can be read (or written), at most `ms`. True if it can.
inline bool wait_ready(int fd, bool to_read, int ms) {
#ifdef _WIN32
  WSAPOLLFD p{static_cast<SOCKET>(fd), static_cast<SHORT>(to_read ? POLLRDNORM : POLLWRNORM), 0};
  return WSAPoll(&p, 1, ms) > 0;
#else
  pollfd p{fd, static_cast<short>(to_read ? POLLIN : POLLOUT), 0};
  int rc;
  do { rc = ::poll(&p, 1, ms); } while (rc < 0 && errno == EINTR);
  return rc > 0;
#endif
}
inline int accept_from(int srv, sockaddr_in &peer) {
  socklen_t len = sizeof peer;
#ifdef _WIN32
  SOCKET s = ::accept(static_cast<SOCKET>(srv), reinterpret_cast<sockaddr *>(&peer), &len);
  return s == INVALID_SOCKET ? -1 : static_cast<int>(s);
#else
  return ::accept(srv, reinterpret_cast<sockaddr *>(&peer), &len);
#endif
}
inline int tcp_socket() {
#ifdef _WIN32
  SOCKET s = ::socket(AF_INET, SOCK_STREAM, 0);
  return s == INVALID_SOCKET ? -1 : static_cast<int>(s);
#else
  return ::socket(AF_INET, SOCK_STREAM, 0);
#endif
}
inline bool bind_and_listen(int srv, const sockaddr_in &addr, int backlog) {
#ifdef _WIN32
  return ::bind(static_cast<SOCKET>(srv), reinterpret_cast<const sockaddr *>(&addr), sizeof addr) == 0 && ::listen(static_cast<SOCKET>(srv), backlog) == 0;
#else
  return ::bind(srv, reinterpret_cast<const sockaddr *>(&addr), sizeof addr) == 0 && ::listen(srv, backlog) == 0;
#endif
}

// ---- time ---------------------------------------------------------------------------
inline void utc(std::time_t t, std::tm &out) {
#ifdef _WIN32
  ::gmtime_s(&out, &t);
#else
  ::gmtime_r(&t, &out);
#endif
}

// ---- files ----------------------------------------------------------------------------
inline void make_dir(const std::string &path) {
#ifdef _WIN32
  ::_mkdir(path.c_str());
#else
  ::mkdir(path.c_str(), 0755);
#endif
}
// Whether a path is a link to somewhere else (a symbolic link; on Windows also
// a junction). A link is removed as itself and never followed.
inline bool is_link(const std::string &path) {
#ifdef _WIN32
  DWORD a = GetFileAttributesA(path.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_REPARSE_POINT);
#elif defined(ESP_PLATFORM)
  (void)path;
  return false;   // the card's FAT filesystem has no links
#else
  struct stat st;
  return ::lstat(path.c_str(), &st) == 0 && S_ISLNK(st.st_mode);
#endif
}
// Remove a link itself (not what it points at).
inline bool remove_link(const std::string &path) {
#ifdef _WIN32
  return RemoveDirectoryA(path.c_str()) != 0 || DeleteFileA(path.c_str()) != 0;   // a link to a folder is removed as a folder
#else
  return ::unlink(path.c_str()) == 0;
#endif
}
// Put `tmp` in place of `path`, replacing it. On a computer that is one step
// that cannot be half done. The FAT filesystem on the board's card cannot
// rename onto an existing file, so there the old one is removed first.
inline bool replace(const std::string &tmp, const std::string &path) {
#ifdef _WIN32
  return MoveFileExA(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
#  ifdef ESP_PLATFORM
  ::unlink(path.c_str());
#  endif
  return ::rename(tmp.c_str(), path.c_str()) == 0;
#endif
}
// Move a folder or a file to a new name on the same disk, in one step, never onto something that is there already.
inline bool move(const std::string &from, const std::string &to) {
#ifdef _WIN32
  return MoveFileExA(from.c_str(), to.c_str(), 0) != 0;   // without MOVEFILE_REPLACE_EXISTING: refused if `to` exists
#else
  struct stat st;
  if (::lstat(to.c_str(), &st) == 0) return false;   // rename() would put a folder in place of an empty one
  return ::rename(from.c_str(), to.c_str()) == 0;
#endif
}
// Readable and writable by the owner only (0600, 0700). Windows keeps files
// under the user's profile private to that user already.
inline void owner_only(const std::string &path, int mode) {
#ifdef _WIN32
  (void)path; (void)mode;
#else
  ::chmod(path.c_str(), static_cast<mode_t>(mode));
#endif
}
// The full, real path of something that exists, with "/" between its parts on
// every system. False if it does not exist.
inline bool real_path(const std::string &path, std::string &out) {
#ifdef _WIN32
  char buf[MAX_PATH * 4];
  if (!_fullpath(buf, path.c_str(), sizeof buf) || GetFileAttributesA(buf) == INVALID_FILE_ATTRIBUTES) return false;
  out = buf;
  for (char &c : out) if (c == '\\') c = '/';
  while (out.size() > 3 && out.back() == '/') out.pop_back();
  return true;
#else
  char buf[4096];
  if (!::realpath(path.c_str(), buf)) return false;
  out = buf;
  return true;
#endif
}
// Bytes free on the disk that holds `path`; all ones if it cannot be told.
inline unsigned long long free_bytes(const std::string &path) {
#ifdef _WIN32
  ULARGE_INTEGER avail;
  if (GetDiskFreeSpaceExA(path.c_str(), &avail, nullptr, nullptr)) return avail.QuadPart;
#elif !defined(ESP_PLATFORM)
  struct statvfs v;
  if (::statvfs(path.c_str(), &v) == 0) return static_cast<unsigned long long>(v.f_bavail) * static_cast<unsigned long long>(v.f_frsize);
#else
  (void)path;
#endif
  return ~0ULL;
}
inline bool seek(FILE *f, unsigned long long offset) {
#ifdef _WIN32
  return ::_fseeki64(f, static_cast<long long>(offset), SEEK_SET) == 0;
#else
  return ::fseeko(f, static_cast<off_t>(offset), SEEK_SET) == 0;
#endif
}

// ---- the machine ------------------------------------------------------------------------
inline unsigned long long memory_mb() {
#ifdef _WIN32
  MEMORYSTATUSEX m;
  m.dwLength = sizeof m;
  return GlobalMemoryStatusEx(&m) ? m.ullTotalPhys >> 20 : 0;
#elif !defined(ESP_PLATFORM)
  long pages = ::sysconf(_SC_PHYS_PAGES), page_size = ::sysconf(_SC_PAGESIZE);
  return pages > 0 && page_size > 0 ? static_cast<unsigned long long>(pages) * static_cast<unsigned long long>(page_size) >> 20 : 0;
#else
  return 0;
#endif
}
inline std::string host_name() {
#ifdef ESP_PLATFORM
  return "";
#else
  char name[256] = {0};
  return ::gethostname(name, sizeof name - 1) == 0 ? name : "";
#endif
}
// The IPv4 addresses this machine has on its networks.
inline std::vector<std::string> ipv4_addresses() {
  std::vector<std::string> out;
#ifdef _WIN32
  ULONG size = 16 * 1024;
  std::vector<unsigned char> buf(size);
  auto *list = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buf.data());
  if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, list, &size) == ERROR_BUFFER_OVERFLOW) {
    buf.resize(size);
    list = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buf.data());
    if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, list, &size) != NO_ERROR) return out;
  }
  for (auto *a = list; a; a = a->Next) {
    for (auto *u = a->FirstUnicastAddress; u; u = u->Next) {
      char text[INET_ADDRSTRLEN];
      if (u->Address.lpSockaddr->sa_family == AF_INET && ::inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in *>(u->Address.lpSockaddr)->sin_addr, text, sizeof text)) out.push_back(text);
    }
  }
#elif !defined(ESP_PLATFORM)
  ifaddrs *list = nullptr;
  if (::getifaddrs(&list) == 0) {
    for (ifaddrs *i = list; i; i = i->ifa_next) {
      if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET) continue;
      char text[INET_ADDRSTRLEN];
      if (::inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in *>(i->ifa_addr)->sin_addr, text, sizeof text)) out.push_back(text);
    }
    ::freeifaddrs(list);
  }
#endif
  return out;
}
// Where certificates and the list of paired devices are kept unless told otherwise.
inline std::string default_state_dir() {
#ifdef _WIN32
  const char *base = std::getenv("APPDATA");
  std::string dir = std::string(base ? base : ".") + "/hub";
  for (char &c : dir) if (c == '\\') c = '/';
  return dir;
#else
  const char *home = std::getenv("HOME");
  return std::string(home ? home : ".") + "/.config/hub";
#endif
}
// A name Windows treats specially whatever its extension (CON, NUL, COM1...),
// or one it would quietly alter (ending in a dot or a space), or one that
// names a stream or a drive (":"). Such a part is never a file of ours.
inline bool odd_on_windows(const std::string &part) {
  if (part.find(':') != std::string::npos || part.back() == '.' || part.back() == ' ') return true;
  std::string stem = part.substr(0, part.find('.'));
  for (char &c : stem) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  static const char *reserved[] = {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"};
  for (const char *r : reserved) if (stem == r) return true;
  return false;
}
// A path longer than the system will open. Windows stops at 259 characters
// for the whole path (counted in UTF-16 units); elsewhere the limit is on
// each part, 255 bytes, and on the whole, PATH_MAX.
inline bool path_too_long(const std::string &path) {
#ifdef _WIN32
  size_t units = 0;
  for (unsigned char c : path) if ((c & 0xC0) != 0x80) units += c >= 0xF0 ? 2 : 1;
  return units >= MAX_PATH;
#else
  if (path.size() >= PATH_MAX) return true;
  size_t part = 0;
  for (char c : path) { part = c == '/' ? 0 : part + 1; if (part > 255) return true; }
  return false;
#endif
}

} // namespace sys
