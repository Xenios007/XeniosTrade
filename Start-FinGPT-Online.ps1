# Starts the local FinGPT model server (:8011) and the Cloudflare tunnel that publishes it as https://llm.projxenios.trade.
# Each one opens in its own window: close that window to stop it. Anything already running is left alone.
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$python = Join-Path $repo 'server\local-llm\.venv\Scripts\python.exe'
$serverScript = Join-Path $repo 'server\local-llm\server.py'
$cloudflared = Join-Path $env:USERPROFILE 'cloudflared\cloudflared.exe'
$tunnelConfig = Join-Path $env:USERPROFILE 'cloudflared\config.yml'
$publicUrl = 'https://llm.projxenios.trade'

function Test-Port([int]$Port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-Health {
  try { (Invoke-RestMethod -Uri 'http://127.0.0.1:8011/health' -TimeoutSec 3).status } catch { $null }
}

Write-Host ''
Write-Host '=== FinGPT online ===' -ForegroundColor Cyan

foreach ($required in @($python, $serverScript, $cloudflared, $tunnelConfig)) {
  if (-not (Test-Path $required)) { Write-Host "Missing: $required" -ForegroundColor Red; if (-not $NoPause) { Read-Host 'Press Enter to close' }; exit 1 }
}

# 1. Model server
if (Test-Port 8011) {
  Write-Host 'Model server: already running on port 8011.' -ForegroundColor Yellow
} else {
  Write-Host 'Model server: starting (loads the 8B model into the GPU, about 30 s)...'
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -ArgumentList '/k', "title FinGPT model server (close to stop) && `"$python`" `"$serverScript`""
}

# 2. Tunnel
if (Get-Process -Name cloudflared -ErrorAction SilentlyContinue) {
  Write-Host 'Tunnel: already running.' -ForegroundColor Yellow
} else {
  Write-Host 'Tunnel: starting...'
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory (Split-Path $cloudflared) -ArgumentList '/k', "title FinGPT tunnel (close to stop) && `"$cloudflared`" tunnel --config `"$tunnelConfig`" run xenios-llm"
}

# 3. Wait for the model, then confirm the public URL answers
Write-Host 'Waiting for the model to be ready...'
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  if ((Get-Health) -eq 'ready') { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  Write-Host 'The model did not become ready in 3 minutes. Check the "FinGPT model server" window for errors.' -ForegroundColor Red
} else {
  Write-Host 'Model: ready (local http://127.0.0.1:8011).' -ForegroundColor Green
  $public = $null
  for ($i = 0; $i -lt 15; $i++) {
    try { $public = (Invoke-RestMethod -Uri "$publicUrl/health" -TimeoutSec 5).status; break } catch { Start-Sleep -Seconds 2 }
  }
  if ($public -eq 'ready') { Write-Host "Online: $publicUrl is reachable." -ForegroundColor Green }
  else { Write-Host "Model is up locally, but $publicUrl is not answering yet. Give the tunnel a few more seconds." -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'To stop FinGPT, close the "FinGPT model server" and "FinGPT tunnel" windows.'
if (-not $NoPause) { Read-Host 'Press Enter to close this window' }
