# install.ps1 — Windows PowerShell installer for muonroi-cli.
#
# Usage:
#   irm https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.ps1 | iex
#   # or with a specific version:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.ps1))) -Version 1.2.3

[CmdletBinding()]
param(
    [string]$Version,
    [string]$BinaryPath,
    [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"

$App        = "muonroi-cli"
$Repo       = "muonroi/muonroi-cli"
$UserDir    = Join-Path $HOME ".muonroi-cli"
$InstallDir = Join-Path $UserDir "bin"
$Metadata   = Join-Path $UserDir "install.json"
$BinaryName = "muonroi-cli.exe"
$Target     = "windows-x64"
$Asset      = "$App-$Target.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

function Resolve-LatestVersion {
    $api = "https://api.github.com/repos/$Repo/releases/latest"
    $rel = Invoke-RestMethod -Uri $api -UseBasicParsing
    $tag = $rel.tag_name
    return ($tag -replace '^muonroi-cli@', '')
}

function Install-FromRelease {
    param([string]$Version)
    $base = "https://github.com/$Repo/releases/download/muonroi-cli@$Version"
    $tmp  = New-TemporaryFile
    $bin  = "$tmp.exe"
    $sha  = "$tmp.checksums.txt"

    Write-Host "Downloading $Asset ..."
    Invoke-WebRequest "$base/$Asset"        -OutFile $bin -UseBasicParsing
    Invoke-WebRequest "$base/checksums.txt" -OutFile $sha -UseBasicParsing

    $expected = (Get-Content $sha | Where-Object { $_ -match "\s\*?$Asset$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
    $actual   = (Get-FileHash -Algorithm SHA256 $bin).Hash.ToLower()
    if (-not $expected) { throw "Missing checksum for $Asset." }
    if ($actual -ne $expected.ToLower()) { throw "Checksum mismatch for $Asset (expected $expected, got $actual)." }

    Copy-Item $bin (Join-Path $InstallDir $BinaryName) -Force
    Remove-Item $tmp, $bin, $sha -ErrorAction SilentlyContinue
}

function Install-FromBinary {
    param([string]$Path)
    if (-not (Test-Path $Path)) { throw "Binary not found at $Path" }
    Copy-Item $Path (Join-Path $InstallDir $BinaryName) -Force
}

function Update-UserPath {
    if ($NoModifyPath) { return }
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current -split ';' -contains $InstallDir) { return }
    $next = if ($current) { "$current;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
    Write-Host "Added $InstallDir to user PATH. Restart your shell to pick it up."
}

function Write-Metadata {
    param([string]$Version)
    @{
        schemaVersion = 1
        installMethod = "script"
        version       = $Version
        repo          = $Repo
        binaryPath    = (Join-Path $InstallDir $BinaryName)
        installDir    = $InstallDir
        assetName     = $Asset
        target        = $Target
        installedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        shellConfigPath = $null
        pathCommand     = $null
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $Metadata -Encoding UTF8
}

if ($BinaryPath) {
    Install-FromBinary -Path $BinaryPath
    $resolved = "local"
} else {
    if (-not $Version) { $Version = Resolve-LatestVersion }
    if (-not $Version) { throw "Failed to resolve latest version from GitHub releases." }
    Install-FromRelease -Version $Version
    $resolved = $Version
}

Update-UserPath
Write-Metadata -Version $resolved

Write-Host ""
Write-Host "$App $resolved installed to $(Join-Path $InstallDir $BinaryName)"
Write-Host ""
Write-Host "Run:"
Write-Host "  muonroi-cli --help"
Write-Host ""
Write-Host "To uninstall later:"
Write-Host "  muonroi-cli uninstall"
