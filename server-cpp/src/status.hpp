// What the server is doing, for a screen: the board's OLED (esp32/main/screen.cpp)
// reads it a few times a second. Fixed sizes, so reading it allocates nothing.
#pragma once

#include <cstdint>

struct HubPeer {
  char name[28];  // the name the device was paired under
  char ip[16];    // where its last request came from
  bool live;      // it has a page open, listening for changes
};

struct HubStatus {
  bool running = false;    // listening for requests
  char host[40] = "";      // the address to type: this machine's IP on the network
  int port = 0;
  bool tls = false;
  char pair_code[10] = ""; // "ABCD-EFGH" while a pairing code is on offer
  int pair_seconds = 0;    // how long it is still good for
  char fingerprint[24] = "";  // the start of the authority's SHA-256 fingerprint ("AB:CD:EF:…")
  int peer_count = 0;      // devices with a page open or a request in the last two minutes
  HubPeer peers[8];
  char notice[32] = "";    // something that just happened: a device paired, the card is full
  uint64_t used = 0, free = 0;
};

// Fills `out` (hub.cpp). Safe to call from any thread.
void hub_status(HubStatus &out);
// Connections being served right now: something to wait for before an update.
int hub_busy();
