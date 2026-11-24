param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Initialize', 'Update', 'Backup', 'VerifyRestore', 'Status', 'Bootstrap', 'Stop', 'Start')]
  [string]$Mode,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$Release
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$productionRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$productionEnvPath = [IO.Path]::GetFullPath($EnvFile)
if ($productionEnvPath.StartsWith($productionRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw '本番の環境ファイルはリポジトリ外に置いてください。'
}
if (!(Test-Path -LiteralPath $productionEnvPath -PathType Leaf)) { throw '本番環境ファイルがありません。' }
$productionSettings = @{}
foreach ($line in Get-Content -LiteralPath $productionEnvPath -Encoding UTF8) {
  if ($line -match '^([A-Z_]+)=(.*)$') {
    if ($productionSettings.ContainsKey($Matches[1])) { throw '環境設定の項目が重複しています。' }
    $productionSettings[$Matches[1]] = $Matches[2]
  } elseif ($line.Trim() -and !$line.Trim().StartsWith('#')) { throw '環境設定の形式を確認してください。' }
}
$productionEnvironmentNames = @('POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'LAN_ADDRESS', 'CADDY_IMAGE', 'RELEASE_SHA', 'BACKUP_DIR', 'BACKUP_STATUS_DIR', 'BACKUP_MIRROR_DIR', 'BACKUP_IDENTITY_FILE')
foreach ($required in $productionEnvironmentNames) {
  if (!$productionSettings[$required]) { throw '本番の必須設定が不足しています。' }
}
if ($productionSettings.POSTGRES_DB -ne 'buppancho_prod' -or $productionSettings.POSTGRES_USER -ne 'buppancho_prod') {
  throw '本番専用DB・ロールを確認できません。既存DBには接続しません。'
}
if ($productionSettings.POSTGRES_PASSWORD -notmatch '^[a-fA-F0-9]{64}$') { throw '本番DBには専用のランダム64桁hexパスワードを指定してください。' }
if ($productionSettings.LAN_ADDRESS -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or
    ![Net.IPAddress]::TryParse($productionSettings.LAN_ADDRESS, [ref]([Net.IPAddress]$null))) { throw '本番のプライベートIPv4を確認してください。' }
if ($productionSettings.CADDY_IMAGE -notmatch '^caddy:[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}$') { throw 'Caddyの固定イメージdigestが必要です。' }
foreach ($key in @('BACKUP_DIR', 'BACKUP_STATUS_DIR', 'BACKUP_MIRROR_DIR', 'BACKUP_IDENTITY_FILE')) {
  $productionPath = $productionSettings[$key]
  if (![IO.Path]::IsPathRooted($productionPath) -or $productionPath.Contains('$') -or $productionPath.Contains('"')) { throw '保存先は絶対パスで指定してください。' }
  $productionPath = [IO.Path]::GetFullPath($productionPath)
  if ($productionPath.StartsWith($productionRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '本番の秘密情報・バックアップはリポジトリ外に置いてください。' }
  if (!(Test-Path -LiteralPath $productionPath)) { throw '保存先またはバックアップ鍵がありません。' }
}
if (!$Release) { $Release = $productionSettings.RELEASE_SHA }
if ($Release -notmatch '^[a-f0-9]{40}$') { throw '40桁のGit SHAを指定してください。' }
if ($Mode -in @('Initialize', 'Update')) {
  $productionHead = (& git -C $productionRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $productionHead -ne $Release) { throw '配備するコミットと作業ツリーのHEADが一致しません。' }
  $productionChanges = & git -C $productionRoot status --porcelain --untracked-files=all
  if ($LASTEXITCODE -ne 0 -or $productionChanges) { throw '未コミットの変更があります。検証・コミット後に配備してください。' }
  $productionAddress = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object IPAddress -eq $productionSettings.LAN_ADDRESS
  if (!$productionAddress) { throw 'LANアドレスがこのPCにありません。IP予約と設定を確認してください。' }
}
$productionCompose = @('compose', '--project-name', 'buppancho-prod', '--project-directory', $productionRoot, '--env-file', $productionEnvPath, '-f', (Join-Path $productionRoot 'compose.production.yaml'))
function Invoke-ProductionDocker {
  param([string[]]$DockerArguments, [switch]$Capture)
  if ($Capture) { $productionOutput = & docker @productionCompose @DockerArguments }
  else { & docker @productionCompose @DockerArguments | Out-Host }
  if ($LASTEXITCODE -ne 0) { throw '本番操作が失敗しました。後続処理を停止します。秘密値は表示しません。' }
  if ($Capture) { return $productionOutput }
}
function Invoke-ProductionSql {
  param([string]$Sql)
  return Invoke-ProductionDocker -DockerArguments @('exec', '-T', 'postgres', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'buppancho_prod', '-d', 'buppancho_prod', '-c', $Sql) -Capture
}
function Backup-Production {
  Invoke-ProductionDocker -DockerArguments @('run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/buppancho-backup', 'backup')
  $productionStatus = Get-Content -LiteralPath (Join-Path $productionSettings.BACKUP_STATUS_DIR 'status.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($productionStatus.status -ne 'success' -or !$productionStatus.mirror) { throw 'バックアップと複製の成功を確認できません。' }
  return [IO.Path]::GetFileName($productionStatus.file)
}
$productionPreviousEnvironment = @{}
foreach ($productionName in $productionEnvironmentNames) {
  $productionPreviousEnvironment[$productionName] = [Environment]::GetEnvironmentVariable($productionName, 'Process')
}
$productionPreviousRestore = $env:RESTORE_DATABASE
$productionPendingFile = Join-Path $productionSettings.BACKUP_STATUS_DIR 'operation.pending'
if ($Mode -in @('Initialize', 'Update', 'VerifyRestore', 'Start', 'Bootstrap') -and (Test-Path -LiteralPath $productionPendingFile)) {
  throw '前回の運用操作が未完了です。入力を再開せず、記録とDBを確認してください。'
}
function Start-ProductionOperation {
  $productionOperationStream = [IO.File]::Open($productionPendingFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $productionOperationBytes = [Text.UTF8Encoding]::new($false).GetBytes($Mode + ' ' + $Release)
    $productionOperationStream.Write($productionOperationBytes, 0, $productionOperationBytes.Length)
    $productionOperationStream.Flush($true)
  } finally {
    $productionOperationStream.Dispose()
  }
}
function Complete-ProductionOperation {
  Remove-Item -LiteralPath $productionPendingFile
}
try {
  # Compose otherwise lets inherited shell variables override --env-file values.
  foreach ($productionName in $productionEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($productionName, $productionSettings[$productionName], 'Process')
  }
  $env:RELEASE_SHA = $Release
  Remove-Item Env:RESTORE_DATABASE -ErrorAction SilentlyContinue
  Invoke-ProductionDocker -DockerArguments @('config', '--quiet')
  switch ($Mode) {
    'Status' {
      Invoke-ProductionDocker -DockerArguments @('ps')
      Invoke-ProductionSql -Sql "BEGIN READ ONLY; SELECT current_database(),current_user; SELECT count(*),max(migration_name),count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM _prisma_migrations; SELECT 'accounts',count(*) FROM user_account; SELECT 'setup_complete',count(*) FROM workspace WHERE setup_completed_at IS NOT NULL; COMMIT;" | Out-Host
      if (Test-Path -LiteralPath (Join-Path $productionSettings.BACKUP_STATUS_DIR 'status.json')) {
        Get-Content -LiteralPath (Join-Path $productionSettings.BACKUP_STATUS_DIR 'status.json') -Encoding UTF8 -Raw | ConvertFrom-Json | Select-Object status, finishedAt | Out-Host
      }
    }
    'Stop' { Invoke-ProductionDocker -DockerArguments @('stop', 'proxy', 'app') }
    'Start' {
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--wait', '--no-build', '--pull', 'never', 'postgres')
      $productionExpectedMigrations = (Get-ChildItem -LiteralPath (Join-Path $productionRoot 'prisma/migrations') -Directory | Sort-Object Name | ForEach-Object Name) -join '|'
      $productionActualMigrations = Invoke-ProductionSql -Sql "SELECT string_agg(migration_name,'|' ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
      $productionFailedMigrations = Invoke-ProductionSql -Sql 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;'
      if ($productionActualMigrations -ne $productionExpectedMigrations -or $productionFailedMigrations -ne '0') { throw 'DBの適用状態が一致しません。自動更新せず停止します。' }
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--wait', '--no-build', '--pull', 'never', 'app')
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--no-build', '--pull', 'never', 'backup', 'proxy')
    }
    'Bootstrap' {
      if ((Invoke-ProductionSql -Sql 'SELECT count(*) FROM workspace;') -ne '0') { throw 'ワークスペースが存在します。bootstrapは再実行しません。' }
      # Preserve the real console TTY for hidden password input; do not pipe stdout.
      & docker @productionCompose --profile tools run --rm migrate pnpm bootstrap
      if ($LASTEXITCODE -ne 0) { throw 'ログイン作成を完了できませんでした。保存状態を確認してください。' }
    }
    'Backup' { Write-Host ('暗号化バックアップ・複製成功: ' + (Backup-Production)) }
    'Initialize' {
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--wait', 'postgres')
      $productionTableCount = Invoke-ProductionSql -Sql "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
      if ($productionTableCount -ne '0') { throw '本番DBは空ではありません。初期化・上書きを行いません。' }
      Start-ProductionOperation
      Invoke-ProductionDocker -DockerArguments @('--profile', 'tools', 'build', 'app', 'migrate', 'backup')
      Invoke-ProductionDocker -DockerArguments @('--profile', 'tools', 'run', '--rm', 'migrate')
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--wait', 'app')
      Write-Host ('初回バックアップ成功: ' + (Backup-Production))
      Invoke-ProductionDocker -DockerArguments @('up', '-d', 'backup', 'proxy')
      $productionEnvText = Get-Content -LiteralPath $productionEnvPath -Encoding UTF8 -Raw
      [IO.File]::WriteAllText($productionEnvPath, [regex]::Replace($productionEnvText, '(?m)^RELEASE_SHA=.*$', ('RELEASE_SHA=' + $Release)), [Text.UTF8Encoding]::new($false))
      Complete-ProductionOperation
      Write-Host '初回構築が完了しました。本人によるbootstrap・初期設定・実機受入後に業務入力を開始してください。'
    }
    'Update' {
      Invoke-ProductionDocker -DockerArguments @('--profile', 'tools', 'build', 'app', 'migrate', 'backup')
      Start-ProductionOperation
      Invoke-ProductionDocker -DockerArguments @('stop', 'proxy', 'app', 'backup')
      Write-Host ('更新前バックアップ成功: ' + (Backup-Production))
      Invoke-ProductionDocker -DockerArguments @('--profile', 'tools', 'run', '--rm', 'migrate')
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--wait', 'app')
      Invoke-ProductionDocker -DockerArguments @('up', '-d', 'backup', 'proxy')
      $productionEnvText = Get-Content -LiteralPath $productionEnvPath -Encoding UTF8 -Raw
      [IO.File]::WriteAllText($productionEnvPath, [regex]::Replace($productionEnvText, '(?m)^RELEASE_SHA=.*$', ('RELEASE_SHA=' + $Release)), [Text.UTF8Encoding]::new($false))
      Complete-ProductionOperation
    }
    'VerifyRestore' {
      # Freeze all application writes so comparison describes the dump snapshot.
      Start-ProductionOperation
      Invoke-ProductionDocker -DockerArguments @('stop', 'proxy', 'app', 'backup')
      $productionBackupName = Backup-Production
      $env:RESTORE_DATABASE = 'buppancho_prod_restore_' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '_test'
      Invoke-ProductionDocker -DockerArguments @('exec', '-T', 'postgres', 'createdb', '-U', 'buppancho_prod', $env:RESTORE_DATABASE)
      Invoke-ProductionDocker -DockerArguments @('run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/buppancho-restore', 'backup', ('/backups/daily/' + $productionBackupName))
      Invoke-ProductionDocker -DockerArguments @('--profile', 'tools', 'run', '--rm', '--no-deps', 'migrate', 'pnpm', 'exec', 'tsx', 'scripts/deploy/verify-production-restore.ts')
      try {
        Invoke-ProductionDocker -DockerArguments @('--profile', 'tools', 'up', '-d', '--wait', '--no-build', '--pull', 'never', 'restored-app')
        Invoke-ProductionDocker -DockerArguments @('exec', '-T', 'restored-app', 'node', '-e', "fetch('http://127.0.0.1:3000/login').then(async r=>{const h=await r.text();if(!r.ok||!h.includes('ユーザー名')||!h.includes('パスワード'))process.exit(1);console.log('Restored application login page: HTTP 200')}).catch(()=>process.exit(1))")
      } finally {
        Invoke-ProductionDocker -DockerArguments @('stop', 'restored-app')
      }
      Write-Host ('復元DBを保全しました: ' + $env:RESTORE_DATABASE)
      Invoke-ProductionDocker -DockerArguments @('up', '-d', '--wait', 'app')
      Invoke-ProductionDocker -DockerArguments @('up', '-d', 'proxy', 'backup')
      Complete-ProductionOperation
    }
  }
} catch {
  $productionFailure = $_
  if (Test-Path -LiteralPath $productionPendingFile) {
    try { Invoke-ProductionDocker -DockerArguments @('stop', 'proxy', 'app', 'backup') }
    catch { Write-Warning '停止を確認できません。未完了マーカーを保全して接続を停止してください。' }
  }
  throw $productionFailure
} finally {
  foreach ($productionName in $productionEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($productionName, $productionPreviousEnvironment[$productionName], 'Process')
  }
  $env:RESTORE_DATABASE = $productionPreviousRestore
}
