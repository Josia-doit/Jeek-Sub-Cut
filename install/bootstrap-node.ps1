# Bootstrap the bundled Node.js runtime.
# Runs on Windows PowerShell 5.1+ with zero prerequisites: downloads the portable
# Node.js zip, verifies its SHA-256 against the official checksum, and unpacks it
# to install/runtime/node. Idempotent: exits immediately when node.exe exists.
#
# This script exists because install-deps.mjs itself needs Node to run.
# It is invoked by 安装依赖.bat and 启动.bat before any .mjs is executed.

param([string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Read version / checksum / mirrors from deps.json (single source of truth).
$depsFile = Join-Path $Root 'install\deps.json'
if (-not (Test-Path $depsFile)) { Write-Error "[node] missing deps.json: $depsFile"; exit 1 }
$deps = Get-Content -Raw -Encoding UTF8 -Path $depsFile | ConvertFrom-Json
$boot = $deps.bootstrapNode
if (-not $boot) { Write-Error '[node] deps.json has no bootstrapNode section'; exit 1 }

$version = $boot.version
$sha     = $boot.sha256.ToLowerInvariant()
$zipName = "node-v$version-win-x64.zip"
$inner   = "node-v$version-win-x64"

$nodeDir = Join-Path $Root $boot.target.Replace('/', '\')
$nodeExe = Join-Path $nodeDir 'node.exe'

# Already installed -> nothing to do.
if (Test-Path $nodeExe) {
    Write-Host "[node] bundled Node.js ready: $nodeExe"
    & $nodeExe -v
    exit 0
}

Write-Host '[node] Bundled Node.js not found. Bootstrapping...'

$cacheDir = Join-Path $Root 'install\.cache\node'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$zipPath = Join-Path $cacheDir $zipName

$urls = @($boot.urls | ForEach-Object { $_.Replace('{V}', $version) })

# Download with mirror fallback. Prefer curl.exe (Windows 10 1803+), fall back
# to Invoke-WebRequest on older systems.
if (-not (Test-Path $zipPath)) {
    foreach ($u in $urls) {
        Write-Host "[node] trying $u"
        $ok = $false
        try {
            $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
            if (Test-Path $curl) {
                & $curl -fsSL --max-time 300 -o $zipPath $u
                $ok = ($LASTEXITCODE -eq 0) -and (Test-Path $zipPath) -and ((Get-Item $zipPath).Length -gt 1000000)
            } else {
                Invoke-WebRequest -Uri $u -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
                $ok = (Test-Path $zipPath) -and ((Get-Item $zipPath).Length -gt 1000000)
            }
        } catch {
            $ok = $false
        }
        if ($ok) { Write-Host '[node] download ok'; break }
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Write-Host '[node] mirror failed, trying next...'
    }
}
if (-not (Test-Path $zipPath)) {
    Write-Error '[node] Failed to download Node.js from all mirrors. Check your network.'
    exit 1
}

# Verify against the official SHA-256 (never trust an unverified binary).
$actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
if ($actual -ne $sha) {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Write-Error "[node] SHA-256 mismatch: $actual (expected $sha)"
    exit 1
}
Write-Host '[node] sha256 verified'

# Unpack and strip the single top-level folder so node.exe lands directly in
# install/runtime/node. Use Windows' built-in bsdtar; move is atomic on one drive.
$tmp = Join-Path $cacheDir 'unpack'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) {
    & $tar -xf $zipPath -C $tmp
    if ($LASTEXITCODE -ne 0) { Write-Error '[node] tar extract failed'; exit 1 }
} else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $tmp)
}
$src = Join-Path $tmp $inner
if (-not (Test-Path (Join-Path $src 'node.exe'))) {
    Write-Error '[node] extracted archive is missing node.exe'
    exit 1
}
if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $nodeDir -Parent) | Out-Null
Move-Item -Path $src -Destination $nodeDir

Write-Host "[node] installed to $nodeDir"
& $nodeExe -v
if ($LASTEXITCODE -ne 0) { Write-Error '[node] installed node.exe failed to run'; exit 1 }
exit 0
