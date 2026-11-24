param([Parameter(Mandatory = $true)][string]$EnvFile)
$ErrorActionPreference = 'Stop'
$productionLog = Join-Path (Split-Path -Parent $EnvFile) 'startup.log'
try {
  $productionDocker = Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
  if (!(Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $productionDocker -WindowStyle Hidden
  }
  $productionReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $productionReady = $true; break }
    Start-Sleep -Seconds 2
  }
  if (!$productionReady) { throw 'Dockerを起動できません。' }
  & (Join-Path $PSScriptRoot 'production.ps1') -Mode Start -EnvFile $EnvFile *> $productionLog
} catch {
  '物販帳の自動起動を確認できません。運用手順で状態を確認してください。' | Out-File -LiteralPath $productionLog -Encoding UTF8
  exit 1
}
