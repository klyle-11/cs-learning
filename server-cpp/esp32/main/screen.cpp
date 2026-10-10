// The board's 0.96" OLED: an SSD1306, 128 x 64, on I2C at 0x3C or 0x3D (pins in
// board_pins.h: SDA 21 / SCL 22 on the T3 V1.6.1, 18 / 17 on the T3-S3). Neither
// board wires a reset pin to it (GPIO16, used for that on other boards, belongs
// to the T3 V1.6.1's own flash). Some clones carry an SH1106 instead: set
// "OLED is an SH1106" in menuconfig (Hub).
//
// A task of its own, below the server in priority, draws the screen every
// 80 ms (screen_draw.hpp) and sends the display only the bytes that changed
// since the last frame: usually the star, a few dozen bytes, where the whole
// screen is a kilobyte (about 25 ms of the bus at 400 kHz).
#include "screen.h"

#include <cstdio>
#include <cstring>
#include <mutex>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "board_pins.h"
#include "screen_draw.hpp"
#include "version.h"

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 2, 0)
#include "driver/i2c_master.h"
#define HUB_I2C_NEW 1
#else
#include "driver/i2c.h"
#endif

static const char *TAG = "screen";
static const int SDA = OLED_SDA, SCL = OLED_SCL;
static volatile bool info_wanted = false;

static std::mutex view_lock;
static BoardView view;            // what the board has asked to show
static bool present = false;

#ifdef CONFIG_HUB_OLED_SH1106
static const uint8_t COLUMN_OFFSET = 2; // the SH1106 has 132 columns; the glass shows the middle 128
#else
static const uint8_t COLUMN_OFFSET = 0;
#endif

// ---- the bus ---------------------------------------------------------------------------

#ifdef HUB_I2C_NEW
static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t dev;
static bool bus_open(uint8_t &address) {
  i2c_master_bus_config_t cfg = {};
  cfg.i2c_port = -1;
  cfg.sda_io_num = static_cast<gpio_num_t>(SDA);
  cfg.scl_io_num = static_cast<gpio_num_t>(SCL);
  cfg.clk_source = I2C_CLK_SRC_DEFAULT;
  cfg.glitch_ignore_cnt = 7;
  cfg.flags.enable_internal_pullup = 1; // the module has its own; these do no harm
  if (i2c_new_master_bus(&cfg, &bus) != ESP_OK) return false;
  for (uint8_t a : {0x3C, 0x3D}) {
    if (i2c_master_probe(bus, a, 50) != ESP_OK) continue;
    i2c_device_config_t d = {};
    d.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    d.device_address = a;
    d.scl_speed_hz = 400000;
    if (i2c_master_bus_add_device(bus, &d, &dev) != ESP_OK) return false;
    address = a;
    return true;
  }
  return false;
}
static bool bus_send(const uint8_t *data, size_t len) { return i2c_master_transmit(dev, data, len, 100) == ESP_OK; }
#else
// The I2C driver ESP-IDF had before 5.2 (Arduino-ESP32 2.x and 3.0).
static uint8_t addr = 0;
static bool bus_open(uint8_t &address) {
  i2c_config_t cfg = {};
  cfg.mode = I2C_MODE_MASTER;
  cfg.sda_io_num = SDA;
  cfg.scl_io_num = SCL;
  cfg.sda_pullup_en = GPIO_PULLUP_ENABLE;
  cfg.scl_pullup_en = GPIO_PULLUP_ENABLE;
  cfg.master.clk_speed = 400000;
  if (i2c_param_config(I2C_NUM_0, &cfg) != ESP_OK || i2c_driver_install(I2C_NUM_0, I2C_MODE_MASTER, 0, 0, 0) != ESP_OK) return false;
  for (uint8_t a : {0x3C, 0x3D}) {
    uint8_t nop[2] = {0x00, 0xE3};
    if (i2c_master_write_to_device(I2C_NUM_0, a, nop, sizeof nop, pdMS_TO_TICKS(50)) == ESP_OK) { addr = address = a; return true; }
  }
  return false;
}
static bool bus_send(const uint8_t *data, size_t len) { return i2c_master_write_to_device(I2C_NUM_0, addr, data, len, pdMS_TO_TICKS(100)) == ESP_OK; }
#endif

// Commands go after a 0x00 byte, pixels after 0x40.
static bool command(std::initializer_list<uint8_t> bytes) {
  uint8_t buf[32] = {0x00};
  size_t n = 1;
  for (uint8_t b : bytes) if (n < sizeof buf) buf[n++] = b;
  return bus_send(buf, n);
}

static bool display_init() {
#ifdef CONFIG_HUB_OLED_FLIP
  const uint8_t seg = 0xA0, com = 0xC0; // mounted the other way up
#else
  const uint8_t seg = 0xA1, com = 0xC8;
#endif
#ifdef CONFIG_HUB_OLED_SH1106
  return command({0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0xAD, 0x8B, seg, com, 0xDA, 0x12, 0x81, 0x80, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF});
#else
  // Page addressing (0x20 0x02), the mode both controllers share, so one way of sending pixels serves both.
  return command({0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x02, seg, com, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0x2E, 0xAF});
#endif
}

// Send the columns of each 8-pixel row that differ from what the display holds.
static bool flush(const Canvas &now, Canvas &shown, bool all) {
  for (int page = 0; page < 8; page++) {
    const uint8_t *a = now.px + page * Canvas::W, *b = shown.px + page * Canvas::W;
    int first = 0, last = Canvas::W - 1;
    if (!all) {
      while (first < Canvas::W && a[first] == b[first]) first++;
      if (first == Canvas::W) continue;
      while (a[last] == b[last]) last--;
    }
    const uint8_t col = static_cast<uint8_t>(first + COLUMN_OFFSET);
    if (!command({static_cast<uint8_t>(0xB0 | page), static_cast<uint8_t>(col & 0x0F), static_cast<uint8_t>(0x10 | (col >> 4))})) return false;
    uint8_t buf[Canvas::W + 1] = {0x40};
    const int n = last - first + 1;
    std::memcpy(buf + 1, a + first, static_cast<size_t>(n));
    if (!bus_send(buf, static_cast<size_t>(n) + 1)) return false;
    std::memcpy(shown.px + page * Canvas::W + first, a + first, static_cast<size_t>(n));
  }
  return true;
}

static void screen_task(void *) {
  // Held here rather than on the stack: two kilobytes, and a status of about one.
  static Canvas now, shown;
  static HubStatus status;
  bool all = true;
  int64_t asked = 0, changed_at = esp_timer_get_time();
  bool dim = false;
  uint32_t still_sum = 0;
  int64_t info_until = 0;
  for (unsigned frame = 0;; frame++) {
    const int64_t t = esp_timer_get_time();
    if (t - asked > 500000) { hub_status(status); asked = t; }
    BoardView v;
    { std::lock_guard<std::mutex> g(view_lock); v = view; }
    if (info_wanted) { info_wanted = false; info_until = t + 8000000; changed_at = t; }
    if (t < info_until && !v.say[0][0] && v.progress < 0) { // the button: what the board knows of itself
      const int64_t up = t / 1000000;
      std::snprintf(v.say[0], sizeof v.say[0], "%s  v%d", BOARD_NAME, HUB_VERSION);
      std::snprintf(v.say[1], sizeof v.say[1], "up %lldh %02lldm", static_cast<long long>(up / 3600), static_cast<long long>(up / 60 % 60));
      const unsigned ram = static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024), ext = static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024);
      char mem[48];
      if (ext) std::snprintf(mem, sizeof mem, "RAM %uK PSRAM %uK", ram, ext);
      else std::snprintf(mem, sizeof mem, "RAM %uK free", ram);
      std::snprintf(v.say[2], sizeof v.say[2], "%.21s", mem);
    }
    // After ten minutes with nothing new, turn it down: an OLED wears where it
    // stays lit. Judged by screen_sum, which leaves out what moves by itself:
    // compared frame to frame, the star and the address taking turns with the
    // name kept it from ever dimming.
    const uint32_t sum = screen_sum(now, status, v);
    if (sum != still_sum) { still_sum = sum; changed_at = t; }
    draw_screen(now, status, v, frame);
    const bool want_dim = t - changed_at > 600 * 1000000LL;
    if (want_dim != dim) { command({0x81, static_cast<uint8_t>(want_dim ? 0x08 : 0xCF)}); dim = want_dim; }
    if (!flush(now, shown, all)) { all = true; vTaskDelay(pdMS_TO_TICKS(1000)); continue; } // a glitch on the bus: send it all again
    all = false;
    vTaskDelay(pdMS_TO_TICKS(80));
  }
}

void screen_start() {
  uint8_t address = 0;
  if (!bus_open(address)) { ESP_LOGW(TAG, "no display found on I2C (SDA %d, SCL %d)", SDA, SCL); return; }
  if (!display_init()) { ESP_LOGW(TAG, "the display at 0x%02x did not take its set-up", address); return; }
  present = true;
  // 6 KB of stack: drawing is shallow, but hub_status formats text and takes a few locks.
  if (xTaskCreate(screen_task, "screen", 6144, nullptr, 2, nullptr) != pdPASS) { present = false; ESP_LOGW(TAG, "no memory for the screen's task"); return; }
  ESP_LOGI(TAG, "display at 0x%02x", address);
}

static void copy_line(char (&to)[22], const char *from) { std::snprintf(to, sizeof to, "%s", from ? from : ""); }
void screen_say(const char *line1, const char *line2, const char *line3) {
  std::lock_guard<std::mutex> g(view_lock);
  copy_line(view.say[0], line1);
  copy_line(view.say[1], line1 ? line2 : nullptr);
  copy_line(view.say[2], line1 ? line3 : nullptr);
}
void IRAM_ATTR screen_info() { info_wanted = true; }
void screen_progress(int percent) { std::lock_guard<std::mutex> g(view_lock); view.progress = percent; }
void screen_alert(const char *text) { std::lock_guard<std::mutex> g(view_lock); copy_line(view.alert, text); }
void screen_name(const char *name) { std::lock_guard<std::mutex> g(view_lock); std::snprintf(view.name, sizeof view.name, "%s", name ? name : ""); }
