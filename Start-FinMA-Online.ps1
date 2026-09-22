# Starts the local FinMA-7B-full model server (:8012) and the Cloudflare tunnel that publishes it as
# https://finma.projxenios.trade. Each one opens in its own window: close that window to stop it. Anything already
# running is left alone.
#
# This machine's RTX 3070 Ti (8 GB) only has room for one 7-8B NF4 model at a time. If the FinGPT server (port 8011)
# is already running, close its window first — starting FinMA alongside it will likely OOM the GPU.
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$python = Join-Path $repo 'server\local-llm\.venv\Scripts\python.exe'
$serverScript = Join-Path $repo 'server\local-llm\finma-server.py'
$cloudflared = Join-Path $env:USERPROFILE 'cloudflared\cloudflared.exe'
$tunnelConfig = Join-Path $env:USERPROFILE 'cloudflared\config.yml'
$publicUrl = 'https://finma.projxenios.trade'

function Test-Port([int]$Port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-Health {
  try { (Invoke-RestMethod -Uri 'http://127.0.0.1:8012/health' -TimeoutSec 3).status } catch { $null }
}

Write-Host ''
Write-Host '=== FinMA online ===' -ForegroundColor Cyan

foreach ($required in @($python, $serverScript, $cloudflared, $tunnelConfig)) {
  if (-not (Test-Path $required)) { Write-Host "Missing: $required" -ForegroundColor Red; if (-not $NoPause) { Read-Host 'Press Enter to close' }; exit 1 }
}

if (Test-Port 8011) {
  Write-Host 'Heads up: the FinGPT server (port 8011) also looks like it is running. This card usually only has' -ForegroundColor Yellow
  Write-Host 'room for one 7-8B model at a time — close the "FinGPT model server" window if FinMA fails to load.' -ForegroundColor Yellow
}

# 1. Model server
if (Test-Port 8012) {
  Write-Host 'Model server: already running on port 8012.' -ForegroundColor Yellow
} else {
  Write-Host 'Model server: starting (loads the 7B model into the GPU, about 30 s)...'
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -ArgumentList '/k', "title FinMA model server (close to stop) && `"$python`" `"$serverScript`""
}

# 2. Tunnel (shared with FinGPT: one cloudflared process, config.yml routes both hostnames by port)
if (Get-Process -Name cloudflared -ErrorAction SilentlyContinue) {
  Write-Host 'Tunnel: already running.' -ForegroundColor Yellow
} else {
  Write-Host 'Tunnel: starting...'
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory (Split-Path $cloudflared) -ArgumentList '/k', "title FinMA tunnel (close to stop) && `"$cloudflared`" tunnel --config `"$tunnelConfig`" run xenios-llm"
}

# 3. Wait for the model, then confirm the public URL answers
Write-Host 'Waiting for the model to be ready...'
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  if ((Get-Health) -eq 'ready') { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  Write-Host 'The model did not become ready in 3 minutes. Check the "FinMA model server" window for errors' -ForegroundColor Red
  Write-Host '(a 401/GatedRepoError there means the HuggingFace access gate for finma-7b-full has not been accepted yet — see the comment at the top of server\local-llm\finma-server.py).' -ForegroundColor Red
} else {
  Write-Host 'Model: ready (local http://127.0.0.1:8012).' -ForegroundColor Green
  $public = $null
  for ($i = 0; $i -lt 15; $i++) {
    try { $public = (Invoke-RestMethod -Uri "$publicUrl/health" -TimeoutSec 5).status; break } catch { Start-Sleep -Seconds 2 }
  }
  if ($public -eq 'ready') { Write-Host "Online: $publicUrl is reachable." -ForegroundColor Green }
  else { Write-Host "Model is up locally, but $publicUrl is not answering yet. Give the tunnel a few more seconds." -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'To stop FinMA, close the "FinMA model server" and "FinMA tunnel" windows.'
if (-not $NoPause) { Read-Host 'Press Enter to close this window' }
