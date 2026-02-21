Param(
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main",
    [string]$CommitMessage = "chore: update"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git nao encontrado." -ForegroundColor Red
    exit 1
}

$origin = git remote get-url origin 2>$null
if (-not $origin -and $GitRemoteUrl) {
    git remote add origin $GitRemoteUrl | Out-Null
}

git add -A | Out-Null
git commit -m $CommitMessage | Out-Null
git push -u origin $GitBranch
