Param(
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main",
    [string]$GitCommitMessage = "chore: deploy appprof"
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
git commit -m $GitCommitMessage | Out-Null
$githubToken = $env:GITHUB_TOKEN
if ($githubToken) {
    $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$githubToken"))
    git -c "http.extraheader=AUTHORIZATION: basic $auth" push -u origin $GitBranch
} else {
    git push -u origin $GitBranch
}
