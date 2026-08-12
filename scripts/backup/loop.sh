#!/bin/sh
set -eu
while true; do
  /usr/local/bin/buppancho-backup || true
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
