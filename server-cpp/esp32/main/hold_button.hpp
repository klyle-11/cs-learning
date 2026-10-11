#pragma once
#include <cstdint>
struct HoldButton {
  int64_t began = -1;
  bool offered = false;
  bool update(int64_t now, bool down) {
    if (!down) { began = -1; offered = false; return false; }
    if (began < 0) began = now;
    if (!offered && now - began >= 6000000) { offered = true; return true; }
    return false;
  }
};
