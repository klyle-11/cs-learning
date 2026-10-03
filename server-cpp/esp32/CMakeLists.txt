# The hub on an ESP32 (LilyGO T3 V1.6.1). Same server sources as the desktop
# build in ../src; only main/board.cpp is specific to the board.
#   . $IDF_PATH/export.sh && idf.py set-target esp32 && idf.py menuconfig   (Hub: Wi-Fi name and password)
#   idf.py -p /dev/cu.usbserial-XXXX flash monitor
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(hub)
