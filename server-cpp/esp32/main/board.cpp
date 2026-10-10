// The board-specific part of the hub: LilyGO T3 LoRa32 V1.6.1 (ESP32-PICO-D4,
// 4 MB flash, no extra RAM, microSD on its own SPI pins). Boards sold as V1.6.2,
// and the clones, use the same wiring as far as LilyGO's own pin tables show; if
// the card does not mount, check SD_* below against the board's silkscreen. It
// brings up what the server needs and then runs the same server as on a computer:
//
//   /sdcard/hub   the documents (what `hubd <folder>` is given on a computer).
//                 A FAT32 card of up to 32 GB; the server lets the folder fill
//                 it, keeping 16 MB free.
//   /sdcard/hub/www   the page: index.html, app.js, local.js, vault.js, trust.html,
//                 trust.js and vendor/{marked,highlight,purify}.js. The server
//                 leaves this folder out of the document list.
//   /state        certificates and paired devices, in the board's own flash:
//                 taking the card must not hand over the keys
//
// Builds with PlatformIO (see ../platformio.ini). Not yet run on a board.
#include <cstdio>
#include <cstring>
#include <ctime>
#include <sys/time.h>

#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_pthread.h"
#include "esp_vfs_fat.h"
#include "diskio_sdmmc.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs_flash.h"
#include "sdmmc_cmd.h"

#include <thread>

int hub_main(int argc, char **argv);

// Wi-Fi name, password and port: from `idf.py menuconfig` (ESP-IDF build), or
// from the HUB_WIFI_SSID / HUB_WIFI_PASSWORD environment variables (PlatformIO build).
#ifndef CONFIG_HUB_WIFI_SSID
#define CONFIG_HUB_WIFI_SSID HUB_WIFI_SSID
#define CONFIG_HUB_WIFI_PASSWORD HUB_WIFI_PASSWORD
#endif
#ifndef CONFIG_HUB_PORT
#define CONFIG_HUB_PORT 443
#endif

// microSD on the T3 V1.6.1. GPIO 2 is also a boot-mode pin: if flashing fails
// with the card in, take the card out while flashing.
static const int SD_MOSI = 15, SD_MISO = 2, SD_CLK = 14, SD_CS = 13;

static const char *TAG = "hub";
static const char CARD[] = "/sdcard";
static EventGroupHandle_t wifi_events;
static char ip_text[16] = "";
extern "C" const char *board_ip() { return ip_text[0] ? ip_text : nullptr; }

// The card's drive as FatFS names it ("1:"; the state partition is mounted first).
// The server reads the card's folders and large files with FatFS itself (see
// ../src/fs.hpp), so it needs to turn a path into the drive's own form:
// "/sdcard/hub/a.md" -> "1:/hub/a.md".
static char card_drive[4] = "";
extern "C" bool board_fat_path(const char *path, char *out, size_t size) {
  const size_t m = sizeof CARD - 1;
  if (!card_drive[0] || std::strncmp(path, CARD, m) != 0 || (path[m] != '/' && path[m] != '\0')) return false;
  int n = std::snprintf(out, size, "%s%s", card_drive, path[m] ? path + m : "/");
  return n > 0 && static_cast<size_t>(n) < size;
}

static void on_event(void *, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) esp_wifi_connect();
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    auto *got = static_cast<ip_event_got_ip_t *>(data);
    std::snprintf(ip_text, sizeof ip_text, IPSTR, IP2STR(&got->ip_info.ip));
    xEventGroupSetBits(wifi_events, 1);
  }
}

static void start_wifi() {
  wifi_events = xEventGroupCreate();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, nullptr));
  wifi_config_t wc = {};
  std::strncpy(reinterpret_cast<char *>(wc.sta.ssid), CONFIG_HUB_WIFI_SSID, sizeof wc.sta.ssid - 1);
  std::strncpy(reinterpret_cast<char *>(wc.sta.password), CONFIG_HUB_WIFI_PASSWORD, sizeof wc.sta.password - 1);
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
  ESP_ERROR_CHECK(esp_wifi_start());
  xEventGroupWaitBits(wifi_events, 1, pdFALSE, pdTRUE, portMAX_DELAY);
  ESP_LOGI(TAG, "Wi-Fi up: %s", ip_text);
}

// Certificates carry dates, so the board needs to know today's. Ask the
// network; if nobody answers (no internet), fall back to the day this program
// was built, which is at least not 1970.
static void set_clock() {
  esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  esp_netif_sntp_init(&cfg);
  if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(10000)) == ESP_OK) return;
  struct tm built = {};
  if (strptime(__DATE__ " " __TIME__, "%b %d %Y %H:%M:%S", &built)) {
    struct timeval tv = {mktime(&built), 0};
    settimeofday(&tv, nullptr);
    ESP_LOGW(TAG, "no time from the network; using the build date");
  }
}

static bool mount_storage() {
  // Each file that may be open at once costs a slot made at mount time, and
  // with ESP-IDF's per-file cache each slot holds a sector buffer of its own
  // (4 KB here, because the state partition uses 4 KB sectors). The state
  // partition is a few small files read at start and rarely written.
  esp_vfs_fat_mount_config_t mount = {};
  mount.max_files = 3;
  mount.format_if_mount_failed = true; // the state partition is formatted on first boot
  wl_handle_t wl;
  if (esp_vfs_fat_spiflash_mount_rw_wl("/state", "state", &mount, &wl) != ESP_OK) { ESP_LOGE(TAG, "cannot mount the state partition"); return false; }

  sdmmc_host_t host = SDSPI_HOST_DEFAULT();
  spi_bus_config_t bus = {};
  bus.mosi_io_num = SD_MOSI;
  bus.miso_io_num = SD_MISO;
  bus.sclk_io_num = SD_CLK;
  bus.quadwp_io_num = bus.quadhd_io_num = -1;
  bus.max_transfer_sz = 4000;
  if (spi_bus_initialize(static_cast<spi_host_device_t>(host.slot), &bus, SDSPI_DEFAULT_DMA) != ESP_OK) return false;
  sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
  slot.gpio_cs = static_cast<gpio_num_t>(SD_CS);
  slot.host_id = static_cast<spi_host_device_t>(host.slot);
  mount.format_if_mount_failed = false; // never format the card: it holds the documents
  // On the card: an upload, a notes or settings save and a title being read can
  // be open together, on each of the 4 connections at most. Files being sent
  // are opened through FatFS directly and take no slot.
  mount.max_files = 6;
  sdmmc_card_t *card;
  if (esp_vfs_fat_sdspi_mount(CARD, &host, &slot, &mount, &card) != ESP_OK) { ESP_LOGE(TAG, "no SD card, or it is not FAT32"); return false; }
  BYTE drive = ff_diskio_get_pdrv_card(card);
  if (drive < 10) { card_drive[0] = static_cast<char>('0' + drive); card_drive[1] = ':'; card_drive[2] = '\0'; }
  ESP_LOGI(TAG, "card: %llu MB, FatFS drive %s", static_cast<unsigned long long>(card->csd.capacity) * card->csd.sector_size >> 20, card_drive);
  return true;
}

static void start() {
  esp_err_t nvs = nvs_flash_init();
  if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
  if (!mount_storage()) return;
  start_wifi();
  set_clock();

  // Each connection runs on its own thread; a TLS handshake needs more stack
  // than the default. The setting is taken from the thread that creates them,
  // so the server gets a thread of its own (with room for making certificates)
  // and sets it there.
  esp_pthread_cfg_t threads = esp_pthread_get_default_config();
  threads.stack_size = 16 * 1024;
  esp_pthread_set_cfg(&threads);

  static char port[8];
  std::snprintf(port, sizeof port, "%d", CONFIG_HUB_PORT);
  static char *args[] = {(char *)"hubd", (char *)"/sdcard/hub", (char *)"--www", (char *)"/sdcard/hub/www", (char *)"--state", (char *)"/state",
                         (char *)"--host", (char *)"0.0.0.0", (char *)"--port", port};
  std::thread([] {
    esp_pthread_cfg_t each = esp_pthread_get_default_config();
    each.stack_size = 12 * 1024;
    esp_pthread_set_cfg(&each);
    hub_main(sizeof args / sizeof args[0], args); // only returns if it could not start
    ESP_LOGE(TAG, "the server stopped");
  }).detach();
}

#ifdef ARDUINO
// The Arduino core owns app_main and calls these two.
void setup() { start(); }
void loop() { vTaskDelay(portMAX_DELAY); }
#else
extern "C" void app_main() { start(); }
#endif
