idf_component_register(
  SRCS "board.cpp" "screen.cpp" "update.cpp" "../../src/hub.cpp" "../../vendor/cJSON.c"
  INCLUDE_DIRS "." "../../src" "../../vendor"
  REQUIRES esp_wifi esp_netif esp_event nvs_flash fatfs sdmmc esp_driver_spi esp_driver_i2c esp_timer
           esp_http_client app_update mbedtls pthread lwip)
# mDNS (NAME.local) is a separate component (idf_component.yml): used when the
# build has it, under either of the names it comes by. board.cpp checks for mdns.h.
idf_component_optional_requires(PRIVATE mdns espressif__mdns)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-missing-field-initializers)
