// The firmware's version: a whole number, raised by one for each release
// (tools/release.sh reads it). The board installs an update only if its number
// is higher than this, so an old release, even a signed one, cannot be sent back to it.
#pragma once
#define HUB_VERSION 1
