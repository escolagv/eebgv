Param(
    [string]$AppVersion = "",
    [string]$ProfessorUrl = "https://eebgv.vercel.app/apoia/professor.html",
    [string]$BaseUrl = "https://eebgv.vercel.app",
    [string]$ApkUrl = "https://eebgv.vercel.app/appprof/downloads/appprof.apk",
    [string]$IosUrl = "https://eebgv.vercel.app/appprof/downloads/appprof.ipa",
    [string]$ApkPath = "",
    [string]$IosPath = "",
    [switch]$BuildAndroid,
    [switch]$BuildIos,
    [switch]$UpdateProfessorVersion,
    [switch]$AutoVersion,
    [switch]$SkipGit,
    [switch]$SkipVercel,
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main",
    [string]$GitCommitMessage = "chore: deploy appprof",
    [string]$VercelProjectId = "",
    [string]$VercelOrgId = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mobileRoot = Join-Path $root "appprof-mobile"
$appprofIndex = Join-Path $root "appprof\\index.html"
$downloadsRoot = Join-Path $root "appprof\\downloads"

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

Load-EnvFile -Path (Join-Path $root ".env")

if (!(Test-Path $appprofIndex)) {
    Write-Host "Arquivo nao encontrado: $appprofIndex" -ForegroundColor Red
    exit 1
}

$html = Get-Content $appprofIndex -Raw

if ([string]::IsNullOrWhiteSpace($VercelProjectId)) { $VercelProjectId = $env:VERCEL_PROJECT_ID }
if ([string]::IsNullOrWhiteSpace($VercelOrgId)) { $VercelOrgId = $env:VERCEL_ORG_ID }

function Get-CurrentAppVersion {
    param([string]$Html)
    $match = [regex]::Match($Html, 'Versão\s*<strong>([^<]+)</strong>')
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    $match = [regex]::Match($Html, '__APP_VERSION__')
    if ($match.Success) { return "1.0.0" }
    return "1.0.0"
}

function Get-NextAppVersion {
    param([string]$Current)
    $parts = $Current -split '\.' | ForEach-Object { [int]($_) }
    $major = if ($parts.Length -gt 0) { $parts[0] } else { 1 }
    $minor = if ($parts.Length -gt 1) { $parts[1] } else { 0 }
    $patch = if ($parts.Length -gt 2) { $parts[2] } else { 0 }
    if ($patch -ge 9) {
        $patch = 0
        if ($minor -ge 9) {
            $minor = 0
            $major += 1
        } else {
            $minor += 1
        }
    } else {
        $patch += 1
    }
    return "$major.$minor.$patch"
}

function Update-CapacitorServerUrl {
    param(
        [string]$ConfigPath,
        [string]$AppVersion
    )
    if (-not (Test-Path $ConfigPath)) { return }
    if ([string]::IsNullOrWhiteSpace($AppVersion)) { return }
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    if (-not $config.server -or [string]::IsNullOrWhiteSpace($config.server.url)) { return }
    $baseUrl = $config.server.url.Split('?')[0]
    $config.server.url = "$baseUrl?app_version=$AppVersion"
    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Host "Capacitor URL atualizado: $($config.server.url)" -ForegroundColor Green
}

if ($AutoVersion -or [string]::IsNullOrWhiteSpace($AppVersion)) {
    $currentVersion = Get-CurrentAppVersion -Html $html
    $AppVersion = Get-NextAppVersion -Current $currentVersion
    Write-Host "Versao automatica: $currentVersion -> $AppVersion" -ForegroundColor Cyan
}

if ($BuildAndroid -or $BuildIos) {
    Update-CapacitorServerUrl -ConfigPath (Join-Path $mobileRoot "capacitor.config.json") -AppVersion $AppVersion
}

function Ensure-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "Comando nao encontrado: $Name" -ForegroundColor Red
        return $false
    }
    return $true
}

function Copy-Artifact {
    param(
        [string]$SourcePath,
        [string]$BaseName,
        [string]$Version,
        [string]$TargetDir,
        [string]$BaseUrl
    )
    if (-not (Test-Path $SourcePath)) {
        Write-Host "Arquivo nao encontrado: $SourcePath" -ForegroundColor Red
        return $null
    }
    if (!(Test-Path $TargetDir)) { New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null }
    $ext = [IO.Path]::GetExtension($SourcePath)
    $fixed = Join-Path $TargetDir "$BaseName$ext"
    $versioned = Join-Path $TargetDir "$BaseName-$Version$ext"
    Copy-Item $SourcePath $fixed -Force
    Copy-Item $SourcePath $versioned -Force
    return "$BaseUrl/appprof/downloads/$(Split-Path $fixed -Leaf)"
}

function Build-AndroidApk {
    param([string]$MobileRoot)
    if (!(Test-Path $MobileRoot)) {
        Write-Host "Pasta do app mobile nao encontrada: $MobileRoot" -ForegroundColor Red
        return $null
    }
    if (-not $env:JAVA_HOME -or !(Test-Path $env:JAVA_HOME)) {
        Write-Host "JAVA_HOME invalido. Configure para o diretório do JDK (ex: C:\\Program Files\\Eclipse Adoptium\\jdk-17.x)." -ForegroundColor Red
        return $null
    }
    if (-not (Ensure-Command "npm")) { return $null }
    if (-not (Ensure-Command "npx")) { return $null }
    Push-Location $MobileRoot
    try {
        if (!(Test-Path "node_modules")) { $null = npm install }
        if (!(Test-Path "android")) { $null = npx cap add android }
        $null = npx cap sync android
    } finally {
        Pop-Location
    }
    $gradle = Join-Path $MobileRoot "android\\gradlew.bat"
    if (!(Test-Path $gradle)) {
        Write-Host "Gradle wrapper nao encontrado. Abra o projeto no Android Studio e gere o APK." -ForegroundColor Red
        return $null
    }
    Push-Location (Join-Path $MobileRoot "android")
    try {
        $null = & $gradle assembleRelease
    } finally {
        Pop-Location
    }
    $apkOut = Join-Path $MobileRoot "android\\app\\build\\outputs\\apk\\release\\app-release.apk"
    if (Test-Path $apkOut) { return $apkOut }
    $apkUnsigned = Join-Path $MobileRoot "android\\app\\build\\outputs\\apk\\release\\app-release-unsigned.apk"
    if (Test-Path $apkUnsigned) {
        Write-Host "APK assinado nao encontrado. Usando APK unsigned." -ForegroundColor Yellow
        return $apkUnsigned
    }
    Write-Host "APK nao encontrado apos build: $apkOut" -ForegroundColor Red
    return $null
}

if ($BuildAndroid) {
    Write-Host "Gerando APK (Android)..." -ForegroundColor Cyan
    $apkBuilt = Build-AndroidApk -MobileRoot $mobileRoot
    if ($apkBuilt) { $ApkPath = $apkBuilt }
}

if ($BuildIos) {
    if ($IsWindows) {
        Write-Host "Build iOS nao suportado no Windows. Use macOS + Xcode." -ForegroundColor Yellow
    } else {
        Write-Host "Build iOS requer Xcode e configuracao de assinatura." -ForegroundColor Yellow
    }
}

if (-not [string]::IsNullOrWhiteSpace($ApkPath)) {
    $apkUrlResult = Copy-Artifact -SourcePath $ApkPath -BaseName "appprof" -Version $AppVersion -TargetDir $downloadsRoot -BaseUrl $BaseUrl
    if ($apkUrlResult) { $ApkUrl = $apkUrlResult }
}

if (-not [string]::IsNullOrWhiteSpace($IosPath)) {
    $iosUrlResult = Copy-Artifact -SourcePath $IosPath -BaseName "appprof" -Version $AppVersion -TargetDir $downloadsRoot -BaseUrl $BaseUrl
    if ($iosUrlResult) { $IosUrl = $iosUrlResult }
}

$html = $html -replace "__APP_VERSION__", $AppVersion
if (-not [string]::IsNullOrWhiteSpace($ProfessorUrl)) {
    $html = $html -replace "__PROFESSOR_URL__", $ProfessorUrl
}
if (-not [string]::IsNullOrWhiteSpace($ApkUrl)) {
    $html = $html -replace "__APK_URL__", $ApkUrl
}
if (-not [string]::IsNullOrWhiteSpace($IosUrl)) {
    $html = $html -replace "__IOS_URL__", $IosUrl
}

$html = [regex]::Replace($html, '(?<=Versão <strong>)[^<]*(?=</strong>)', $AppVersion)
if (-not [string]::IsNullOrWhiteSpace($ProfessorUrl)) {
    $html = [regex]::Replace($html, '(?<=class="btn btn-primary" href=")[^"]*(?=")', $ProfessorUrl)
}
if (-not [string]::IsNullOrWhiteSpace($ApkUrl)) {
    $html = [regex]::Replace($html, '(?<=class="btn btn-android" href=")[^"]*(?=")', $ApkUrl)
}
if (-not [string]::IsNullOrWhiteSpace($IosUrl)) {
    $html = [regex]::Replace($html, '(?<=class="btn btn-ios" href=")[^"]*(?=")', $IosUrl)
}

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
            $content = [regex]::Replace($content, 'data-version="[^"]*"', "data-version=""$AppVersion""")
            Set-Content -Path $page -Value $content -Encoding UTF8
            Write-Host "Versao atualizada: $page" -ForegroundColor Green
        }
    }
}

Write-Host ""
if (-not $SkipGit) {
    Write-Host "Git: preparando commit..." -ForegroundColor Cyan
    $gitAvailable = Ensure-Command "git"
    if ($gitAvailable) {
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
    } else {
        Write-Host "Git nao encontrado. Pulei commit/push." -ForegroundColor Yellow
    }
}

if (-not $SkipVercel) {
    Write-Host "Vercel: iniciando deploy..." -ForegroundColor Cyan
    if (Ensure-Command "vercel") {
        if (-not [string]::IsNullOrWhiteSpace($VercelProjectId)) {
            $vercelDir = Join-Path $root ".vercel"
            if (!(Test-Path $vercelDir)) { New-Item -ItemType Directory -Force -Path $vercelDir | Out-Null }
            if ([string]::IsNullOrWhiteSpace($VercelOrgId)) {
                Write-Host "Vercel orgId não informado. Execute 'vercel link' ou informe -VercelOrgId para fixar o projeto automaticamente." -ForegroundColor Yellow
            } else {
                $projectJson = @{ orgId = $VercelOrgId; projectId = $VercelProjectId } | ConvertTo-Json
                Set-Content -Path (Join-Path $vercelDir "project.json") -Value $projectJson -Encoding UTF8
                Write-Host "Vercel project.json atualizado." -ForegroundColor Green
            }
        }
        $vercelToken = $env:VERCEL_TOKEN
        if ($vercelToken) {
            vercel --prod --token $vercelToken
        } else {
            vercel --prod
        }
    } else {
        Write-Host "Vercel CLI nao encontrado. Rode 'npm i -g vercel' e tente novamente." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Concluido." -ForegroundColor Green
