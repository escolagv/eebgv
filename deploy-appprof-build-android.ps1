Param(
    [string]$AppVersion = "1.0.0",
    [string]$ProfessorUrl = "https://eebgv.vercel.app/apoia/professor.html",
    [string]$BaseUrl = "https://eebgv.vercel.app",
    [switch]$UpdateProfessorVersion
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "deploy-appprof.ps1"

& $script `
  -BuildAndroid `
  -AppVersion $AppVersion `
  -ProfessorUrl $ProfessorUrl `
  -BaseUrl $BaseUrl `
  -UpdateProfessorVersion:$UpdateProfessorVersion `
  -SkipGit `
  -SkipVercel
