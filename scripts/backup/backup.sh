#!/bin/sh
set -eu
umask 077
STATUS_FILE="${BACKUP_STATUS_FILE:-/status/status.json}"
BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
IDENTITY_FILE="${BACKUP_IDENTITY_FILE:-/run/secrets/backup-identity}"
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/monthly" "$(dirname "$STATUS_FILE")"
chmod 0755 "$(dirname "$STATUS_FILE")"
timestamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
plain="$BACKUP_ROOT/daily/buppancho-$timestamp.dump"
encrypted="$plain.age"
write_status() { printf '{"status":"%s","finishedAt":"%s","file":"%s","mirror":"%s","message":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "${BACKUP_MIRROR_ROOT:-}" "$3" > "$STATUS_FILE.tmp" && chmod 0644 "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"; }
trap 'rm -f "$plain"; write_status failure "$encrypted" "バックアップに失敗しました"' HUP INT TERM EXIT
test -s "$IDENTITY_FILE" || { echo "backup identity file is missing" >&2; exit 1; }
# Docker Desktop can restart the backup service before PostgreSQL is ready.
attempt=0
until pg_isready --host="$POSTGRES_HOST" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 12 || { echo "backup database is not ready" >&2; exit 1; }
  sleep 5
done
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --host="$POSTGRES_HOST" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --file="$plain"
recipient="$(age-keygen -y "$IDENTITY_FILE")"
age --recipient "$recipient" --encrypt --output "$encrypted" "$plain"
rm -f "$plain"
(cd "$BACKUP_ROOT/daily" && sha256sum "$(basename "$encrypted")" > "$(basename "$encrypted").sha256")
find "$BACKUP_ROOT/daily" -type f -mtime +13 -delete
if [ "$(date -u +%d)" = "01" ]; then cp "$encrypted" "$BACKUP_ROOT/monthly/$(basename "$encrypted")"; cp "$encrypted.sha256" "$BACKUP_ROOT/monthly/$(basename "$encrypted.sha256")"; fi
find "$BACKUP_ROOT/monthly" -type f -mtime +365 -delete
if [ -n "${BACKUP_MIRROR_ROOT:-}" ]; then
  mkdir -p "$BACKUP_MIRROR_ROOT"
  cp "$encrypted" "$encrypted.sha256" "$BACKUP_MIRROR_ROOT/"
  cmp "$encrypted" "$BACKUP_MIRROR_ROOT/$(basename "$encrypted")"
fi
trap - HUP INT TERM EXIT
write_status success "$encrypted" "暗号化バックアップを作成しました"
