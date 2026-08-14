const TARGETS = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'])

export function mapExecutorPlatform(os, arch) {
  const normalizedOs = {
    linux: 'linux',
    darwin: 'darwin',
    macos: 'darwin',
    win32: 'win32',
    windows: 'win32',
    mingw: 'win32',
    msys: 'win32',
    cygwin: 'win32',
  }[String(os).toLowerCase()]
  const normalizedArch = {
    x64: 'x64',
    x86_64: 'x64',
    amd64: 'x64',
    arm64: 'arm64',
    aarch64: 'arm64',
  }[String(arch).toLowerCase()]
  const target = normalizedOs && normalizedArch ? `${normalizedOs}-${normalizedArch}` : undefined
  return target && TARGETS.has(target) ? target : undefined
}

export function executorNativeAssetName(target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported executor target ${target}`)
  return `runlab-executor-${target}${target.startsWith('win32-') ? '.exe' : ''}`
}

export function legacyExecutorNativeAssetName(target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported executor target ${target}`)
  return `agent-kernel-executor-${target}${target.startsWith('win32-') ? '.exe' : ''}`
}

export function generateExecutorInstallerSh({ repo, tag }) {
  const base = githubReleaseBase(repo, tag)
  return `#!/usr/bin/env bash
set -euo pipefail
BASE_URL="\${RUNLAB_RELEASE_ASSETS_URL:-${base}}"
MAX_METADATA_BYTES="\${RUNLAB_INSTALLER_MAX_METADATA_BYTES:-1048576}"
WORK_DIR="\${RUNLAB_INSTALLER_WORK_DIR:-$(mktemp -d)}"
trap 'rm -rf "$WORK_DIR"' EXIT
fail() { printf 'Agent RunLab installer: %s\\n' "$*" >&2; exit 1; }
[ "\${RUNLAB_INSTALLER_ALLOW_UNSIGNED:-0}" = 1 ] || fail "release signatures are not available; refusing unsigned install (set RUNLAB_INSTALLER_ALLOW_UNSIGNED=1 only for development)"
command -v wget >/dev/null 2>&1 || fail "wget is required"
command -v uname >/dev/null 2>&1 || fail "uname is required"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m | tr '[:upper:]' '[:lower:]')
case "$os" in linux) os=linux ;; darwin) os=darwin ;; mingw*|msys*|cygwin*) os=win32 ;; *) fail "unsupported OS: $os" ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "unsupported architecture: $arch" ;; esac
target="$os-$arch"
asset="runlab-executor-$target"; [ "$os" = win32 ] && asset="$asset.exe"
download_metadata() {
  name="$1"; wget -q --https-only --tries=3 --timeout=30 -O "$WORK_DIR/$name" "$BASE_URL/$name" || fail "failed to download $name"
  size=$(wc -c < "$WORK_DIR/$name" | tr -d ' '); [ "$size" -le "$MAX_METADATA_BYTES" ] || fail "$name exceeds metadata size limit"
}
download_metadata SHA256SUMS
expected=$(awk -v file="$asset" '$2 == file && $1 ~ /^[0-9a-fA-F]{64}$/ {print tolower($1)}' "$WORK_DIR/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no valid entry for $asset"
wget -q --https-only --tries=3 --timeout=30 -O "$WORK_DIR/$asset" "$BASE_URL/$asset" || fail "failed to download $asset"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$WORK_DIR/$asset" | awk '{print $1}'); elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$WORK_DIR/$asset" | awk '{print $1}'); else fail "sha256sum or shasum is required"; fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset"
chmod +x "$WORK_DIR/$asset"
exec "$WORK_DIR/$asset" --internal-installer "$@"
`
}

export function generateExecutorInstallerPs1({ repo, tag }) {
  const base = githubReleaseBase(repo, tag)
  return `# Agent RunLab executor installer (unsigned development bootstrap)
$ErrorActionPreference = 'Stop'
if ($env:RUNLAB_INSTALLER_ALLOW_UNSIGNED -ne '1') { throw 'Release signatures are not available; refusing unsigned install. Set RUNLAB_INSTALLER_ALLOW_UNSIGNED=1 only for development.' }
$baseUrl = if ($env:RUNLAB_RELEASE_ASSETS_URL) { $env:RUNLAB_RELEASE_ASSETS_URL.TrimEnd('/') } else { '${base}' }
$maxBytes = if ($env:RUNLAB_INSTALLER_MAX_METADATA_BYTES) { [int64]$env:RUNLAB_INSTALLER_MAX_METADATA_BYTES } else { 1048576 }
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$arch = switch ($arch) { 'x64' { 'x64' } 'arm64' { 'arm64' } default { throw "Unsupported architecture: $arch" } }
$os = if ($IsWindows) { 'win32' } elseif ($IsLinux) { 'linux' } elseif ($IsMacOS) { 'darwin' } else { throw 'Unsupported OS' }
$target = "$os-$arch"
$asset = "runlab-executor-$target" + $(if ($os -eq 'win32') { '.exe' } else { '' })
$work = Join-Path ([IO.Path]::GetTempPath()) ("runlab-installer-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $name = 'SHA256SUMS'
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$name" -OutFile (Join-Path $work $name)
  if ((Get-Item (Join-Path $work $name)).Length -gt $maxBytes) { throw "$name exceeds metadata size limit" }
  $escaped = [regex]::Escape($asset)
  $line = Get-Content (Join-Path $work 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-fA-F]{64})  $escaped$" } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS has no valid entry for $asset" }
  $expected = ($line -split '\\s+')[0].ToLowerInvariant()
  $binary = Join-Path $work $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $binary
  $actual = (Get-FileHash -Algorithm SHA256 $binary).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum mismatch for $asset" }
  & $binary --internal-installer @args
  exit $LASTEXITCODE
} finally { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
`
}

function githubReleaseBase(repo, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid release repo')
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error('invalid release tag')
  return `https://github.com/${repo}/releases/${tag === 'latest' ? 'latest/download' : `download/${tag}`}`
}
