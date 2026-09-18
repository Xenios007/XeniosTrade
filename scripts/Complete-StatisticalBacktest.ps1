param(
  [Parameter(Mandatory = $true)][int]$ReplayProcessId,
  [Parameter(Mandatory = $true)][string]$RunId
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
while (Get-Process -Id $ReplayProcessId -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 30
}

$registry = Get-Content (Join-Path $workspace 'server/data/backtest-runs.json') -Raw | ConvertFrom-Json
$run = $registry | Where-Object { $_.id -eq $RunId } | Select-Object -First 1
if (-not $run -or $run.status -ne 'complete') {
  throw "Replay $RunId did not finish successfully; statistical review was not run."
}

Set-Location $workspace
& node --max-old-space-size=6144 server/backtest/statistical-review.js --run-id $RunId
