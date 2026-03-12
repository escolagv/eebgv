Param(
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main",
    [string]$CommitMessage = "chore: update"
)

$ErrorActionPreference = "Stop"

function Load-EnvFile {
    param([string]$Path)
    if (!(Test-Path $Path)) { return }
    foreach ($line in Get-Content $Path) {
        $trim = $line.Trim()
        if (-not $trim -or $trim.StartsWith('#')) { continue }
        $idx = $trim.IndexOf('=')
        if ($idx -lt 1) { continue }
        $name = $trim.Substring(0, $idx).Trim()
        $value = $trim.Substring($idx + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $existing = (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value
        if ([string]::IsNullOrWhiteSpace($existing)) {
            Set-Item -Path "Env:$name" -Value $value
        }
    }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Load-EnvFile -Path (Join-Path $root ".env")

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git nao encontrado." -ForegroundColor Red
    exit 1
}

function Parse-Version {
    param([string]$Value)
    $match = [regex]::Match($Value, '\d+(?:\.\d+)*')
    if ($match.Success) { return $match.Value }
    return ""
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

function Get-ApoiaAdminVersion {
    param([string]$Content)
    $match = [regex]::Match($Content, 'id="apoia-admin-version"[^>]*data-version="([^"]+)"')
    if ($match.Success) {
        $ver = Parse-Version $match.Groups[1].Value
        if ($ver) { return $ver }
    }
    $match = [regex]::Match($Content, 'id="apoia-admin-version"[^>]*>V?(\d+(?:\.\d+)*)')
    if ($match.Success) {
        $ver = Parse-Version $match.Groups[1].Value
        if ($ver) { return $ver }
    }
    return "1.0.0"
}

function Update-ApoiaAdminVersion {
    param([string]$PagePath)
    if (!(Test-Path $PagePath)) {
        Write-Host "Arquivo nao encontrado: $PagePath" -ForegroundColor Yellow
        return
    }
    $content = Get-Content $PagePath -Raw
    if ($content -notmatch 'id="apoia-admin-version"') {
        Write-Host "Marcador nao encontrado (id=""apoia-admin-version""): $PagePath" -ForegroundColor Yellow
        return
    }
    $current = Get-ApoiaAdminVersion -Content $content
    $next = Get-NextVersion -Current $current
    Write-Host "Versao automatica (APOIA admin): $current -> $next" -ForegroundColor Cyan
    $content = [regex]::Replace($content, '(id="apoia-admin-version"[^>]*data-version=")[^"]*(")', "`${1}$next`${2}")
    $content = [regex]::Replace($content, '(id="apoia-admin-version"[^>]*>)[^<]*(</div>)', "`${1}V$next`${2}")
    Set-Content -Path $PagePath -Value $content -Encoding UTF8
    Write-Host "Versao atualizada: $PagePath" -ForegroundColor Green
}

$confirmApoia = Read-Host "Atualizar versao do Painel Admin (APOIA)? (s/N)"
if ($confirmApoia -match '^(s|S|y|Y)') {
    $apoiaIndex = Join-Path $root "apoia\\index.html"
    Update-ApoiaAdminVersion -PagePath $apoiaIndex
}

$confirmEnc = Read-Host "Atualizar versao do Encaminhamentos? (s/N)"
if ($confirmEnc -match '^(s|S|y|Y)') {
    $encScript = Join-Path $root "deploy-encaminhamentos.ps1"
    if (Test-Path $encScript) {
        & $encScript -AutoVersion
    } else {
        Write-Host "Script nao encontrado: $encScript" -ForegroundColor Yellow
    }
}

$origin = git remote get-url origin 2>$null
if ($GitRemoteUrl) {
    if ($origin) {
        if ($origin -ne $GitRemoteUrl) {
            git remote set-url origin $GitRemoteUrl | Out-Null
        }
    } else {
        git remote add origin $GitRemoteUrl | Out-Null
    }
}

git add -A | Out-Null
$commitInput = Read-Host "Mensagem do commit (Enter para usar: $CommitMessage)"
if (-not [string]::IsNullOrWhiteSpace($commitInput)) {
    $CommitMessage = $commitInput.Trim()
}
git commit -m $CommitMessage | Out-Null
$githubToken = $env:GITHUB_TOKEN
if ($githubToken) {
    $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$githubToken"))
    git -c "http.extraheader=AUTHORIZATION: basic $auth" push -u origin $GitBranch
} else {
    git push -u origin $GitBranch
}
