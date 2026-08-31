# Stop any dev processes (bot / dev database) started from this project.
$pattern = Join-Path $PSScriptRoot ".."
$pattern = (Resolve-Path $pattern).Path

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*ZenDiscordBot*" } |
  ForEach-Object {
    Write-Host "Stopping PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Write-Host "Done."
