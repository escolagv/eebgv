Param(
    [string]$AppVersion = "1.0.0",
    [string]$ProfessorUrl = "https://SEU-DOMINIO/apoia/professor.html",
    [string]$ApkUrl = "https://SEU-STORAGE/appprof.apk",
    [string]$IosUrl = "https://SEU-STORAGE/appprof.ipa",
    [switch]$UpdateProfessorVersion
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$appprofIndex = Join-Path $root "appprof\\index.html"

if (!(Test-Path $appprofIndex)) {
    Write-Host "Arquivo nao encontrado: $appprofIndex" -ForegroundColor Red
    exit 1
}

$html = Get-Content $appprofIndex -Raw

$html = $html -replace "__APP_VERSION__", $AppVersion
$html = $html -replace "__PROFESSOR_URL__", $ProfessorUrl
$html = $html -replace "__APK_URL__", $ApkUrl
$html = $html -replace "__IOS_URL__", $IosUrl

$html = [regex]::Replace($html, '(?<=Versão <strong>)[^<]*(?=</strong>)', $AppVersion)
$html = [regex]::Replace($html, '(?<=class="btn btn-primary" href=")[^"]*(?=")', $ProfessorUrl)
$html = [regex]::Replace($html, '(?<=class="btn btn-android" href=")[^"]*(?=")', $ApkUrl)
$html = [regex]::Replace($html, '(?<=class="btn btn-ios" href=")[^"]*(?=")', $IosUrl)

Set-Content -Path $appprofIndex -Value $html -Encoding UTF8
Write-Host "Atualizado: appprof/index.html" -ForegroundColor Green

if ($UpdateProfessorVersion) {
    $pages = @(
        (Join-Path $root "apoia\\index.html"),
        (Join-Path $root "apoia\\professor.html")
    )

    foreach ($page in $pages) {
        if (Test-Path $page) {
            $content = Get-Content $page -Raw
            $content = [regex]::Replace($content, 'V\d+(\.\d+){0,3}', "V$AppVersion")
            Set-Content -Path $page -Value $content -Encoding UTF8
            Write-Host "Versao atualizada: $page" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "Proximos passos:" -ForegroundColor Cyan
Write-Host "1) Envie o APK/IPA para um storage (Supabase Storage, S3, etc.)."
Write-Host "2) Rode este script com os links corretos."
Write-Host "3) Publique na Vercel (ex: vercel --prod)."
