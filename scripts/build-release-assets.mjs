#!/usr/bin/env node
import { copyFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'release')
const dashboardDist = join(root, 'packages/dashboard/dist')
const options = parseOptions(process.argv.slice(2))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { component, tag, nativeOnly, finalizeOnly, noNative } = options
const repo = options.repo ?? repoFromPackageJson(packageJson)
if (!repo && component !== 'dashboard') {
  throw new Error('release repo is required; pass --repo owner/name or set GITHUB_REPOSITORY')
}
const wantsNativeBuild = !finalizeOnly && (nativeOnly || !noNative)
const currentNativeTarget = wantsNativeBuild ? detectNativeTarget() : undefined
const nativeTarget = wantsNativeBuild ? options.nativeTarget ?? currentNativeTarget : undefined

mkdirSync(outDir, { recursive: true })

const allEntries = [
  {
    name: 'agent-kernel-host',
    component: 'host',
    entry: join(root, 'packages/host/bin/agent-kernel-host.ts'),
  },
  {
    name: 'agent-kernel-executor',
    component: 'executor',
    entry: join(root, 'packages/executor/bin/agent-kernel-executor.ts'),
  },
]
const entries = allEntries.filter((entry) => component === 'all' || entry.component === component)
const includeDashboard = component === 'all' || component === 'host' || component === 'dashboard'
const nativeTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']
const expectedAssets = [
  ...allEntries.map((entry) => `${entry.name}.cjs`),
  ...allEntries.flatMap((entry) => nativeTargets.map((target) => nativeAssetName(entry.name, target))),
  'agent-kernel-dashboard-dist.tar.gz',
  'run.sh',
  'RELEASE_NOTES.md',
  'manifest.json',
  'SHA256SUMS',
]
const legacyAssets = ['run-host.sh', 'run-executor.sh']
for (const asset of !nativeOnly && !finalizeOnly ? [...expectedAssets, ...legacyAssets] : []) {
  rmSync(join(outDir, asset), { force: true })
}

if (finalizeOnly) {
  finalizeRelease()
  process.exit(0)
}

if (wantsNativeBuild && nativeTarget !== currentNativeTarget) {
  throw new Error(`native target ${nativeTarget} does not match this runner (${currentNativeTarget}); Node SEA builds are not cross-compiled`)
}

if (includeDashboard && !nativeOnly) {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'])
}

for (const item of entries) {
  const outfile = nativeOnly
    ? join(outDir, '.sea', `${item.name}-${nativeTarget}`, `${item.name}.cjs`)
    : join(outDir, `${item.name}.cjs`)
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [item.entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  const bundled = readFileSync(outfile, 'utf8')
  writeFileSync(outfile, keepSingleShebang(bundled))
  if (!nativeOnly) chmodSync(outfile, 0o755)
  if (nativeOnly || !noNative) {
    await buildNativeSea(item.name, outfile, nativeTarget)
  }
}

if (nativeOnly) {
  console.log(`native release assets written to ${outDir} for ${nativeTarget}`)
  for (const item of entries) console.log(` - ${basename(nativeAssetName(item.name, nativeTarget))}`)
  process.exit(0)
}

if (includeDashboard) {
  await run('tar', [
    '-czf',
    join(outDir, 'agent-kernel-dashboard-dist.tar.gz'),
    '-C',
    dashboardDist,
    '.',
  ])
}

finalizeRelease()

console.log(`release assets written to ${outDir}`)
for (const file of [...releaseFiles(), 'SHA256SUMS']) {
  console.log(` - ${basename(file)}`)
}

function finalizeRelease() {
  const bootstrapAssets = []
  if (component !== 'dashboard') {
    const path = join(outDir, 'run.sh')
    writeFileSync(path, unifiedBootstrap({ repo, tag, component }))
    chmodSync(path, 0o755)
    bootstrapAssets.push('run.sh')
  }

  const builtEntries = entries.map((entry) => {
    const cjs = `${entry.name}.cjs`
    const natives = nativeTargets
      .map((target) => nativeAssetName(entry.name, target))
      .filter((asset) => exists(asset))
    return { ...entry, cjs: exists(cjs) ? cjs : undefined, natives }
  })
  const assets = builtEntries.flatMap((entry) => [entry.cjs, ...entry.natives].filter(Boolean))
    .concat(includeDashboard && exists('agent-kernel-dashboard-dist.tar.gz') ? ['agent-kernel-dashboard-dist.tar.gz'] : [])
    .concat(bootstrapAssets)
  const hasNativeAssets = builtEntries.some((entry) => entry.natives.length > 0)
  const manifest = {
    name: packageJson.name,
    version: packageJson.version,
    component,
    repo: repo ?? '',
    tag,
    node: '>=22',
    nativeTargets: nativeTargets.filter((target) => builtEntries.some((entry) => entry.natives.includes(nativeAssetName(entry.name, target)))),
    assets,
    nativeAssets: Object.fromEntries(builtEntries.map((entry) => [entry.component, entry.natives])),
    fallbackAssets: Object.fromEntries(builtEntries.map((entry) => [entry.component, entry.cjs]).filter(([, cjs]) => cjs)),
    notes: [
      hasNativeAssets
        ? 'host and executor releases include native binaries plus Node.js .cjs fallback assets'
        : 'host and executor releases include Node.js .cjs fallback assets; native binaries are added by the native release job',
      'run.sh is a wget-only bash bootstrap that uses compact .cjs assets when Node.js 22+ is available and falls back to native binaries otherwise',
      'host releases include the dashboard dist because agent-kernel-host serves it when DASHBOARD_DIR is set',
    ],
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(outDir, 'RELEASE_NOTES.md'), releaseNotes(manifest))

  const files = releaseFiles()
  const sums = files
    .map((file) => `${sha256(join(outDir, file))}  ${file}`)
    .join('\n')
  writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`)
}

function releaseFiles() {
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  return [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md']
}

function exists(asset) {
  return existsSync(join(outDir, asset))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function keepSingleShebang(text) {
  const shebang = '#!/usr/bin/env node\n'
  if (!text.startsWith(shebang)) return text
  return shebang + text.slice(shebang.length).replaceAll(shebang, '')
}

function detectNativeTarget() {
  const os = process.platform
  const arch = process.arch
  const normalizedOs = os === 'win32' ? 'win32' : os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : os
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch
  if (!['linux', 'darwin', 'win32'].includes(normalizedOs)) {
    throw new Error(`unsupported native release os ${os}`)
  }
  if (!['x64', 'arm64'].includes(normalizedArch)) {
    throw new Error(`unsupported native release arch ${arch}`)
  }
  return `${normalizedOs}-${normalizedArch}`
}

function nativeAssetName(name, target) {
  return `${name}-${target}${target.startsWith('win32-') ? '.exe' : ''}`
}

async function buildNativeSea(name, cjsPath, target) {
  const seaDir = join(outDir, '.sea', `${name}-${target}`)
  mkdirSync(seaDir, { recursive: true })
  const seaConfigPath = join(seaDir, 'sea-config.json')
  const blobPath = join(seaDir, `${name}.blob`)
  const nativePath = join(outDir, nativeAssetName(name, target))
  writeFileSync(seaConfigPath, `${JSON.stringify({ main: cjsPath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)}\n`)
  await run(process.execPath, ['--experimental-sea-config', seaConfigPath])
  copyFileSync(process.execPath, nativePath)
  await run('pnpm', ['exec', 'postject', nativePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'])
  chmodSync(nativePath, 0o755)
}

function parseOptions(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const value = optionValue(normalized, '--component') ?? 'all'
  const allowed = new Set(['all', 'host', 'executor', 'dashboard'])
  if (!allowed.has(value)) {
    throw new Error(`unknown release component ${value}; expected all, host, executor, or dashboard`)
  }
  return {
    component: value,
    tag: optionValue(normalized, '--tag') ?? process.env.GITHUB_REF_NAME ?? 'latest',
    repo: optionValue(normalized, '--repo') ?? process.env.GITHUB_REPOSITORY,
    nativeOnly: normalized.includes('--native-only'),
    finalizeOnly: normalized.includes('--finalize-only'),
    noNative: normalized.includes('--no-native'),
    nativeTarget: optionValue(normalized, '--native-target'),
  }
}

function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === name) return args[i + 1]
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function repoFromPackageJson(pkg) {
  const repository = pkg.repository
  if (typeof repository === 'string') return normalizeRepo(repository)
  if (repository && typeof repository.url === 'string') return normalizeRepo(repository.url)
  return undefined
}

function normalizeRepo(value) {
  const trimmed = value.trim()
  const match = trimmed.match(/github\.com[:/]([^/]+\/[^/.#]+)(?:\.git)?(?:[#?].*)?$/)
  if (match) return match[1]
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed
  return undefined
}

function unifiedBootstrap({ repo, tag, component }) {
  return bash([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `REPO="${repo}"`,
    `TAG="${tag}"`,
    `DEFAULT_COMPONENT="${component === 'all' ? '' : component}"`,
    'DEFAULT_BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"',
    'if [ "$TAG" = "latest" ]; then',
    '  DEFAULT_BASE_URL="https://github.com/${REPO}/releases/latest/download"',
    'fi',
    'BASE_URL="${AGENT_KERNEL_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}"',
    'COMPONENT="${COMPONENT:-${AGENT_KERNEL_COMPONENT:-${1:-$DEFAULT_COMPONENT}}}"',
    'WORK_DIR="${AGENT_KERNEL_RUN_DIR:-$(mktemp -d)}"',
    'DASHBOARD_DIR="${AGENT_KERNEL_DASHBOARD_DIR:-${WORK_DIR}/dashboard}"',
    'mkdir -p "$WORK_DIR" "$DASHBOARD_DIR"',
    '',
    'case "$COMPONENT" in',
    '  host|executor) ;;',
    '  *)',
    '    echo "Set COMPONENT=host or COMPONENT=executor. Example: wget -qO- ${BASE_URL}/run.sh | COMPONENT=host bash" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    '',
    'download() {',
    '  local name="$1"',
    '  local url="${BASE_URL}/${name}"',
    '  if ! command -v wget >/dev/null 2>&1; then',
    '    echo "wget is required" >&2',
    '    exit 1',
    '  fi',
    '  echo "Downloading ${name} from ${url}" >&2',
    '  if ! wget -O "${WORK_DIR}/${name}" "$url"; then',
    '    echo "failed to download ${name} from ${url}" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'hash_file() {',
    '  if command -v shasum >/dev/null 2>&1; then',
    '    shasum -a 256 "$1" | awk \'{print $1}\'',
    '  elif command -v sha256sum >/dev/null 2>&1; then',
    '    sha256sum "$1" | awk \'{print $1}\'',
    '  else',
    '    echo "shasum or sha256sum is required" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'verify_file() {',
    '  local name="$1"',
    '  local expected',
    '  expected=$(awk -v file="$name" \'$2 == file {print $1}\' "${WORK_DIR}/SHA256SUMS")',
    '  if [ -z "$expected" ]; then',
    '    echo "missing checksum for $name" >&2',
    '    exit 1',
    '  fi',
    '  local actual',
    '  actual=$(hash_file "${WORK_DIR}/${name}")',
    '  if [ "$actual" != "$expected" ]; then',
    '    echo "checksum mismatch for $name" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'download SHA256SUMS',
    '',
    'platform_target() {',
    '  local os arch',
    '  os=$(uname -s | tr "[:upper:]" "[:lower:]")',
    '  arch=$(uname -m)',
    '  case "$os" in',
    '    linux) os="linux" ;;',
    '    darwin) os="darwin" ;;',
    '    mingw*|msys*|cygwin*) os="win32" ;;',
    '    *) echo ""; return ;;',
    '  esac',
    '  case "$arch" in',
    '    x86_64|amd64) arch="x64" ;;',
    '    arm64|aarch64) arch="arm64" ;;',
    '    *) echo ""; return ;;',
    '  esac',
    '  echo "${os}-${arch}"',
    '}',
    '',
    'checksum_exists() {',
    '  local name="$1"',
    '  awk -v file="$name" \'$2 == file {found=1} END {exit found ? 0 : 1}\' "${WORK_DIR}/SHA256SUMS"',
    '}',
    '',
    'has_node22() {',
    '  command -v node >/dev/null 2>&1 && node -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\' >/dev/null 2>&1',
    '}',
    '',
    'run_asset() {',
    '  local base="$1"',
    '  shift',
    '  local target native cjs runtime',
    '  target=$(platform_target)',
    '  native="${base}-${target}"',
    '  case "$target" in win32-*) native="${native}.exe" ;; esac',
    '  cjs="${base}.cjs"',
    '  runtime="${AGENT_KERNEL_RUNTIME:-auto}"',
    '  case "$runtime" in auto|cjs|native) ;; *) echo "AGENT_KERNEL_RUNTIME must be auto, cjs, or native" >&2; exit 1 ;; esac',
    '  if [ "$runtime" = "cjs" ] || { [ "$runtime" = "auto" ] && has_node22; }; then',
    '    if checksum_exists "$cjs"; then',
    '      download "$cjs"',
    '      verify_file "$cjs"',
    '      chmod +x "${WORK_DIR}/${cjs}"',
    '      AGENT_KERNEL_RELEASE_TAG="$TAG" AGENT_KERNEL_UPDATE_REPO="$REPO" exec node "${WORK_DIR}/${cjs}" "$@"',
    '    fi',
    '    if [ "$runtime" = "cjs" ]; then',
    '      echo "missing checksum for $cjs" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    '  if [ -n "$target" ] && checksum_exists "$native"; then',
    '    download "$native"',
    '    verify_file "$native"',
    '    chmod +x "${WORK_DIR}/${native}"',
    '    AGENT_KERNEL_RELEASE_TAG="$TAG" AGENT_KERNEL_UPDATE_REPO="$REPO" exec "${WORK_DIR}/${native}" "$@"',
    '  fi',
    '  if [ "$runtime" = "native" ]; then',
    '    echo "missing native asset for ${base} on ${target:-unsupported-platform}" >&2',
    '    exit 1',
    '  fi',
    '  if ! has_node22; then',
    '    echo "Node.js 22 or newer is required because no matching native asset is available" >&2',
    '    exit 1',
    '  fi',
    '  download "$cjs"',
    '  verify_file "$cjs"',
    '  chmod +x "${WORK_DIR}/${cjs}"',
    '  AGENT_KERNEL_RELEASE_TAG="$TAG" AGENT_KERNEL_UPDATE_REPO="$REPO" exec node "${WORK_DIR}/${cjs}" "$@"',
    '}',
    '',
    'if [ "$COMPONENT" = "host" ]; then',
    'download agent-kernel-dashboard-dist.tar.gz',
    'verify_file agent-kernel-dashboard-dist.tar.gz',
    'tar -xzf "${WORK_DIR}/agent-kernel-dashboard-dist.tar.gz" -C "$DASHBOARD_DIR"',
    'echo "Starting agent-kernel host on http://localhost:${HOST_PORT:-3000}"',
    'DASHBOARD_DIR="$DASHBOARD_DIR" run_asset agent-kernel-host "$@"',
    'fi',
    '',
    'if [ -z "${HOST_URL:-}" ] && [ "$#" -eq 0 ]; then',
    '  echo "Set HOST_URL or pass --host <url>. Example: wget -qO- ${BASE_URL}/run.sh | COMPONENT=executor HOST_URL=http://localhost:3000 bash" >&2',
    '  exit 1',
    'fi',
    'run_asset agent-kernel-executor "$@"',
  ])
}

function releaseNotes(manifest) {
  const tagPath = manifest.tag === 'latest' ? 'latest/download' : `download/${manifest.tag}`
  const base = `https://github.com/${manifest.repo}/releases/${tagPath}`
  const hasNativeAssets = Object.values(manifest.nativeAssets ?? {}).some((assets) => Array.isArray(assets) && assets.length > 0)
  const lines = [
    `# agent-kernel ${manifest.tag}`,
    '',
    hasNativeAssets
      ? 'Release assets include compact Node.js 22 `.cjs` host/executor assets, OS-native fallback binaries, and a wget-only bash bootstrap that downloads and verifies the selected component before running it. By default, `run.sh` uses `.cjs` when Node.js 22+ is available and uses the native binary only when Node is missing or too old.'
      : 'Release assets currently include Node.js 22 `.cjs` fallback assets and a wget-only bash bootstrap that downloads and verifies the selected component before running it. Native binaries are uploaded by the follow-up native release job.',
    '',
    '## Quick start',
    '',
  ]
  if (manifest.assets.includes('run.sh')) {
    if (manifest.component === 'all' || manifest.component === 'host') {
      lines.push('Run Host:', '', '```bash', `wget -qO- ${base}/run.sh | COMPONENT=host bash`, '```', '')
    }
    if (manifest.component === 'all' || manifest.component === 'executor') {
      lines.push('Run Executor:', '', '```bash', `wget -qO- ${base}/run.sh | COMPONENT=executor HOST_URL=http://localhost:3000 bash`, '```', '')
    }
    if (manifest.component !== 'dashboard') {
      lines.push(
        'Runtime selection:',
        '',
        '- `AGENT_KERNEL_RUNTIME=auto` uses `.cjs` when Node.js 22+ is available and native binary otherwise.',
        '- `AGENT_KERNEL_RUNTIME=cjs` requires Node.js 22+ and downloads the compact `.cjs` asset.',
        '- `AGENT_KERNEL_RUNTIME=native` requires a matching OS-native binary.',
        '',
      )
    }
  }
  const verifyTargets = manifest.assets.filter((asset) => asset !== 'RELEASE_NOTES.md' && asset !== 'manifest.json' && asset !== 'SHA256SUMS')
  lines.push(
    '## Verify checksums',
    '',
    '```bash',
    `wget -q ${base}/SHA256SUMS`,
    ...verifyTargets.map((asset) => `wget -q ${base}/${asset}`),
    'sha256sum -c SHA256SUMS --ignore-missing',
    '```',
    '',
  )
  lines.push('## Assets', '', ...manifest.assets.map((asset) => `- \`${asset}\``), '- `manifest.json`', '- `SHA256SUMS`', '')
  return `${lines.join('\n')}\n`
}

function bash(lines) {
  return `${lines.join('\n')}\n`
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}`))
    })
  })
}
