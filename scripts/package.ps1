param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Version,
  [Parameter(Position = 1)]
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"
$Version = $Version.TrimStart("v")
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$') {
  throw "invalid release version: $Version"
}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path $OutputDirectory).Path

pnpm --dir web install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  throw "frontend dependency installation failed"
}
pnpm --dir web build
if ($LASTEXITCODE -ne 0) {
  throw "frontend build failed"
}
node scripts/generate-third-party-licenses.mjs
if ($LASTEXITCODE -ne 0) {
  throw "license generation failed"
}
git diff --exit-code -- THIRD_PARTY_LICENSES.txt
if ($LASTEXITCODE -ne 0) {
  throw "THIRD_PARTY_LICENSES.txt is stale"
}

$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("gitna-package-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
  $env:GOOS = "windows"
  $env:GOARCH = "amd64"
  $env:CGO_ENABLED = "0"
  go build -trimpath -ldflags "-s -w -X main.version=$Version" -o (Join-Path $Stage "gitna.exe") ./cmd/gitna
  if ($LASTEXITCODE -ne 0) {
    throw "go build failed"
  }

  Copy-Item LICENSE, README.md, THIRD_PARTY_NOTICES.md, THIRD_PARTY_LICENSES.txt -Destination $Stage
  Copy-Item LICENSES -Destination $Stage -Recurse
  $Archive = Join-Path $OutputDirectory "gitna_${Version}_windows_x64.zip"
  Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Archive -Force
} finally {
  Remove-Item Env:GOOS -ErrorAction SilentlyContinue
  Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
  Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
  Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
