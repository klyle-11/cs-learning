// The OLED on the board: what board.cpp and update.cpp tell it. See screen.cpp.
#pragma once

void screen_start();                                     // finds the display; without one, everything below does nothing
void screen_say(const char *line1, const char *line2 = nullptr, const char *line3 = nullptr); // in place of the device list; screen_say(nullptr) clears
void screen_progress(int percent);                        // an update downloading, 0 to 100; -1 clears
void screen_alert(const char *text);                      // kept on the bottom line until screen_alert(nullptr)
void screen_name(const char *name);                       // the name on the network ("hub.local"), shown in turn with the address
