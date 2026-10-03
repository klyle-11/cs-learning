idf_component_register(
  SRCS "board.cpp" "../../src/hub.cpp" "../../vendor/cJSON.c"
  INCLUDE_DIRS "../../src" "../../vendor"
  REQUIRES esp_wifi esp_netif esp_event nvs_flash fatfs sdmmc esp_driver_spi mbedtls pthread lwip)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-missing-field-initializers)
