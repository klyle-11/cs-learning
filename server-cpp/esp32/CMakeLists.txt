# The store on an ESP32-S3 (LilyGO T3-S3 V1.3).
#   . $IDF_PATH/export.sh && idf.py set-target esp32s3 && idf.py menuconfig
#   idf.py -p /dev/cu.usbserial-XXXX flash monitor
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(hub)
