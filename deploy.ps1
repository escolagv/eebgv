Param(
    [string]$CommitMessage = "chore: deploy",
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main"
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
$changes = git status --porcelain
if (-not $changes) {
    Write-Host "Sem alteracoes para commit." -ForegroundColor Yellow
    exit 0
}

Write-Host "Commitando: $CommitMessage" -ForegroundColor Cyan
git commit -m $CommitMessage | Out-Null
Write-Host "Enviando para $GitBranch..." -ForegroundColor Cyan
git push -u origin $GitBranch
