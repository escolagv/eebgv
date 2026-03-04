Param(
    [string]$EncVersion = "",
    [switch]$AutoVersion
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$pages = @(
    (Join-Path $root "encaminhamentos\\dashboard.html"),
    (Join-Path $root "encaminhamentos\\encaminhamento.html"),
    (Join-Path $root "encaminhamentos\\consulta.html"),
    (Join-Path $root "encaminhamentos\\relatorios.html")
)

function Parse-Version {
    param([string]$Value)
    $match = [regex]::Match($Value, '\d+(?:\.\d+)*')
    if ($match.Success) { return $match.Value }
    return ""
}

function Get-CurrentVersion {
    foreach ($page in $pages) {
        if (!(Test-Path $page)) { continue }
        $content = Get-Content $page -Raw
        $match = [regex]::Match($content, 'id="enc-app-version"[^>]*data-version="([^"]+)"')
        if ($match.Success) {
            $ver = Parse-Version $match.Groups[1].Value
            if ($ver) { return $ver }
        }
    }
    return "1.0.0"
}

function Get-NextVersion {
    param([string]$Current)
    $parts = $Current -split '\.' | ForEach-Object { [int]($_) }
    $major = if ($parts.Length -gt 0) { $parts[0] } else { 1 }
    $minor = if ($parts.Length -gt 1) { $parts[1] } else { 0 }
    $patch = if ($parts.Length -gt 2) { $parts[2] } else { 0 }
    $patch += 1
    return "$major.$minor.$patch"
}

$current = Get-CurrentVersion

if ($AutoVersion -or [string]::IsNullOrWhiteSpace($EncVersion)) {
    $EncVersion = Get-NextVersion -Current $current
    Write-Host "Versao automatica: $current -> $EncVersion" -ForegroundColor Cyan
}

if ([string]::IsNullOrWhiteSpace($EncVersion)) {
    Write-Host "Versao nao informada. Nenhuma alteracao feita." -ForegroundColor Yellow
    exit 0
}

foreach ($page in $pages) {
    if (!(Test-Path $page)) { continue }
    $content = Get-Content $page -Raw
    $content = [regex]::Replace($content, '(id="enc-app-version"[^>]*data-version=")[^"]*(")', "`${1}$EncVersion`${2}")
    $content = [regex]::Replace($content, '(id="enc-app-version"[^>]*>)[^<]*(</div>)', "`${1}V$EncVersion`${2}")
    Set-Content -Path $page -Value $content -Encoding UTF8
    Write-Host "Versao atualizada: $page" -ForegroundColor Green
}

Write-Host "Encaminhamentos atualizado para V$EncVersion." -ForegroundColor Cyan
