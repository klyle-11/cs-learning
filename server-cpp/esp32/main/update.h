// Firmware updates from GitHub releases, signed. See update.cpp.
#pragma once

void update_start();         // looks for a release now and then, if this build knows where and whose signature to trust
void update_keep();          // the running firmware has proved itself: keep it (until then a restart goes back to the previous one)
void update_give_up();       // the running firmware cannot start: go back to the previous one, if there is one waiting
