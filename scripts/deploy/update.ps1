$ErrorActionPreference = "Stop"
Write-Host "1/4 Pre-update backup"
docker compose run --rm --entrypoint /usr/local/bin/buppancho-backup backup
Write-Host "2/4 Build images"
docker compose build app migrate
Write-Host "3/4 Apply migrations"
docker compose --profile tools run --rm migrate
Write-Host "4/4 Update services"
docker compose up -d app backup
docker compose ps
