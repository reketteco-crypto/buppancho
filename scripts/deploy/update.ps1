$ErrorActionPreference = "Stop"
function Invoke-UpdateDocker {
  param([string[]]$DockerArguments)
  & docker @DockerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Docker command failed (exit code $LASTEXITCODE). Update stopped."
  }
}

Write-Host "1/4 Pre-update backup"
Invoke-UpdateDocker -DockerArguments @('compose', 'run', '--rm', '--entrypoint', '/usr/local/bin/buppancho-backup', 'backup')
Write-Host "2/4 Build images"
Invoke-UpdateDocker -DockerArguments @('compose', 'build', 'app', 'migrate')
Write-Host "3/4 Apply migrations"
Invoke-UpdateDocker -DockerArguments @('compose', '--profile', 'tools', 'run', '--rm', 'migrate')
Write-Host "4/4 Update services"
Invoke-UpdateDocker -DockerArguments @('compose', 'up', '-d', 'app', 'backup')
Invoke-UpdateDocker -DockerArguments @('compose', 'ps')
