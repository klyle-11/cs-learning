// Firmware updates from /sdcard/firmware.bin. The image is checked before the
// inactive OTA slot is touched, then ESP-IDF checks it again before making it
// bootable. The old slot remains available until the new server has run for a
// minute, so the bootloader can roll back a build which cannot start.
#include "update.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <new>

#include "esp_app_format.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

#include "screen.h"
#include "version.h"

static const char *TAG = "update";
static const char IMAGE[] = "/sdcard/firmware.bin";
// The image is read in pieces of this size, into one buffer taken from the heap
// only when there is an image: it runs at start-up on the thread that starts
// the board, whose stack (8 KB under Arduino) also holds start()'s own frame.
static const size_t PIECE = 4096;

void update_keep() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "version %d works: kept", HUB_VERSION);
  }
}

void update_give_up() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
    ESP_LOGE(TAG, "version %d cannot start: going back to the previous one", HUB_VERSION);
    screen_say("This version failed.", "Going back to the", "previous one...");
    vTaskDelay(pdMS_TO_TICKS(3000));
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}

// A normal ESP-IDF application image ends in the SHA-256 of all bytes before
// it. Verify that while the file is still only data on the removable card. OTA
// end repeats ESP-IDF's complete header, segment, checksum and digest checks on
// the copy in flash.
static bool image_checks(FILE *f, size_t size, esp_image_header_t &header, unsigned char digest[32], unsigned char *piece) {
  if (size <= sizeof header + 32 || std::fread(&header, 1, sizeof header, f) != sizeof header) return false;
  if (header.magic != ESP_IMAGE_HEADER_MAGIC || header.chip_id != ESP_CHIP_ID_ESP32S3 || !header.hash_appended) return false;
  std::rewind(f);

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  bool ok = mbedtls_sha256_starts(&sha, 0) == 0;
  size_t left = size - 32;
  while (ok && left) {
    const size_t want = std::min(left, PIECE);
    const size_t got = std::fread(piece, 1, want, f);
    if (got != want || mbedtls_sha256_update(&sha, piece, got) != 0) { ok = false; break; }
    left -= got;
  }
  if (ok) ok = mbedtls_sha256_finish(&sha, digest) == 0;
  mbedtls_sha256_free(&sha);
  unsigned char appended[32];
  if (!ok || std::fread(appended, 1, sizeof appended, f) != sizeof appended || std::memcmp(digest, appended, sizeof appended) != 0) return false;
  return std::fgetc(f) == EOF;
}

static void log_digest(const unsigned char digest[32]) {
  char text[65];
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < 32; i++) {
    text[i * 2] = hex[digest[i] >> 4];
    text[i * 2 + 1] = hex[digest[i] & 15];
  }
  text[64] = '\0';
  ESP_LOGI(TAG, "firmware.bin SHA-256 %s", text);
}

void update_start() {
  FILE *f = std::fopen(IMAGE, "rb");
  if (!f) { ESP_LOGI(TAG, "no firmware.bin on the card"); return; }

  if (std::fseek(f, 0, SEEK_END) != 0) { std::fclose(f); return; }
  const long end = std::ftell(f);
  if (end <= 0) { std::fclose(f); ESP_LOGE(TAG, "firmware.bin is empty or unreadable"); return; }
  const size_t size = static_cast<size_t>(end);
  std::rewind(f);

  const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
  if (!slot || size > slot->size) {
    std::fclose(f);
    ESP_LOGE(TAG, "firmware.bin (%u bytes) does not fit the inactive slot", static_cast<unsigned>(size));
    screen_say("Update does not fit.", "Remove firmware.bin", "from the card.");
    return;
  }

  std::unique_ptr<unsigned char[]> piece(new (std::nothrow) unsigned char[PIECE]);
  if (!piece) { std::fclose(f); ESP_LOGE(TAG, "no memory to read firmware.bin"); return; }
  esp_image_header_t header = {};
  unsigned char digest[32];
  if (!image_checks(f, size, header, digest, piece.get())) {
    std::fclose(f);
    ESP_LOGE(TAG, "firmware.bin is not an intact ESP32-S3 image with an appended SHA-256");
    screen_say("Bad firmware.bin.", "Image was not used.", "Check serial log.");
    return;
  }
  log_digest(digest);
  std::rewind(f);

  esp_ota_handle_t ota = 0;
  esp_err_t err = esp_ota_begin(slot, size, &ota);
  size_t done = 0;
  bool ok = err == ESP_OK;
  screen_say(nullptr);
  screen_progress(0);
  while (ok && done < size) {
    const size_t want = std::min(size - done, PIECE);
    const size_t got = std::fread(piece.get(), 1, want, f);
    if (got != want) { ok = false; err = ESP_ERR_INVALID_SIZE; break; }
    err = esp_ota_write(ota, piece.get(), got);
    ok = err == ESP_OK;
    done += got;
    screen_progress(static_cast<int>(done * 100 / size));
  }
  std::fclose(f);

  if (!ok) {
    if (ota) esp_ota_abort(ota);
    screen_progress(-1);
    ESP_LOGE(TAG, "writing firmware.bin stopped at %u/%u bytes: %s", static_cast<unsigned>(done), static_cast<unsigned>(size), esp_err_to_name(err));
    return;
  }
  // This validates every segment, the image checksum and the appended digest.
  err = esp_ota_end(ota);
  if (err != ESP_OK) {
    screen_progress(-1);
    ESP_LOGE(TAG, "firmware.bin failed ESP-IDF image validation: %s", esp_err_to_name(err));
    return;
  }
  // Delete first. Otherwise a read-only or failing card would reinstall the
  // same image on every boot, eventually defeating rollback to the old slot.
  if (std::remove(IMAGE) != 0) {
    screen_progress(-1);
    ESP_LOGE(TAG, "firmware.bin was written but cannot be deleted; leaving the current slot active");
    screen_say("Update card is", "read-only. Image was", "not activated.");
    return;
  }
  err = esp_ota_set_boot_partition(slot);
  if (err != ESP_OK) {
    screen_progress(-1);
    ESP_LOGE(TAG, "cannot select the new firmware: %s", esp_err_to_name(err));
    return;
  }
  screen_progress(-1);
  screen_say("Update installed.", "Restarting...", "Rollback is ready.");
  ESP_LOGI(TAG, "firmware.bin installed in %s; restarting", slot->label);
  vTaskDelay(pdMS_TO_TICKS(2000));
  esp_restart();
}
