// Firmware updates from /sdcard/firmware.bin, with OTA rollback.
#pragma once

void update_start();         // installs a valid image from the card, if present; restarts on success
void update_keep();          // the running firmware has served for a minute: keep it
void update_give_up();       // startup failed: return to the previous slot if this image is pending
