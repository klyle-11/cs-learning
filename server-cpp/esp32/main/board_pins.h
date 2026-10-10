// Which board this build is for, and where things are on it. The build target
// decides: `idf.py set-target esp32` is the T3 V1.6.1, `esp32s3` the T3-S3.
// Pins from LilyGO's own board definitions (LilyGo-LoRa-Series, utilities.h).
// The LoRa radio on both is left alone: the hub does not use it.
#pragma once
#include "sdkconfig.h"

#if CONFIG_IDF_TARGET_ESP32S3
// LilyGO T3-S3 V1.3 (V1.2 is the same but for the charging circuit): ESP32-S3FH4R2,
// 4 MB flash and 2 MB PSRAM in the chip, USB-C on the chip's own USB, BOOT and RESET buttons.
#define BOARD_NAME "T3-S3 V1.3"
static const int SD_MOSI = 11, SD_MISO = 2, SD_CLK = 14, SD_CS = 13;
static const int OLED_SDA = 18, OLED_SCL = 17;
static const int BOARD_LED = 37;
static const int BOARD_BUTTON = 0;   // BOOT: free to use once running
static const int BATTERY_ADC = 1;
#else
// LilyGO T3 LoRa32 V1.6.1: ESP32-PICO-D4, 4 MB flash, no PSRAM. GPIO 2 (SD MISO)
// is also a boot-mode pin: if flashing fails with the card in, take it out.
#define BOARD_NAME "T3 V1.6.1"
static const int SD_MOSI = 15, SD_MISO = 2, SD_CLK = 14, SD_CS = 13;
static const int OLED_SDA = 21, OLED_SCL = 22;
static const int BOARD_LED = 25;
static const int BOARD_BUTTON = -1;  // only RESET
static const int BATTERY_ADC = 35;
#endif
