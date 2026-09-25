const TARGETS = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'])

export function mapExecutorPlatform(os, arch) {
  const normalizedOs = {
    linux: 'linux',
    darwin: 'darwin',
    macos: 'darwin',
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
  return `kala-executor-${target}`
}

export function generateExecutorInstallerSh({ repo, tag }) {
  const base = githubReleaseBase(repo, tag)
  return `#!/usr/bin/env bash
set -euo pipefail
BASE_URL="\${RUNLAB_RELEASE_ASSETS_URL:-${base}}"
MAX_METADATA_BYTES="\${RUNLAB_INSTALLER_MAX_METADATA_BYTES:-1048576}"
WORK_DIR="\${RUNLAB_INSTALLER_WORK_DIR:-$(mktemp -d)}"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT
fail() { printf 'Kala installer: %s\\n' "$*" >&2; exit 1; }
[ "\${RUNLAB_INSTALLER_ALLOW_UNSIGNED:-0}" = 1 ] || fail "release signatures are not available; refusing unsigned install (set RUNLAB_INSTALLER_ALLOW_UNSIGNED=1 only for development)"
command -v wget >/dev/null 2>&1 || fail "wget is required"
command -v uname >/dev/null 2>&1 || fail "uname is required"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m | tr '[:upper:]' '[:lower:]')
case "$os" in linux) os=linux ;; darwin) os=darwin ;; *) fail "unsupported OS: $os (this release supports Linux and macOS only)" ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "unsupported architecture: $arch" ;; esac
target="$os-$arch"
asset="kala-executor-$target"
download_metadata() {
  name="$1"; wget -q --https-only --tries=3 --timeout=30 -O "$WORK_DIR/$name" "$BASE_URL/$name" || fail "failed to download $name"
  size=$(wc -c < "$WORK_DIR/$name" | tr -d ' '); [ "$size" -le "$MAX_METADATA_BYTES" ] || fail "$name exceeds metadata size limit"
}
download_metadata SHA256SUMS
expected=$(awk -v file="$asset" '$2 == file && $1 ~ /^[0-9a-fA-F]{64}$/ {print tolower($1)}' "$WORK_DIR/SHA256SUMS")
use_node=0
if [ -z "$expected" ]; then
  asset="kala-executor.cjs"
  expected=$(awk -v file="$asset" '$2 == file && $1 ~ /^[0-9a-fA-F]{64}$/ {print tolower($1)}' "$WORK_DIR/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no valid entry for the native Executor or Node.js fallback"
  command -v node >/dev/null 2>&1 || fail "No native Executor is published for $target. Install Node.js 22+ and retry."
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)
  [ "$node_major" -ge 22 ] || fail "Node.js 22+ is required for the Executor fallback (found $(node --version 2>/dev/null || printf unknown))"
  use_node=1
fi
wget -q --https-only --tries=3 --timeout=30 -O "$WORK_DIR/$asset" "$BASE_URL/$asset" || fail "failed to download $asset"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$WORK_DIR/$asset" | awk '{print $1}'); elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$WORK_DIR/$asset" | awk '{print $1}'); else fail "sha256sum or shasum is required"; fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset"
if [ "$use_node" = 1 ]; then exec node "$WORK_DIR/$asset" --internal-installer "$@"; fi
chmod +x "$WORK_DIR/$asset"
exec "$WORK_DIR/$asset" --internal-installer "$@"
`
}

function githubReleaseBase(repo, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid release repo')
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error('invalid release tag')
  return `https://github.com/${repo}/releases/${tag === 'latest' ? 'latest/download' : `download/${tag}`}`
}
