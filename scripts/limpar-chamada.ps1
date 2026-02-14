Param(
    [string]$DataAtual = $(Get-Date).ToString('yyyy-MM-dd'),
    [int]$TurmaId = 10,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Ensure-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "Comando ausente: $name"
        exit 1
    }
}

Ensure-Command 'supabase'

if (-not $Force) {
    $confirm = Read-Host "Confirma deletar presença da turma $TurmaId na data $DataAtual? (s/n)"
    if ($confirm -notin 's','S','sim','SIM') {
        Write-Host 'Operação cancelada.'
        exit 0
    }
}

$sql = "DELETE FROM presencas WHERE data = '$DataAtual' AND turma_id = $TurmaId;"
Write-Host "Executando: $sql"

$result = & supabase db query --sql $sql
Write-Host $result

Write-Host "Registros removidos para turma $TurmaId em $DataAtual."
