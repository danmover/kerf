#!/bin/sh
# Hosts such as Fly.io mount volumes owned by root. Hand the data folder to
# the unprivileged node user, then run the server as that user.
set -e
DATA="${KERF_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
