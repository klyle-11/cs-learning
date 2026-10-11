// Compile/link like the server, with vendor cJSON.o and mbedTLS. No server or
// live workspace is started: exercise the actual reservation/active counter.
#define main hub_cli_main
#include "../src/hub.cpp"
#undef main
#include <cassert>

int main() {
  http::active() = 0;
  assert(memory_for_one_more());
  assert(hub_update_begin());
  assert(!memory_for_one_more());
  assert(!hub_update_begin());
  hub_update_end();
  assert(memory_for_one_more());
  http::active() = 1;
  assert(!hub_update_begin());
  assert(memory_for_one_more()); // failed reservation released its gate
  http::active() = 0;
  assert(hub_update_begin());
  hub_update_end();
  hub_maintenance(true); // empty stream set, no disk/context dependency
  std::puts("Admission: idle reservation, duplicate reservation, busy deferral and gate release passed");
}
