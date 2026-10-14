// US Eastern time for the clock slide: EST (UTC-5), and EDT (UTC-4) from 2:00
// on the second Sunday of March to 2:00 on the first Sunday of November. Does
// not change the server's UTC clock. Uses the existing portable time conversion.
#pragma once
#include "platform.hpp"
#include "screen_draw.hpp"

// Whether daylight time is in force at `utc`. Worked out from standard time:
// the change in March is at 2:00 standard, the one in November at 1:00 standard
// (2:00 daylight).
inline bool eastern_daylight(std::time_t utc) {
  std::tm t = {};
  sys::utc(utc - 5 * 60 * 60, t);
  if (t.tm_mon < 2 || t.tm_mon > 10) return false; // January, February, December
  if (t.tm_mon > 2 && t.tm_mon < 10) return true;  // April to October
  const int first_weekday = ((t.tm_wday - (t.tm_mday - 1)) % 7 + 7) % 7; // of the 1st of this month
  const int first_sunday = 1 + (7 - first_weekday) % 7;
  if (t.tm_mon == 2) { const int day = first_sunday + 7; return t.tm_mday > day || (t.tm_mday == day && t.tm_hour >= 2); }
  return t.tm_mday < first_sunday || (t.tm_mday == first_sunday && t.tm_hour < 1);
}

inline void clock_text(BoardView &view, std::time_t utc) {
  if (!view.clock_synced) {
    std::snprintf(view.time, sizeof view.time, "--:--");
    view.meridiem[0] = '\0';
    std::snprintf(view.zone, sizeof view.zone, "ET");
    std::snprintf(view.date, sizeof view.date, "Time not synced");
    return;
  }
  const bool daylight = eastern_daylight(utc);
  std::tm local = {};
  sys::utc(utc - (daylight ? 4 : 5) * 60 * 60, local);
  const int hour = local.tm_hour % 12;
  int display_hour = hour >= 1 && hour <= 12 ? hour : 12;
  int minute = local.tm_min >= 0 && local.tm_min <= 59 ? local.tm_min : 0;

  std::snprintf(view.time, sizeof view.time, "%d:%02d", display_hour, minute);
  std::snprintf(view.meridiem, sizeof view.meridiem, "%s", local.tm_hour < 12 ? "AM" : "PM");
  std::snprintf(view.zone, sizeof view.zone, "%s", daylight ? "EDT" : "EST");
  static const char *days[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  static const char *months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  std::snprintf(view.date, sizeof view.date, "%s, %s %d", days[local.tm_wday], months[local.tm_mon], local.tm_mday);
}
