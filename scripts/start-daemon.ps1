# Start the Cursor Remote daemon (Windows PowerShell)
# Usage:  .\scripts\start-daemon.ps1
# Or:     npm run daemon:start

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$env:PORT = if ($env:PORT) { $env:PORT } else { "7843" }
$env:BIND_HOST = if ($env:BIND_HOST) { $env:BIND_HOST } else { "0.0.0.0" }
$env:CDP_URL = if ($env:CDP_URL) { $env:CDP_URL } else { "http://127.0.0.1:9222" }
$env:DATA_DIR = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $env:USERPROFILE ".cursor-remote" }

$dist = Join-Path $Root "packages\daemon\dist\index.js"
if (-not (Test-Path $dist)) {
  Write-Host "[cursor-remote] dist missing — building…"
  npm run build
}

Write-Host "[cursor-remote] daemon PORT=$env:PORT DATA_DIR=$env:DATA_DIR"
npm run daemon
