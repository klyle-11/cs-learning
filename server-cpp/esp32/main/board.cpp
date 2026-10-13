// The board-specific part of the hub, for the LilyGO T3-S3 V1.3 (board_pins.h:
// ESP32-S3, 2 MB PSRAM, a BOOT button), with a microSD slot on SPI and a 0.96"
// SSD1306 OLED on I2C. It brings up what the server needs and then
// runs the small store server (the browser does the application work):
//
//   /sdcard/hub   the documents (what `hubd <folder>` is given on a computer).
//                 A FAT32 card of up to 32 GB; the server lets the folder fill
//                 it, keeping 16 MB free.
//   /sdcard/hub/www   the page: index.html, app.js, local.js, vault.js, trust.html,
//                 trust.js and vendor/{marked,highlight,purify}.js. The server
//                 leaves this folder out of the document list.
//   /sdcard/wifi.txt  Wi-Fi settings, read once at start-up, kept in the
//                 board's flash and then deleted from the card (read_wifi_file)
//   /state        the certificate, in the board's own flash. The salted
//   NVS           password hash. Taking the card hands over neither secret.
//
// Whatever goes wrong at start-up is said on the screen and tried again, rather
// than the board sitting silent: no card, no Wi-Fi, a server that cannot start.
//
// Builds with ESP-IDF (idf.py, see ../CMakeLists.txt) and with PlatformIO
// (../platformio.ini). Not yet run on a board.
#include <cctype>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <sys/time.h>

#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_pthread.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_vfs_fat.h"
#include "diskio_sdmmc.h" // after esp_vfs_fat.h, which brings the FatFS types it uses
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdmmc_cmd.h"
#include "mbedtls/pkcs5.h"
#if __has_include("mdns.h")
#include "mdns.h" // the espressif/mdns component (main/idf_component.yml; Arduino-ESP32 has it built in)
#define HUB_MDNS 1
#endif

#include <thread>

#include "driver/gpio.h"
#include "esp_attr.h"

#include "board_pins.h"
#include "fs.hpp"
#include "screen.h"
#include "secure.hpp"
#include "status.hpp"
#include "update.h"
#include "version.h"

int store_main(int argc, char **argv);

// Build-time settings: from `idf.py menuconfig` (Hub), or for PlatformIO from
// the HUB_* environment variables (../platformio.ini). Wi-Fi given here is only
// the fallback: wifi.txt on the card replaces it without rebuilding.
#ifndef CONFIG_HUB_WIFI_SSID
#define CONFIG_HUB_WIFI_SSID HUB_WIFI_SSID
#define CONFIG_HUB_WIFI_PASSWORD HUB_WIFI_PASSWORD
#endif
#ifndef CONFIG_HUB_PORT
#define CONFIG_HUB_PORT 443
#endif
#ifndef CONFIG_HUB_NAME
#define CONFIG_HUB_NAME "hub"
#endif

static const char *TAG = "hub";
static const char CARD[] = "/sdcard";
static EventGroupHandle_t wifi_events;
static const EventBits_t GOT_IP = 1;
static char ip_text[16] = "";
static char name_text[32] = CONFIG_HUB_NAME;
static bool had_ip = false;

// The store owns the password protocol; the board owns its durable secret.
// Only the salt and derived value enter NVS. The one-time set-up code exists
// in RAM and changes after five wrong attempts, so it also changes at restart.
static std::mutex password_lock;
static char setup_code[7] = "";
static unsigned setup_misses = 0;
static bool has_password = false;
static constexpr size_t PASSWORD_SALT_BYTES = 16;
static constexpr size_t PASSWORD_HASH_BYTES = 32;
static constexpr unsigned PASSWORD_ROUNDS = 10000;

static bool nvs_blob(const char *key, unsigned char *out, size_t expected) {
  nvs_handle_t h;
  size_t size = expected;
  if (nvs_open("hub", NVS_READONLY, &h) != ESP_OK) return false;
  const esp_err_t err = nvs_get_blob(h, key, out, &size);
  nvs_close(h);
  return err == ESP_OK && size == expected;
}

static bool password_hash(const char *password, const unsigned char salt[PASSWORD_SALT_BYTES], unsigned char out[PASSWORD_HASH_BYTES]) {
  if (!password) return false;
  const size_t size = std::strlen(password);
  if (size < 8 || size > 128) return false;
  return mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, reinterpret_cast<const unsigned char *>(password), size,
                                       salt, PASSWORD_SALT_BYTES, PASSWORD_ROUNDS, PASSWORD_HASH_BYTES, out) == 0;
}

static void new_setup_code() {
  // Six decimal digits are deliberately easy to type from the small screen.
  std::snprintf(setup_code, sizeof setup_code, "%06u", static_cast<unsigned>(esp_random() % 1000000));
  setup_misses = 0;
  ESP_LOGW(TAG, "password not set; setup code: %s", setup_code);
}

static void password_start(bool clear) {
  std::lock_guard<std::mutex> g(password_lock);
  if (clear) {
    nvs_handle_t h;
    if (nvs_open("hub", NVS_READWRITE, &h) == ESP_OK) {
      nvs_erase_key(h, "pass_salt");
      nvs_erase_key(h, "pass_hash");
      nvs_commit(h);
      nvs_close(h);
      ESP_LOGW(TAG, "BOOT held: access password cleared");
    }
  }
  unsigned char salt[PASSWORD_SALT_BYTES], hash[PASSWORD_HASH_BYTES];
  if (nvs_blob("pass_salt", salt, sizeof salt) && nvs_blob("pass_hash", hash, sizeof hash)) {
    has_password = true;
    setup_code[0] = '\0';
  } else {
    has_password = false;
    new_setup_code();
  }
}

extern "C" bool board_store_password_is_set() {
  std::lock_guard<std::mutex> g(password_lock);
  return has_password;
}

extern "C" bool board_store_check_password(const char *password) {
  std::lock_guard<std::mutex> g(password_lock);
  unsigned char salt[PASSWORD_SALT_BYTES], expected[PASSWORD_HASH_BYTES], got[PASSWORD_HASH_BYTES];
  if (!nvs_blob("pass_salt", salt, sizeof salt) || !nvs_blob("pass_hash", expected, sizeof expected) || !password_hash(password, salt, got)) return false;
  unsigned different = 0;
  for (size_t i = 0; i < sizeof got; i++) different |= static_cast<unsigned>(got[i] ^ expected[i]);
  return different == 0;
}

extern "C" bool board_store_set_password(const char *password) {
  std::lock_guard<std::mutex> g(password_lock);
  unsigned char salt[PASSWORD_SALT_BYTES], hash[PASSWORD_HASH_BYTES];
  esp_fill_random(salt, sizeof salt);
  if (!password_hash(password, salt, hash)) return false;
  nvs_handle_t h;
  if (nvs_open("hub", NVS_READWRITE, &h) != ESP_OK) return false;
  esp_err_t err = nvs_set_blob(h, "pass_salt", salt, sizeof salt);
  if (err == ESP_OK) err = nvs_set_blob(h, "pass_hash", hash, sizeof hash);
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  if (err != ESP_OK) return false;
  has_password = true;
  setup_code[0] = '\0';
  setup_misses = 0;
  ESP_LOGI(TAG, "access password stored as PBKDF2-SHA256 (%u rounds)", PASSWORD_ROUNDS);
  return true;
}

extern "C" const char *board_store_setup_code() {
  static thread_local char shown[sizeof setup_code];
  std::lock_guard<std::mutex> g(password_lock);
  std::memcpy(shown, setup_code, sizeof shown);
  return shown;
}

extern "C" void board_store_bad_setup_code() {
  std::lock_guard<std::mutex> g(password_lock);
  if (++setup_misses >= 5) new_setup_code();
}

extern "C" const char *board_ip() { return ip_text[0] ? ip_text : nullptr; }
extern "C" const char *board_name() { return name_text[0] ? name_text : nullptr; }

// The card's drive as FatFS names it ("1:"; the state partition is mounted first).
// The server reads the card's folders and large files with FatFS itself (see
// ../../src/fs.hpp), so it needs to turn a path into the drive's own form:
// "/sdcard/hub/a.md" -> "1:/hub/a.md".
static char card_drive[4] = "";
extern "C" bool board_fat_path(const char *path, char *out, size_t size) {
  const size_t m = sizeof CARD - 1;
  if (!card_drive[0] || std::strncmp(path, CARD, m) != 0 || (path[m] != '/' && path[m] != '\0')) return false;
  int n = std::snprintf(out, size, "%s%s", card_drive, path[m] ? path + m : "/");
  return n > 0 && static_cast<size_t>(n) < size;
}

static void on_event(void *, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    // Why, on the serial console: 201 the network was not found, 2 and 15 the password or the handshake, 8 the router
    // let it go, 200 beacons stopped arriving (out of range); a weak signal shows as many of the last.
    ESP_LOGW(TAG, "Wi-Fi lost (reason %d)", static_cast<int>(static_cast<wifi_event_sta_disconnected_t *>(data)->reason));
    xEventGroupClearBits(wifi_events, GOT_IP);
    if (had_ip) screen_alert("Wi-Fi lost: rejoining");
    vTaskDelay(pdMS_TO_TICKS(1000)); // not in a tight loop while the router is away
    esp_wifi_connect();
  }
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    auto *got = static_cast<ip_event_got_ip_t *>(data);
    std::snprintf(ip_text, sizeof ip_text, IPSTR, IP2STR(&got->ip_info.ip));
    // How well it hears the router: above -60 dBm is good, -70 workable, below -75 slow and unreliable.
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) ESP_LOGI(TAG, "Wi-Fi: %s, signal %d dBm, channel %d", ip_text, ap.rssi, ap.primary);
    had_ip = true;
    screen_alert(nullptr);
    xEventGroupSetBits(wifi_events, GOT_IP);
  }
}

// /sdcard/wifi.txt, if there is one:
//   ssid=Home network
//   password=its password
//   name=hub            (optional: the board is then hub.local on the network)
// The network goes into the board's own flash (the Wi-Fi driver keeps it there)
// and the name into NVS; then the file is deleted, so the password does not
// stay on a card that is often taken out and put in other computers. The card's
// top folder is outside what the server shows (/sdcard/hub), so it is never served.
static bool read_wifi_file(wifi_config_t &wc) {
  const std::string path = std::string(CARD) + "/wifi.txt";
  FILE *f = std::fopen(path.c_str(), "r");
  if (!f) return false;
  char line[160];
  bool any = false;
  while (std::fgets(line, sizeof line, f)) {
    line[std::strcspn(line, "\r\n")] = '\0';
    char *eq = std::strchr(line, '=');
    if (!eq) continue;
    *eq = '\0';
    const char *key = line, *value = eq + 1;
    if (!std::strcmp(key, "ssid")) {
      std::memset(wc.sta.ssid, 0, sizeof wc.sta.ssid);
      std::strncpy(reinterpret_cast<char *>(wc.sta.ssid), value, sizeof wc.sta.ssid - 1);
      any = true;
    } else if (!std::strcmp(key, "password")) {
      std::memset(wc.sta.password, 0, sizeof wc.sta.password);
      std::strncpy(reinterpret_cast<char *>(wc.sta.password), value, sizeof wc.sta.password - 1);
    } else if (!std::strcmp(key, "name") && value[0]) {
      nvs_handle_t h;
      if (nvs_open("hub", NVS_READWRITE, &h) == ESP_OK) { nvs_set_str(h, "name", value); nvs_commit(h); nvs_close(h); }
    }
  }
  std::fclose(f);
  std::remove(path.c_str());
  return any;
}

static void load_name() {
  nvs_handle_t h;
  size_t len = sizeof name_text;
  if (nvs_open("hub", NVS_READONLY, &h) == ESP_OK) { nvs_get_str(h, "name", name_text, &len); nvs_close(h); }
  // A host name: letters, digits and hyphens.
  for (char *c = name_text; *c; c++) if (!std::isalnum(static_cast<unsigned char>(*c)) && *c != '-') *c = '-';
}

static bool start_wifi() {
  wifi_events = xEventGroupCreate();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_t *sta = esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, nullptr));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  wifi_config_t wc = {};
  esp_wifi_get_config(WIFI_IF_STA, &wc); // what an earlier wifi.txt left in flash
  const bool from_card = read_wifi_file(wc);
  if (!wc.sta.ssid[0] && CONFIG_HUB_WIFI_SSID[0]) {
    std::strncpy(reinterpret_cast<char *>(wc.sta.ssid), CONFIG_HUB_WIFI_SSID, sizeof wc.sta.ssid - 1);
    std::strncpy(reinterpret_cast<char *>(wc.sta.password), CONFIG_HUB_WIFI_PASSWORD, sizeof wc.sta.password - 1);
  }
  if (!wc.sta.ssid[0]) return false;
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
  load_name();
  esp_netif_set_hostname(sta, name_text); // what the router lists it as (and, on many, can be reached by)
  ESP_ERROR_CHECK(esp_wifi_start());
  // Keep the radio awake. By default it sleeps between the router's beacons and wakes for them, which saves power and
  // adds a few hundred milliseconds to every request the board receives, and drops its throughput: wrong for a
  // board that is there to answer.
  esp_wifi_set_ps(WIFI_PS_NONE);
  char ssid[33] = "";
  std::memcpy(ssid, wc.sta.ssid, sizeof wc.sta.ssid);
  screen_say(from_card ? "Wi-Fi from wifi.txt:" : "Joining Wi-Fi:", ssid);
  // Wait for an address, saying so on the screen if it takes long.
  for (int waited = 0; !(xEventGroupWaitBits(wifi_events, GOT_IP, pdFALSE, pdTRUE, pdMS_TO_TICKS(5000)) & GOT_IP); waited += 5)
    if (waited == 20) screen_say("Wi-Fi not joined:", ssid, "check wifi.txt");
  ESP_LOGI(TAG, "Wi-Fi up: %s (%s)", ip_text, name_text);
#ifdef HUB_MDNS
  // name.local: found by phones and computers on the same network without knowing the address.
  if (mdns_init() == ESP_OK) {
    mdns_hostname_set(name_text);
    mdns_instance_name_set("Learner-servr");
    mdns_service_add(nullptr, "_https", "_tcp", CONFIG_HUB_PORT, nullptr, 0);
    char shown[40];
    std::snprintf(shown, sizeof shown, "%s.local", name_text);
    screen_name(shown);
  }
#endif
  return true;
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

// The store needs one leaf certificate, not the full server's private
// certificate authority. Keep the first matching pair for the life of the
// board; a power cut between the two durable writes is detected and repaired.
static bool ensure_store_certificate() {
  const std::string cert_path = "/state/cert.pem", key_path = "/state/key.pem";
  std::string cert_pem, key_pem;
  secure::Key key;
  mbedtls_x509_crt cert;
  mbedtls_x509_crt_init(&cert);
  bool have = secure::slurp(cert_path, cert_pem) && secure::slurp(key_path, key_pem) && key.load(key_pem) &&
              secure::parse_certs(&cert, cert_pem) == 0 &&
              mbedtls_pk_check_pair(&cert.pk, &key.pk, secure::rng_cb, nullptr) == 0;
  mbedtls_x509_crt_free(&cert);
  if (have) return true;

  secure::Key fresh;
  if (!fresh.generate()) return false;
  std::vector<std::string> names;
  if (name_text[0]) names.push_back(std::string(name_text) + ".local");
  if (ip_text[0]) names.push_back(ip_text);
  std::string err;
  cert_pem = secure::write_cert(fresh, fresh, "CN=Hub store,O=Hub", "CN=Hub store,O=Hub", -1, 3650, names, {}, err);
  key_pem = fresh.pem();
  if (cert_pem.empty() || key_pem.empty() || !secure::spit(key_path, key_pem, 0600) || !secure::spit(cert_path, cert_pem, 0644)) {
    ESP_LOGE(TAG, "cannot make the store certificate: %s", err.c_str());
    return false;
  }
  ESP_LOGI(TAG, "made the store certificate; SHA-256 %s", secure::fingerprint(cert_pem).c_str());
  return true;
}

static bool mount_state() {
  // Each file that may be open at once costs a slot made at mount time, and
  // with ESP-IDF's per-file cache each slot holds a sector buffer of its own
  // (4 KB here, because the state partition uses 4 KB sectors). The state
  // partition is a few small files read at start and rarely written.
  esp_vfs_fat_mount_config_t mount = {};
  mount.max_files = 3;
  mount.format_if_mount_failed = true; // the state partition is formatted on first boot
  wl_handle_t wl;
  return esp_vfs_fat_spiflash_mount_rw_wl("/state", "state", &mount, &wl) == ESP_OK;
}

static bool mount_card() {
  static bool bus_ready = false;
  sdmmc_host_t host = SDSPI_HOST_DEFAULT();
  if (!bus_ready) {
    spi_bus_config_t bus = {};
    bus.mosi_io_num = SD_MOSI;
    bus.miso_io_num = SD_MISO;
    bus.sclk_io_num = SD_CLK;
    bus.quadwp_io_num = bus.quadhd_io_num = -1;
    bus.max_transfer_sz = 4000;
    if (spi_bus_initialize(static_cast<spi_host_device_t>(host.slot), &bus, SDSPI_DEFAULT_DMA) != ESP_OK) return false;
    bus_ready = true;
  }
  sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
  slot.gpio_cs = static_cast<gpio_num_t>(SD_CS);
  slot.host_id = static_cast<spi_host_device_t>(host.slot);
  esp_vfs_fat_mount_config_t mount = {};
  mount.format_if_mount_failed = false; // never format the card: it holds the documents
  // On the card: an upload, a notes or settings save and a title being read can
  // be open together, on each of the 4 connections at most. Files being sent
  // are opened through FatFS directly and take no slot.
  mount.max_files = 6;
  sdmmc_card_t *card = nullptr;
  if (esp_vfs_fat_sdspi_mount(CARD, &host, &slot, &mount, &card) != ESP_OK) return false;
  BYTE drive = ff_diskio_get_pdrv_card(card);
  if (drive < 10) { card_drive[0] = static_cast<char>('0' + drive); card_drive[1] = ':'; card_drive[2] = '\0'; }
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 1, 0)
  // FatFS then asks the card whether it is still there before each use, so a
  // card pulled out gives clean errors (and watch_task notices).
  if (drive < 10) ff_sdmmc_set_disk_status_check(drive, true);
#endif
  ESP_LOGI(TAG, "card: %llu MB, FatFS drive %s", static_cast<unsigned long long>(card->csd.capacity) * static_cast<unsigned long long>(card->csd.sector_size) >> 20, card_drive);
  return true;
}

// What can go wrong once running. A card taken out: the board restarts and
// waits for one (the server's count of what is stored belongs to the card it
// started with, and FatFS cannot take a new card from under its own feet). And
// a new firmware that has served for a minute is kept.
static void watch_task(void *) {
  int served_for = 0, ticks = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(3000));
    if (++ticks == 100) {
      // After five minutes: how close each task of the board's own came to the
      // end of its stack (sizes chosen by estimate; this is the measurement).
      for (const char *name : {"screen", "watch"})
        if (TaskHandle_t t = xTaskGetHandle(name)) ESP_LOGI(TAG, "stack never used by %s: %u bytes", name, static_cast<unsigned>(uxTaskGetStackHighWaterMark(t)));
      wifi_ap_record_t ap;
      if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) ESP_LOGI(TAG, "Wi-Fi signal %d dBm", ap.rssi);
      ESP_LOGI(TAG, "memory: %u bytes free, the least so far %u, largest block %u", static_cast<unsigned>(esp_get_free_heap_size()),
               static_cast<unsigned>(esp_get_minimum_free_heap_size()), static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    }
    bool dir;
    uint64_t size;
    if (!fs::info(std::string(CARD) + "/hub", dir, size)) {
      ESP_LOGE(TAG, "the SD card is gone; restarting");
      screen_say("SD card removed.", "Restarting...");
      vTaskDelay(pdMS_TO_TICKS(3000));
      esp_restart();
    }
    HubStatus s;
    hub_status(s);
    if (s.running && served_for < 60 && (served_for += 3) >= 60) update_keep();
    if (s.running) hub_tick();   // pages that have gone are let go (there is no watcher on the board to ping them)
  }
}

// The BOOT button (T3-S3): wakes the screen and shows what the board knows of
// itself for a few seconds. Called in an interrupt: it only raises a flag.
static void IRAM_ATTR on_button(void *) { screen_info(); }
static bool configure_button() {
  if (BOARD_BUTTON < 0) return false;
  gpio_config_t io = {};
  io.pin_bit_mask = 1ULL << (BOARD_BUTTON < 0 ? 0 : BOARD_BUTTON); // (the < 0 case returned above; this keeps the compiler quiet on boards without one)
  io.mode = GPIO_MODE_INPUT;
  io.pull_up_en = GPIO_PULLUP_ENABLE;
  io.intr_type = GPIO_INTR_DISABLE;
  if (gpio_config(&io) != ESP_OK) return false;
  vTaskDelay(pdMS_TO_TICKS(20));
  return gpio_get_level(static_cast<gpio_num_t>(BOARD_BUTTON)) == 0;
}
static void start_button() {
  if (BOARD_BUTTON < 0) return;
  gpio_set_intr_type(static_cast<gpio_num_t>(BOARD_BUTTON), GPIO_INTR_NEGEDGE);
  esp_err_t isr = gpio_install_isr_service(0);
  if (isr == ESP_OK || isr == ESP_ERR_INVALID_STATE) gpio_isr_handler_add(static_cast<gpio_num_t>(BOARD_BUTTON), on_button, nullptr);
}

static void start() {
  esp_err_t nvs = nvs_flash_init();
  if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
  const bool clear_password = configure_button();
  screen_start();
  password_start(clear_password);
  start_button();
  ESP_LOGI(TAG, "LilyGO %s, version %d", BOARD_NAME, HUB_VERSION);
  char version[22];
  std::snprintf(version, sizeof version, "version %d", HUB_VERSION);
  screen_say("Starting...", version);

  if (!mount_state()) {
    ESP_LOGE(TAG, "cannot mount the state partition");
    update_give_up();
    screen_say("Flash storage failed.", "Reflash by USB", "(see README).");
    return;
  }
  while (!mount_card()) {
    ESP_LOGE(TAG, "no SD card, or it is not FAT32");
    screen_say("No SD card found.", "Insert a FAT32 card;", "trying again...");
    vTaskDelay(pdMS_TO_TICKS(5000));
  }
  // A card update is handled before Wi-Fi or the server starts. Success never
  // returns; a bad image is left on the card for inspection and serving starts.
  update_start();
  ::mkdir("/sdcard/hub", 0755); // a fresh card: the folder the documents go in
  {
    bool dir;
    uint64_t size;
    while (!fs::info("/sdcard/hub/www/index.html", dir, size)) {
      ESP_LOGE(TAG, "no /hub/www/index.html on the card: copy the page with `make card`");
      screen_say("No reader page on", "the card: run", "make card (README)");
      vTaskDelay(pdMS_TO_TICKS(5000)); // taking the card out to fix it restarts the board
    }
  }
  screen_say("Card ready.", version);
  if (!start_wifi()) {
    ESP_LOGE(TAG, "no Wi-Fi settings: put wifi.txt on the card");
    screen_say("No Wi-Fi settings.", "Put wifi.txt on the", "card, then restart.");
    return;
  }
  screen_say("Setting the clock...");
  set_clock();
  screen_say("Starting the store.", "(first start: making", "its certificate)");
  if (!ensure_store_certificate()) {
    ESP_LOGE(TAG, "cannot make or load the store certificate");
    update_give_up();
    screen_say("Certificate failed.", "Reflash by USB", "(see serial log).");
    return;
  }

  // Each connection runs on its own thread; a TLS handshake needs more stack
  // than the default. The setting is taken from the thread that creates them,
  // so the server gets a thread of its own (with room for making certificates)
  // and sets it there.
  esp_pthread_cfg_t threads = esp_pthread_get_default_config();
  threads.stack_size = 16 * 1024;
  esp_pthread_set_cfg(&threads);

  static char port[8];
  std::snprintf(port, sizeof port, "%d", CONFIG_HUB_PORT);
  static char *args[] = {(char *)"store", (char *)"/sdcard/hub", (char *)"--www", (char *)"/sdcard/hub/www",
                         (char *)"--host", (char *)"0.0.0.0", (char *)"--port", port, (char *)"--tls",
                         (char *)"--cert", (char *)"/state/cert.pem", (char *)"--key", (char *)"/state/key.pem"};
  try {
    std::thread([] {
      esp_pthread_cfg_t each = esp_pthread_get_default_config();
      each.stack_size = 12 * 1024;
      esp_pthread_set_cfg(&each);
      store_main(sizeof args / sizeof args[0], args); // only returns if it could not start
      ESP_LOGE(TAG, "the server stopped");
      update_give_up(); // a new firmware that cannot serve goes back to the old one
      screen_say("The server stopped.", "Restarting in 30 s", "(serial log: why)");
      vTaskDelay(pdMS_TO_TICKS(30000));
      esp_restart();
    }).detach();
  } catch (...) {
    screen_say("Out of memory at", "start-up.", "Restarting...");
    vTaskDelay(pdMS_TO_TICKS(5000));
    esp_restart();
  }
  // Until the server says it is listening, the start-up message stays.
  for (int i = 0; i < 600; i++) {
    HubStatus s;
    hub_status(s);
    if (s.running) break;
    vTaskDelay(pdMS_TO_TICKS(500));
  }
  screen_say(nullptr);
  ESP_LOGI(TAG, "version %d serving at %s (%s.local); %u bytes free, largest block %u", HUB_VERSION, ip_text, name_text,
           static_cast<unsigned>(esp_get_free_heap_size()), static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
  if (xTaskCreate(watch_task, "watch", 8192, nullptr, 2, nullptr) != pdPASS) ESP_LOGE(TAG, "no memory for the watch task: a card taken out will not be noticed");
}

#ifdef ARDUINO
// The Arduino core owns app_main and calls these two.
void setup() { start(); }
void loop() { vTaskDelay(portMAX_DELAY); }
#else
extern "C" void app_main() { start(); }
#endif
