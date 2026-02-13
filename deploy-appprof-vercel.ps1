Param(
    [string]$WorkingDir = "."
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
    Write-Host "Vercel CLI nao encontrado. Instale com: npm i -g vercel" -ForegroundColor Yellow
    exit 1
}

Push-Location $WorkingDir
try {
    vercel --prod
} finally {
    Pop-Location
}
