param(
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendUrl = 'http://127.0.0.1:5173'
$backendHealthUrl = 'http://127.0.0.1:3001/api/health'
$logDir = Join-Path $projectRoot 'launcher-logs'
$viteScriptPath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-HttpEndpoint {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-ForEndpoint {
  param(
    [string]$Url,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint -Url $Url) {
      return $true
    }

    Start-Sleep -Milliseconds 500
  }

  return Test-HttpEndpoint -Url $Url
}

$nodePath = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $viteScriptPath)) {
  throw 'Vite is not installed. Run npm install in the project folder first.'
}

if (-not (Test-HttpEndpoint -Url $backendHealthUrl)) {
  Start-Process `
    -FilePath $nodePath `
    -ArgumentList 'server/mock-trading-server.js' `
    -WorkingDirectory $projectRoot `
    -WindowStyle Minimized `
    -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
    -RedirectStandardError (Join-Path $logDir 'backend.err.log') | Out-Null

  if (-not (Wait-ForEndpoint -Url $backendHealthUrl -TimeoutSeconds 20)) {
    throw 'Backend did not start on 127.0.0.1:3001.'
  }
}

if (-not (Test-HttpEndpoint -Url $frontendUrl)) {
  Start-Process `
    -FilePath $nodePath `
    -ArgumentList $viteScriptPath, '--host', '127.0.0.1' `
    -WorkingDirectory $projectRoot `
    -WindowStyle Minimized `
    -RedirectStandardOutput (Join-Path $logDir 'frontend.out.log') `
    -RedirectStandardError (Join-Path $logDir 'frontend.err.log') | Out-Null

  if (-not (Wait-ForEndpoint -Url $frontendUrl -TimeoutSeconds 30)) {
    throw 'Frontend did not start on 127.0.0.1:5173.'
  }
}

if (-not $SkipBrowser) {
  Start-Process $frontendUrl | Out-Null
}
