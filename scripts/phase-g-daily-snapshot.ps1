# Phase G daily snapshot wrapper — run by Windows Task Scheduler.
# Writes 24h monitor output to docs/phase-g-snapshots/YYYY-MM-DD.txt and
# echoes Phase G gates status. No-op safe if CLI hasn't been used yet.
#
# Schedule (create once):
#   schtasks /create /tn "MuonroiPilDailySnapshot" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File D:\sources\Core\muonroi-cli\scripts\phase-g-daily-snapshot.ps1" /sc daily /st 09:07 /f
#
# Inspect:   schtasks /query /tn "MuonroiPilDailySnapshot" /v /fo list
# Remove:    schtasks /delete /tn "MuonroiPilDailySnapshot" /f
# Run now:   schtasks /run /tn "MuonroiPilDailySnapshot"

$ErrorActionPreference = 'Stop'
$repo = 'D:\sources\Core\muonroi-cli'
$snapshotDir = Join-Path $repo 'docs\phase-g-snapshots'
$bun = 'C:\Users\phila\.bun\bin\bun.exe'

if (-not (Test-Path $snapshotDir)) {
    New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
}

$date = Get-Date -Format 'yyyy-MM-dd'
$outFile = Join-Path $snapshotDir "$date.txt"

Set-Location $repo

$header = @"
=== PIL Phase G Snapshot ===
Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
Host: $env:COMPUTERNAME
Window: last 24h

"@

# Capture stdout + stderr. monitor-pil.ts exits 0 even when no events.
try {
    $output = & $bun 'scripts/monitor-pil.ts' '--hours' '24' 2>&1 | Out-String
} catch {
    $output = "ERROR running monitor: $_"
}

($header + $output) | Out-File -FilePath $outFile -Encoding utf8 -Force

# Echo to console for "run now" debugging. Task Scheduler captures into history.
Write-Output $header
Write-Output $output
Write-Output "Snapshot written: $outFile"
