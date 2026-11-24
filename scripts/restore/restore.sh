#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 1 ]; then echo "Usage: restore.sh /backups/file.dump.age" >&2; exit 2; fi
encrypted="$1"
test -f "$encrypted" && test -f "$encrypted.sha256" || { echo "backup or checksum not found" >&2; exit 1; }
(cd "$(dirname "$encrypted")" && sha256sum -c "$(basename "$encrypted.sha256")")
count="$(PGPASSWORD="$TARGET_POSTGRES_PASSWORD" psql "$TARGET_DATABASE_URL" -Atc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")"
test "$count" = "0" || { echo "復元先DBが空ではありません。処理を中止します。" >&2; exit 1; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
identity_file="${BACKUP_IDENTITY_FILE:-/run/secrets/backup-identity}"
test -s "$identity_file" || { echo "backup identity file is missing" >&2; exit 1; }
age --decrypt --identity "$identity_file" --output "$tmp" "$encrypted"
PGPASSWORD="$TARGET_POSTGRES_PASSWORD" pg_restore --dbname="$TARGET_DATABASE_URL" --no-owner --exit-on-error "$tmp"
echo "復元が完了しました。件数とログインを確認してください。"
