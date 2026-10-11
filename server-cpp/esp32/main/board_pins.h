// The board this firmware is for, and where things are on it: the LilyGO T3-S3
// V1.3 only (the T3 V1.6.1 was dropped on 11 October 2026). Pins from LilyGO's
// own board definitions (LilyGo-LoRa-Series, utilities.h). The LoRa radio is
// left alone: the hub does not use it.
#pragma once
#include "sdkconfig.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "This firmware is for the LilyGO T3-S3 (ESP32-S3): idf.py set-target esp32s3"
#endif
// LilyGO T3-S3 V1.3 (V1.2 is the same but for the charging circuit): ESP32-S3FH4R2,
// 4 MB flash and 2 MB PSRAM in the chip, USB-C on the chip's own USB, BOOT and RESET buttons.
#define BOARD_NAME "T3-S3 V1.3"
static const int SD_MOSI = 11, SD_MISO = 2, SD_CLK = 14, SD_CS = 13;
static const int OLED_SDA = 18, OLED_SCL = 17;
static const int BOARD_LED = 37;
static const int BOARD_BUTTON = 0;   // BOOT: free to use once running
static const int BATTERY_ADC = 1;
