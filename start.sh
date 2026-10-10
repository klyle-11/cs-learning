#!/bin/sh
# Start the hub. The work is done by hub/start.mjs, which runs the same on
# macOS, Linux and Windows; this is the short way to call it from a Unix shell.
#   ./start.sh [folder] [--network] [--insecure] [hubd options]      (see hub/start.mjs)
exec node "$(dirname "$0")/hub/start.mjs" "$@"
