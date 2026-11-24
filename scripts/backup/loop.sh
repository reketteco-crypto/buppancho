#!/bin/sh
set -eu
while true; do
  if /usr/local/bin/buppancho-backup; then
    sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
  else
    # A transient startup/network failure must not postpone retry for a whole day.
    sleep "${BACKUP_RETRY_SECONDS:-300}"
  fi
done
