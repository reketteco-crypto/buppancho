FROM postgres:18.4-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends age ca-certificates && rm -rf /var/lib/apt/lists/*
COPY scripts/backup/backup.sh /usr/local/bin/buppancho-backup
COPY scripts/backup/loop.sh /usr/local/bin/buppancho-backup-loop
COPY scripts/restore/restore.sh /usr/local/bin/buppancho-restore
RUN chmod 0755 /usr/local/bin/buppancho-backup /usr/local/bin/buppancho-backup-loop /usr/local/bin/buppancho-restore
ENTRYPOINT ["/usr/local/bin/buppancho-backup-loop"]
