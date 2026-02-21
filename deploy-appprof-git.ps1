Param(
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main",
    [string]$GitCommitMessage = "chore: deploy appprof"
)

$ErrorActionPreference = "Stop"

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
git push -u origin $GitBranch
