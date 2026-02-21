Param(
    [string]$AppVersion = "",
    [string]$ProfessorUrl = "https://eebgv.vercel.app/apoia/professor.html",
    [string]$BaseUrl = "https://eebgv.vercel.app",
    [string]$ApkUrl = "https://eebgv.vercel.app/appprof/downloads/appprof.apk",
    [string]$IosUrl = "https://eebgv.vercel.app/appprof/downloads/appprof.ipa",
    [string]$ApkPath = "",
    [string]$IosPath = "",
    [switch]$UpdateProfessorVersion,
    [switch]$AutoVersion
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "deploy-appprof.ps1"

& $script `
  -AppVersion $AppVersion `
  -ProfessorUrl $ProfessorUrl `
  -BaseUrl $BaseUrl `
  -ApkUrl $ApkUrl `
  -IosUrl $IosUrl `
  -ApkPath $ApkPath `
  -IosPath $IosPath `
  -UpdateProfessorVersion:$UpdateProfessorVersion `
  -AutoVersion:$AutoVersion `
  -SkipGit `
  -SkipVercel
