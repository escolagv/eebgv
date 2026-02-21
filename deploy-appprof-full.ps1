Param(
    [string]$AppVersion = "",
    [string]$ProfessorUrl = "https://eebgv.vercel.app/apoia/professor.html",
    [string]$BaseUrl = "https://eebgv.vercel.app",
    [string]$GitRemoteUrl = "https://github.com/escolagv/eebgv.git",
    [string]$GitBranch = "main",
    [string]$GitCommitMessage = "chore: deploy appprof",
    [switch]$UpdateProfessorVersion,
    [switch]$AutoVersion,
    [string]$VercelProjectId = "",
    [string]$VercelOrgId = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "deploy-appprof.ps1"

& $script `
  -BuildAndroid `
  -AppVersion $AppVersion `
  -ProfessorUrl $ProfessorUrl `
  -BaseUrl $BaseUrl `
  -GitRemoteUrl $GitRemoteUrl `
  -GitBranch $GitBranch `
  -GitCommitMessage $GitCommitMessage `
  -UpdateProfessorVersion:$UpdateProfessorVersion `
  -AutoVersion:$AutoVersion `
  -VercelProjectId $VercelProjectId `
  -VercelOrgId $VercelOrgId
