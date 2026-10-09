# =============================================================
#  Instalador do Ajudante - Lumere Downloader
#  - compila o ajudante (MvdHost.cs) com o .NET que já vem no Windows
#  - baixa yt-dlp, gallery-dl, ffmpeg e deno (oficiais, do GitHub)
#  - rodar de novo = atualizar (yt-dlp e gallery-dl são sempre baixados de novo)
#  - registra o ajudante no Chrome, Edge e Brave
#  Tudo fica em %LOCALAPPDATA%\MeuVideoDownloader (não precisa ser administrador)
# =============================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$HostName    = 'com.meuvideo.downloader'
$ExtensionId = 'hihaboigdennponpgjgkidlbemoibncd'
$Dir = Join-Path $env:LOCALAPPDATA 'MeuVideoDownloader'
$Bin = Join-Path $Dir 'bin'
$Tmp = Join-Path $env:TEMP ('mvd-' + [guid]::NewGuid().ToString('N'))

function Passo($texto) { Write-Host ''; Write-Host "==> $texto" -ForegroundColor Cyan }
function Baixar($url, $destino) {
    Write-Host "    baixando $url"
    Invoke-WebRequest -Uri $url -OutFile $destino -UseBasicParsing
}

Write-Host ''
Write-Host '  Lumere Downloader - instalando o ajudante' -ForegroundColor Green
Write-Host "  Pasta: $Dir"

New-Item -ItemType Directory -Force -Path $Bin, $Tmp | Out-Null

# 1) Compila o ajudante --------------------------------------------------
Passo 'Compilando o ajudante'
Get-Process -Name 'mvd-host' -ErrorAction SilentlyContinue | Stop-Process -Force
$exe = Join-Path $Dir 'mvd-host.exe'
if (Test-Path $exe) { Remove-Item $exe -Force }
$src = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'MvdHost.cs'), [Text.Encoding]::UTF8)
$webExt = [Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions').Location
Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $exe -OutputType ConsoleApplication -ReferencedAssemblies $webExt
Write-Host "    ok: $exe"

# 2) yt-dlp -------------------------------------------------------------
Passo 'Baixando o yt-dlp'
Baixar 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $Bin 'yt-dlp.exe')

# 2b) gallery-dl (posts e carrosséis do Instagram) -------------------------
#     O projeto publica o .exe no Codeberg (não mais no GitHub).
Passo 'Baixando o gallery-dl (posts do Instagram)'
$gdl = Join-Path $Bin 'gallery-dl.exe'
$gdlUrls = @()
try {
    $rel = Invoke-RestMethod -Uri 'https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest' -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -eq 'gallery-dl.exe' } | Select-Object -First 1
    if ($asset) { $gdlUrls += $asset.browser_download_url }
} catch { }
$gdlUrls += 'https://codeberg.org/mikf/gallery-dl/releases/download/v1.32.14/gallery-dl.exe'
$gdlOk = $false
foreach ($u in $gdlUrls) {
    try { Baixar $u $gdl; $gdlOk = $true; break } catch { Write-Host "    falhou: $($_.Exception.Message)" -ForegroundColor DarkYellow }
}
if ($gdlOk) {
    try {
        $v = & $gdl --version 2>&1
        if ($LASTEXITCODE -ne 0) { throw "$v" }
        Write-Host "    ok: gallery-dl $v"
    } catch {
        Write-Host '    aviso: o gallery-dl foi baixado mas não abriu. Instale o "Visual C++ Redistributable (x86)":' -ForegroundColor Yellow
        Write-Host '    https://aka.ms/vs/17/release/vc_redist.x86.exe  (depois rode este instalador de novo)' -ForegroundColor Yellow
    }
} else {
    Write-Host '    aviso: não consegui baixar o gallery-dl. O resto funciona; os posts do Instagram não.' -ForegroundColor Yellow
    Write-Host '    Baixe manualmente: https://codeberg.org/mikf/gallery-dl/releases (arquivo gallery-dl.exe)' -ForegroundColor Yellow
    Write-Host "    e coloque em: $Bin" -ForegroundColor Yellow
}

# 3) ffmpeg (junta áudio + vídeo, ferramentas de vídeo) --------------------
if (-not (Test-Path (Join-Path $Bin 'ffmpeg.exe'))) {
    Passo 'Baixando o ffmpeg (pode demorar, ~90 MB)'
    $zip = Join-Path $Tmp 'ffmpeg.zip'
    Baixar 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' $zip
    Expand-Archive -Path $zip -DestinationPath (Join-Path $Tmp 'ffmpeg') -Force
    Get-ChildItem -Path (Join-Path $Tmp 'ffmpeg') -Recurse -Include 'ffmpeg.exe', 'ffprobe.exe' |
        ForEach-Object { Copy-Item $_.FullName -Destination $Bin -Force }
} else { Passo 'ffmpeg já instalado' }

# 4) deno (o yt-dlp precisa dele para o YouTube) --------------------------
if (-not (Test-Path (Join-Path $Bin 'deno.exe'))) {
    Passo 'Baixando o Deno (usado pelo yt-dlp no YouTube)'
    $zip = Join-Path $Tmp 'deno.zip'
    Baixar 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' $zip
    Expand-Archive -Path $zip -DestinationPath $Bin -Force
} else { Passo 'Deno já instalado' }

# 5) Registra no navegador ------------------------------------------------
Passo 'Registrando no Chrome / Edge / Brave'
$manifest = [ordered]@{
    name            = $HostName
    description     = 'Ajudante do Lumere Downloader (yt-dlp)'
    path            = $exe
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestPath = Join-Path $Dir "$HostName.json"
$json = $manifest | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding $false))

$chaves = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)
foreach ($base in $chaves) {
    $k = Join-Path $base $HostName
    New-Item -Path $k -Force | Out-Null
    Set-Item -Path $k -Value $manifestPath
}

Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  Pronto! O ajudante foi instalado.' -ForegroundColor Green
Write-Host '  Feche e abra o Chrome de novo (ou recarregue a extensão) para ela reconhecer o ajudante.'
Write-Host ''
