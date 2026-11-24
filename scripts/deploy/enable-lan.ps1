param([Parameter(Mandatory = $true)][string]$LanAddress)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'このLAN設定だけは、管理者として開いたPowerShellで実行してください。'
}
$address = Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $LanAddress
if (!$address -or $LanAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)') {
  throw 'このPCのプライベートIPv4を指定してください。'
}
$profile = Get-NetConnectionProfile -InterfaceIndex $address.InterfaceIndex
if ($profile.NetworkCategory -ne 'Private') { throw '信頼できるプライベートLANに接続してから実行してください。' }
$ruleName = 'Buppancho-Production-HTTPS'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
  throw '物販帳のLANルールは既にあります。変更する場合は既存の範囲を確認してください。'
}
New-NetFirewallRule -Name $ruleName -DisplayName '物販帳 本番 HTTPS（同一LAN）' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3443 -LocalAddress $LanAddress -RemoteAddress LocalSubnet -InterfaceAlias $address.InterfaceAlias -Profile Private -EdgeTraversalPolicy Block | Out-Null
Write-Host '同一LANから、このPCの3443/TCPだけを許可しました。'
