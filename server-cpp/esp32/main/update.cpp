// Firmware updates, pulled from the GitHub releases of the repository set in
// menuconfig (Hub > "Repository with firmware releases"), checked two minutes
// after start-up and then every HUB_UPDATE_HOURS.
//
// What makes it safe to install by itself:
//  - Signed. Each release carries, for each kind of chip, hub-firmware-CHIP.json
//    (CHIP: esp32 for the T3 V1.6.1, esp32s3 for the T3-S3): the chip, the
//    version, the image's SHA-256, and an ECDSA P-256 signature over all three, made on your computer
//    (tools/release.sh) with a key that never leaves it. The board holds only
//    the public half (update_key.h). Someone who takes over the GitHub account
//    or the connection can serve anything, but cannot make the board accept it.
//  - Only forward. The version is inside the signature and must be higher than
//    the running one, so an older release, signed but with known faults,
//    cannot be sent back.
//  - Undoable. The image goes to the other app slot (partitions.csv); the
//    running one stays. After restarting into the new one, the board keeps it
//    only once the server has been up for a minute (update_keep); if it crashes
//    or cannot start first, the bootloader goes back to the old one
//    (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE, ESP-IDF build).
//  - Considerate. It waits until nobody is being served and memory is plentiful:
//    a TLS connection out to GitHub needs about 40 KB.
//
// The connection is HTTPS, checked against ESP-IDF's bundle of root
// certificates; the signature is what decides, the TLS check is a second wall.
#include "update.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"

#include "cJSON.h"
#include "screen.h"
#include "status.hpp"
#include "update_key.h"
#include "version.h"

#ifndef CONFIG_HUB_UPDATE_REPO
#ifdef HUB_UPDATE_REPO
#define CONFIG_HUB_UPDATE_REPO HUB_UPDATE_REPO
#else
#define CONFIG_HUB_UPDATE_REPO ""
#endif
#endif
#ifndef CONFIG_HUB_UPDATE_HOURS
#define CONFIG_HUB_UPDATE_HOURS 24
#endif

static const char *TAG = "update";
using std::string;

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
    esp_ota_mark_app_invalid_rollback_and_reboot(); // returns only if there is nothing to go back to
  }
}

// An HTTPS GET, following GitHub's redirects to where release files are kept.
// Leaves the client open at the start of the body; null if it did not get there.
static esp_http_client_handle_t open_url(const string &url, int64_t &length) {
  esp_http_client_config_t cfg = {};
  cfg.url = url.c_str();
  cfg.crt_bundle_attach = esp_crt_bundle_attach;
  cfg.timeout_ms = 20000;
  cfg.buffer_size = 4096;     // GitHub's redirect headers are long
  cfg.buffer_size_tx = 1024;
  cfg.max_redirection_count = 5;
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (!c) return nullptr;
  for (int hop = 0; hop < 6; hop++) {
    if (esp_http_client_open(c, 0) != ESP_OK) break;
    length = esp_http_client_fetch_headers(c);
    int status = esp_http_client_get_status_code(c);
    if (status == 200) return c;
    if (status < 300 || status >= 400 || esp_http_client_set_redirection(c) != ESP_OK) { ESP_LOGW(TAG, "%s: HTTP %d", url.c_str(), status); break; }
    esp_http_client_flush_response(c, nullptr);
    esp_http_client_close(c);
  }
  esp_http_client_cleanup(c);
  return nullptr;
}

// Whether `signature` (base64, DER) is the release key's over `message`.
static bool signed_by_us(const string &message, const string &signature) {
  if (!UPDATE_KEY_PEM[0]) return false;
  unsigned char sig[160], hash[32];
  size_t sig_len = 0;
  if (mbedtls_base64_decode(sig, sizeof sig, &sig_len, reinterpret_cast<const unsigned char *>(signature.data()), signature.size()) != 0) return false;
  if (mbedtls_sha256(reinterpret_cast<const unsigned char *>(message.data()), message.size(), hash, 0) != 0) return false;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  int rc = mbedtls_pk_parse_public_key(&key, reinterpret_cast<const unsigned char *>(UPDATE_KEY_PEM), sizeof UPDATE_KEY_PEM);
  if (rc == 0) rc = mbedtls_pk_verify(&key, MBEDTLS_MD_SHA256, hash, sizeof hash, sig, sig_len);
  mbedtls_pk_free(&key);
  return rc == 0;
}

static string hex(const unsigned char *p, size_t n) {
  static const char digits[] = "0123456789abcdef";
  string out;
  for (size_t i = 0; i < n; i++) { out += digits[p[i] >> 4]; out += digits[p[i] & 15]; }
  return out;
}

// One look for a newer release, and its installation. Returns only if there
// was nothing to install or it could not be installed.
static void check_once() {
  const string repo = CONFIG_HUB_UPDATE_REPO, base = "https://github.com/" + repo + "/releases";
  int64_t length = 0;
  const string chip = CONFIG_IDF_TARGET; // "esp32", "esp32s3": a release has an image for each
  esp_http_client_handle_t c = open_url(base + "/latest/download/hub-firmware-" + chip + ".json", length);
  if (!c) { ESP_LOGW(TAG, "no release information from %s", repo.c_str()); return; }
  char text[1024];
  int got = 0, n;
  while (got < static_cast<int>(sizeof text) - 1 && (n = esp_http_client_read(c, text + got, sizeof text - 1 - got)) > 0) got += n;
  text[got] = '\0';
  esp_http_client_close(c);
  esp_http_client_cleanup(c);

  cJSON *m = cJSON_Parse(text);
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(m, "version"), *f = cJSON_GetObjectItemCaseSensitive(m, "file"),
              *s = cJSON_GetObjectItemCaseSensitive(m, "size"), *h = cJSON_GetObjectItemCaseSensitive(m, "sha256"), *g = cJSON_GetObjectItemCaseSensitive(m, "signature");
  if (!cJSON_IsNumber(v) || !cJSON_IsString(f) || !cJSON_IsNumber(s) || !cJSON_IsString(h) || !cJSON_IsString(g)) { ESP_LOGW(TAG, "hub-firmware.json is not as expected"); cJSON_Delete(m); return; }
  const int version = v->valueint;
  const int64_t size = static_cast<int64_t>(s->valuedouble);
  const string file = f->valuestring, sha = h->valuestring, sig = g->valuestring;
  cJSON_Delete(m);
  if (version <= HUB_VERSION) { ESP_LOGI(TAG, "version %d is the latest", HUB_VERSION); return; }
  // The signed sentence. Changing any of it (another chip's image, a different version, a different image) breaks the signature.
  const string message = "hub-firmware " + chip + " " + std::to_string(version) + " " + sha;
  if (!signed_by_us(message, sig)) { ESP_LOGE(TAG, "release %d is not signed by this board's release key: not installed", version); return; }
  const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
  if (!slot || size <= 0 || size > static_cast<int64_t>(slot->size)) { ESP_LOGE(TAG, "release %d does not fit the update slot", version); return; }
  if (file.empty() || file.find_first_of("/\\?#%") != string::npos) { ESP_LOGE(TAG, "release %d names an odd file", version); return; }

  ESP_LOGI(TAG, "installing version %d (%lld bytes)", version, static_cast<long long>(size));
  c = open_url(base + "/download/v" + std::to_string(version) + "/" + file, length);
  if (!c) return;
  esp_ota_handle_t ota = 0;
  if (esp_ota_begin(slot, static_cast<size_t>(size), &ota) != ESP_OK) { esp_http_client_cleanup(c); return; }
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  static char piece[4096];
  int64_t done = 0;
  bool ok = true;
  screen_progress(0);
  while (ok && done < size) {
    n = esp_http_client_read(c, piece, static_cast<int>(std::min<int64_t>(sizeof piece, size - done)));
    if (n <= 0) { ok = false; break; }
    mbedtls_sha256_update(&ctx, reinterpret_cast<unsigned char *>(piece), static_cast<size_t>(n));
    ok = esp_ota_write(ota, piece, static_cast<size_t>(n)) == ESP_OK;
    done += n;
    screen_progress(static_cast<int>(done * 100 / size));
  }
  esp_http_client_close(c);
  esp_http_client_cleanup(c);
  unsigned char digest[32];
  mbedtls_sha256_finish(&ctx, digest);
  mbedtls_sha256_free(&ctx);
  if (!ok || done != size || hex(digest, sizeof digest) != sha) {
    ESP_LOGE(TAG, "download of version %d %s: not installed", version, ok && done == size ? "does not match its signature" : "was cut short");
    esp_ota_abort(ota);
    screen_progress(-1);
    return;
  }
  // esp_ota_end checks the image itself (its header and checksum) before it can be started.
  if (esp_ota_end(ota) != ESP_OK || esp_ota_set_boot_partition(slot) != ESP_OK) { ESP_LOGE(TAG, "version %d did not check out as an image", version); screen_progress(-1); return; }
  screen_progress(-1);
  char line[22];
  std::snprintf(line, sizeof line, "Updated to v%d.", version);
  screen_say(line, "Restarting...");
  ESP_LOGI(TAG, "version %d installed; restarting", version);
  vTaskDelay(pdMS_TO_TICKS(2000));
  esp_restart();
}

static void update_task(void *) {
  vTaskDelay(pdMS_TO_TICKS(2 * 60 * 1000)); // let start-up finish, and the first visitors in
  for (;;) {
    // Wait (up to an hour) for a quiet moment with memory to spare.
    for (int i = 0; i < 60 && (hub_busy() > 0 || esp_get_free_heap_size() < 90 * 1024 || heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) < 24 * 1024); i++) vTaskDelay(pdMS_TO_TICKS(60 * 1000));
    check_once();
    vTaskDelay(pdMS_TO_TICKS(static_cast<uint32_t>(CONFIG_HUB_UPDATE_HOURS) * 3600 * 1000));
  }
}

void update_start() {
  if (!CONFIG_HUB_UPDATE_REPO[0] || !UPDATE_KEY_PEM[0]) {
    ESP_LOGI(TAG, "updates off: %s", !UPDATE_KEY_PEM[0] ? "no release key in this build (tools/release.sh)" : "no repository set (menuconfig, Hub)");
    return;
  }
  // 8 KB: a TLS handshake (certificate checks included) runs on this task's stack.
  if (xTaskCreate(update_task, "update", 8192, nullptr, 3, nullptr) != pdPASS) ESP_LOGW(TAG, "no memory for the update task");
}
