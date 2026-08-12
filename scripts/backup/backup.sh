#!/bin/sh
set -eu
STATUS_FILE="${BACKUP_STATUS_FILE:-/status/status.json}"
BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
IDENTITY_FILE="${BACKUP_IDENTITY_FILE:-/run/secrets/backup-identity}"
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/monthly" "$(dirname "$STATUS_FILE")"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
plain="$BACKUP_ROOT/daily/buppancho-$timestamp.dump"
encrypted="$plain.age"
write_status() { printf '{"status":"%s","finishedAt":"%s","file":"%s","mirror":"%s","message":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "${BACKUP_MIRROR_ROOT:-}" "$3" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"; }
trap 'rm -f "$plain"; write_status failure "$encrypted" "バックアップに失敗しました"' HUP INT TERM EXIT
test -s "$IDENTITY_FILE" || { echo "backup identity file is missing" >&2; exit 1; }
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --host="$POSTGRES_HOST" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --file="$plain"
recipient="$(age-keygen -y "$IDENTITY_FILE")"
age --recipient "$recipient" --encrypt --output "$encrypted" "$plain"
rm -f "$plain"
sha256sum "$encrypted" > "$encrypted.sha256"
find "$BACKUP_ROOT/daily" -type f -mtime +13 -delete
if [ "$(date -u +%d)" = "01" ]; then cp "$encrypted" "$BACKUP_ROOT/monthly/$(basename "$encrypted")"; cp "$encrypted.sha256" "$BACKUP_ROOT/monthly/$(basename "$encrypted.sha256")"; fi
find "$BACKUP_ROOT/monthly" -type f -mtime +365 -delete
if [ -n "${BACKUP_MIRROR_ROOT:-}" ]; then mkdir -p "$BACKUP_MIRROR_ROOT"; cp "$encrypted" "$encrypted.sha256" "$BACKUP_MIRROR_ROOT/"; fi
trap - HUP INT TERM EXIT
write_status success "$encrypted" "暗号化バックアップを作成しました"
