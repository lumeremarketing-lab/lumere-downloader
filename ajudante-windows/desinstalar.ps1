# Remove o ajudante do Lumere Downloader
$ErrorActionPreference = 'SilentlyContinue'
$HostName = 'com.meuvideo.downloader'
$Dir = Join-Path $env:LOCALAPPDATA 'MeuVideoDownloader'

Get-Process -Name 'mvd-host' | Stop-Process -Force
foreach ($base in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
                  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
                  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts') {
    Remove-Item -Path (Join-Path $base $HostName) -Recurse -Force
}
Remove-Item -Path $Dir -Recurse -Force

Write-Host ''
Write-Host '  Ajudante removido.' -ForegroundColor Green
Write-Host ''
