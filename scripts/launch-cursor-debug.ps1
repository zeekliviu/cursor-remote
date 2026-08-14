# Launch Cursor with CDP enabled (Windows PowerShell)
# Prefer: npm run cursor

param(
  [int]$CdpPort = 9222,
  [string]$CursorBin = ""
)

if (-not $CursorBin) {
  $CursorBin = Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"
}

if (-not (Test-Path $CursorBin)) {
  Write-Error "Cursor not found at $CursorBin. Pass -CursorBin path\to\Cursor.exe"
}

Write-Host "Starting Cursor with remote debugging on 127.0.0.1:$CdpPort"
Write-Host "Keep this port localhost-only. The daemon proxies to the phone."
Start-Process -FilePath $CursorBin -ArgumentList "--remote-debugging-port=$CdpPort"
