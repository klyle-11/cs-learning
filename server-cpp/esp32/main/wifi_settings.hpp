// Codex (B06): parse into bounded temporary storage before changing saved settings.
#pragma once
#include <cstdio>
#include <cstring>

struct WifiSettings {
  char ssid[33] = "", password[65] = "", name[32] = "";
};

inline bool read_wifi_settings(FILE *file, WifiSettings &settings) {
  WifiSettings parsed;
  char line[160];
  while (std::fgets(line, sizeof line, file)) {
    // Never interpret the continuation of an overlong line as another setting.
    if (!std::strchr(line, '\n') && !std::feof(file)) return false;
    line[std::strcspn(line, "\r\n")] = '\0';
    char *eq = std::strchr(line, '=');
    if (!eq) continue;
    *eq++ = '\0';
    char *out = nullptr;
    size_t room = 0;
    if (!std::strcmp(line, "ssid")) { out = parsed.ssid; room = sizeof parsed.ssid; }
    else if (!std::strcmp(line, "password")) { out = parsed.password; room = sizeof parsed.password; }
    else if (!std::strcmp(line, "name")) { out = parsed.name; room = sizeof parsed.name; }
    if (out) {
      const size_t len = std::strlen(eq);
      if (len >= room) return false;
      std::memcpy(out, eq, len + 1);
    }
  }
  if (std::ferror(file) || !parsed.ssid[0]) return false;
  settings = parsed;
  return true;
}
