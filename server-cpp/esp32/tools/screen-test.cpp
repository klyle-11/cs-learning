// Host checks for clock rollover, idle transitions, and urgent-screen priority.
// Build like screen-preview.cpp, with -I main -I ../src, then run the executable.
#include <cassert>
#include <cstdio>
#include <cstring>
#include "screen_clock.hpp"
#include "screen_mode.hpp"

int main() {
  BoardView view;
  clock_text(view, 1767243600);
  assert(!std::strcmp(view.time, "--:--") && !std::strcmp(view.date, "Time not synced"));
  view.clock_synced = true;
  clock_text(view, 1767243600); // Jan 1 2026, 05:00 UTC = midnight EST.
  assert(!std::strcmp(view.time, "12:00") && !std::strcmp(view.meridiem, "AM"));
  assert(!std::strcmp(view.date, "Thu, Jan 1"));
  clock_text(view, 1767286800); // noon
  assert(!std::strcmp(view.time, "12:00") && !std::strcmp(view.meridiem, "PM"));
  clock_text(view, 1767290400); // 1 PM, no leading zero
  assert(!std::strcmp(view.time, "1:00") && !std::strcmp(view.meridiem, "PM"));
  clock_text(view, 1767243540); // previous year in EST
  assert(!std::strcmp(view.time, "11:59") && !std::strcmp(view.date, "Wed, Dec 31"));
  assert(!std::strcmp(view.zone, "EST"));
  clock_text(view, 1782864000); // July 1 00:00 UTC: 8 PM EDT the evening before.
  assert(!std::strcmp(view.time, "8:00") && !std::strcmp(view.meridiem, "PM") && !std::strcmp(view.zone, "EDT"));
  assert(!std::strcmp(view.date, "Tue, Jun 30"));
  clock_text(view, 1772953199); // Mar 8 2026, a second before 2:00 EST
  assert(!std::strcmp(view.time, "1:59") && !std::strcmp(view.zone, "EST"));
  clock_text(view, 1772953200); // 2:00 EST is 3:00 EDT
  assert(!std::strcmp(view.time, "3:00") && !std::strcmp(view.zone, "EDT"));
  clock_text(view, 1793512740); // Nov 1 2026, a minute before 2:00 EDT
  assert(!std::strcmp(view.time, "1:59") && !std::strcmp(view.zone, "EDT"));
  clock_text(view, 1793512800); // 2:00 EDT is 1:00 EST
  assert(!std::strcmp(view.time, "1:00") && !std::strcmp(view.zone, "EST"));

  ScreenMode mode;
  mode.update(0, 42, false, false);
  mode.update(ScreenMode::IDLE_US - 1, 42, false, false);
  assert(mode.page == ScreenMode::Status && !mode.dim);
  mode.update(ScreenMode::IDLE_US, 42, false, false);
  assert(mode.page == ScreenMode::Clock && mode.dim);
  mode.update(ScreenMode::IDLE_US + 1, 42, true, false);
  assert(mode.page == ScreenMode::Status && !mode.dim);
  mode.update(ScreenMode::IDLE_US + 2, 42, true, false); // button bounce
  assert(mode.page == ScreenMode::Status);
  mode.update(ScreenMode::IDLE_US + 300000, 42, true, false);
  assert(mode.page == ScreenMode::Details);
  mode.update(ScreenMode::IDLE_US + 600000, 42, true, false);
  assert(mode.page == ScreenMode::Clock);
  mode.update(ScreenMode::IDLE_US + 900000, 43, false, false); // meaningful activity
  assert(mode.page == ScreenMode::Status && !mode.dim);
  mode.update(ScreenMode::IDLE_US + 1200000, 43, true, false);
  mode.update(ScreenMode::IDLE_US + 9200000, 43, false, false);
  assert(mode.page == ScreenMode::Status); // details expire after eight seconds
  mode.update(ScreenMode::IDLE_US * 3, 43, true, true);
  assert(mode.page == ScreenMode::Status && !mode.dim); // errors stay visible

  HubStatus status;
  status.running = true;
  Canvas clock, normal;
  view.clock = true;
  draw_screen(clock, status, view, 0);
  view.clock = false;
  draw_screen(normal, status, view, 0);
  assert(std::memcmp(clock.px, normal.px, sizeof clock.px));
  // The clock must yield to each operational screen, even if requested directly.
  for (int which = 0; which < 5; which++) {
    BoardView urgent;
    HubStatus s = status;
    if (which == 0) std::strcpy(urgent.say[0], "Starting...");
    if (which == 1) urgent.progress = 50;
    if (which == 2) std::strcpy(s.pair_code, "K7QM-2XRF");
    if (which == 3) std::strcpy(urgent.alert, "Wi-Fi lost");
    if (which == 4) std::strcpy(s.notice, "Paired: phone");
    draw_screen(normal, s, urgent, 0);
    urgent.clock = true;
    draw_screen(clock, s, urgent, 0);
    assert(!std::memcmp(clock.px, normal.px, sizeof clock.px));
  }
  // Advancing time is not an activity event: screen_sum uses the normal view.
  view.clock = false;
  const auto before = screen_sum(normal, status, view);
  clock_text(view, 1767243600);
  assert(before == screen_sum(normal, status, view));
  std::puts("PASS: Eastern clock (EST and EDT), rollovers, idle/button transitions, urgent-screen priority");
}
