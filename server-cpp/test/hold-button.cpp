#include "../esp32/main/hold_button.hpp"
#include <cassert>
int main() {
  HoldButton b;
  assert(!b.update(0, true));
  assert(!b.update(5999999, true));
  assert(b.update(6000000, true));
  assert(!b.update(18000000, true));
  assert(!b.update(18000001, false));
  assert(!b.update(20000000, true));
  assert(b.update(26000000, true));
  assert(!b.update(26000001, false));
  assert(!b.update(30000000, true));
  assert(!b.update(31000000, false));
  assert(!b.update(32000000, true));
  assert(!b.update(35000000, true));
}
