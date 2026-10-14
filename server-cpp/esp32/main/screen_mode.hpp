// Screen navigation and inactivity, independent of the OLED driver.
#pragma once
#include <cstdint>

struct ScreenMode {
  enum Page { Status, Details, Clock };
  static constexpr int64_t IDLE_US = 600LL * 1000000;
  Page page = Status;
  bool dim = false;

  void update(int64_t now, uint32_t content, bool pressed, bool urgent) {
    if (!started || content != last_content) {
      started = true;
      last_content = content;
      changed_at = now;
      page = Status;
    }
    if (pressed && (!button_seen || now - last_button >= 250000)) {
      button_seen = true;
      last_button = now;
      changed_at = now;
      if (!urgent) page = page == Status ? Details : page == Details ? Clock : Status;
    }
    if (page == Details && now - changed_at >= 8000000) page = Status;
    dim = !urgent && now - changed_at >= IDLE_US;
    if (dim) page = Clock;
    if (urgent) page = Status;
  }

 private:
  bool started = false, button_seen = false;
  uint32_t last_content = 0;
  int64_t changed_at = 0, last_button = 0;
};
