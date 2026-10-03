#!/bin/sh
# Start the hub: the server (server-cpp/hubd) on the live workspace, data/.
#
#   ./start.sh [folder] [hubd options]      (default folder: data)
#   cd hub && npm start                     (the same thing)
#
# The first run makes data/ as a copy of sample/, fetches the page's libraries
# and builds the server. Settings, all optional:
#   HOST=0.0.0.0          listen on the network: HTTPS and pairing (default: this machine only)
#   PORT=4400             another port (default 4321)
#   HUB_STATE=<dir>       certificates and paired devices (default ~/.config/hub)
#   HUB_QUOTA_MB=<n>      most the folder may hold in total (0: no limit)
#   HUB_HOSTS=a,b         further names the server may be reached by
#   HUB_PAIR_LOCAL=1      this machine's own browser must pair too
#   HUB_TLS=1             HTTPS even on this machine;  HUB_INSECURE_HTTP=1  network without HTTPS
set -e
here="$(cd "$(dirname "$0")" && pwd)"

folder="${HUB_ROOT:-$here/data}"
case "${1:-}" in ''|-*) ;; *) folder="$1"; shift ;; esac
if [ "$folder" = "$here/data" ] && [ ! -d "$folder" ]; then
  if [ -d "$here/sample" ]; then cp -R "$here/sample" "$folder"; else mkdir -p "$folder"; fi
  echo "made data/ from sample/"
fi

# The page's three libraries (markdown, code colouring, the HTML sanitiser) come from npm.
if [ ! -d "$here/hub/node_modules/marked" ]; then (cd "$here/hub" && npm install); fi
# Build the server, or rebuild it if its source changed. Needs a C++ compiler and mbedTLS (macOS: brew install mbedtls).
make -s -C "$here/server-cpp" hubd

set -- "$folder" --www "$here/hub" "$@"
if [ -n "${PORT:-}" ]; then set -- "$@" --port "$PORT"; fi
if [ -n "${HOST:-}" ]; then set -- "$@" --host "$HOST"; fi
if [ -n "${HUB_QUOTA_MB:-}" ]; then set -- "$@" --quota-mb "$HUB_QUOTA_MB"; fi
if [ "${HUB_PAIR_LOCAL:-}" = 1 ]; then set -- "$@" --pair-local; fi
if [ "${HUB_TLS:-}" = 1 ]; then set -- "$@" --tls; fi
if [ "${HUB_INSECURE_HTTP:-}" = 1 ]; then set -- "$@" --insecure-http; fi
for name in $(printf '%s' "${HUB_HOSTS:-}" | tr ',' ' '); do set -- "$@" --allow-host "$name"; done
exec "$here/server-cpp/hubd" "$@"
