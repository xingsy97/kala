#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'release')
const dashboardDist = join(root, 'packages/dashboard/dist')
const options = parseOptions(process.argv.slice(2))
const { component, tag, repo } = options

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
const expectedAssets = [
  ...allEntries.map((entry) => `${entry.name}.cjs`),
  'agent-kernel-dashboard-dist.tar.gz',
  'run-host.sh',
  'run-executor.sh',
  'RELEASE_NOTES.md',
  'manifest.json',
  'SHA256SUMS',
]

for (const asset of expectedAssets) {
  rmSync(join(outDir, asset), { force: true })
}

if (includeDashboard) {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'])
}

for (const item of entries) {
  const outfile = join(outDir, `${item.name}.cjs`)
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
  chmodSync(outfile, 0o755)
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

const bootstrapAssets = []
if (component === 'all' || component === 'host') {
  const path = join(outDir, 'run-host.sh')
  writeFileSync(path, hostBootstrap({ repo, tag }))
  chmodSync(path, 0o755)
  bootstrapAssets.push('run-host.sh')
}
if (component === 'all' || component === 'executor') {
  const path = join(outDir, 'run-executor.sh')
  writeFileSync(path, executorBootstrap({ repo, tag }))
  chmodSync(path, 0o755)
  bootstrapAssets.push('run-executor.sh')
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  component,
  repo,
  tag,
  node: '>=22',
  assets: entries
    .map((item) => `${item.name}.cjs`)
    .concat(includeDashboard ? ['agent-kernel-dashboard-dist.tar.gz'] : [])
    .concat(bootstrapAssets),
  notes: [
    'host and executor assets are single-file Node.js executables, not native binaries',
    'run-host.sh and run-executor.sh are bash bootstraps that download, verify, and run the matching Node.js asset',
    'host releases include the dashboard dist because agent-kernel-host serves it when DASHBOARD_DIR is set',
  ],
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(outDir, 'RELEASE_NOTES.md'), releaseNotes(manifest))

const files = [
  ...manifest.assets,
  'manifest.json',
  'RELEASE_NOTES.md',
]
const sums = files
  .map((file) => `${sha256(join(outDir, file))}  ${file}`)
  .join('\n')
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`)

console.log(`release assets written to ${outDir}`)
for (const file of [...files, 'SHA256SUMS']) {
  console.log(` - ${basename(file)}`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function keepSingleShebang(text) {
  const shebang = '#!/usr/bin/env node\n'
  if (!text.startsWith(shebang)) return text
  return shebang + text.slice(shebang.length).replaceAll(shebang, '')
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
    repo: optionValue(normalized, '--repo') ?? process.env.GITHUB_REPOSITORY ?? 'OWNER/REPO',
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

function hostBootstrap({ repo, tag }) {
  return bash([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `REPO="${repo}"`,
    `TAG="${tag}"`,
    'BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"',
    'if [ "$TAG" = "latest" ]; then',
    '  BASE_URL="https://github.com/${REPO}/releases/latest/download"',
    'fi',
    'WORK_DIR="${AGENT_KERNEL_RUN_DIR:-$(mktemp -d)}"',
    'DASHBOARD_DIR="${AGENT_KERNEL_DASHBOARD_DIR:-${WORK_DIR}/dashboard}"',
    'mkdir -p "$WORK_DIR" "$DASHBOARD_DIR"',
    '',
    'download() {',
    '  local name="$1"',
    '  local url="${BASE_URL}/${name}"',
    '  if command -v curl >/dev/null 2>&1; then',
    '    curl -fsSL "$url" -o "${WORK_DIR}/${name}"',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    wget -qO "${WORK_DIR}/${name}" "$url"',
    '  else',
    '    echo "curl or wget is required" >&2',
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
    'node -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\' || {',
    '  echo "Node.js 22 or newer is required" >&2',
    '  exit 1',
    '}',
    '',
    'download agent-kernel-host.cjs',
    'download agent-kernel-dashboard-dist.tar.gz',
    'download SHA256SUMS',
    'verify_file agent-kernel-host.cjs',
    'verify_file agent-kernel-dashboard-dist.tar.gz',
    'chmod +x "${WORK_DIR}/agent-kernel-host.cjs"',
    'tar -xzf "${WORK_DIR}/agent-kernel-dashboard-dist.tar.gz" -C "$DASHBOARD_DIR"',
    'echo "Starting agent-kernel host on http://localhost:${HOST_PORT:-3000}"',
    'DASHBOARD_DIR="$DASHBOARD_DIR" exec node "${WORK_DIR}/agent-kernel-host.cjs" "$@"',
  ])
}

function executorBootstrap({ repo, tag }) {
  return bash([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `REPO="${repo}"`,
    `TAG="${tag}"`,
    'BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"',
    'if [ "$TAG" = "latest" ]; then',
    '  BASE_URL="https://github.com/${REPO}/releases/latest/download"',
    'fi',
    'WORK_DIR="${AGENT_KERNEL_RUN_DIR:-$(mktemp -d)}"',
    'mkdir -p "$WORK_DIR"',
    '',
    'download() {',
    '  local name="$1"',
    '  local url="${BASE_URL}/${name}"',
    '  if command -v curl >/dev/null 2>&1; then',
    '    curl -fsSL "$url" -o "${WORK_DIR}/${name}"',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    wget -qO "${WORK_DIR}/${name}" "$url"',
    '  else',
    '    echo "curl or wget is required" >&2',
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
    'node -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\' || {',
    '  echo "Node.js 22 or newer is required" >&2',
    '  exit 1',
    '}',
    '',
    'download agent-kernel-executor.cjs',
    'download SHA256SUMS',
    'verify_file agent-kernel-executor.cjs',
    'chmod +x "${WORK_DIR}/agent-kernel-executor.cjs"',
    'if [ -z "${HOST_URL:-}" ] && [ "$#" -eq 0 ]; then',
    '  echo "Set HOST_URL or pass --host <url>. Example: HOST_URL=http://localhost:3000 bash run-executor.sh" >&2',
    '  exit 1',
    'fi',
    'exec node "${WORK_DIR}/agent-kernel-executor.cjs" "$@"',
  ])
}

function releaseNotes(manifest) {
  const tagPath = manifest.tag === 'latest' ? 'latest/download' : `download/${manifest.tag}`
  const base = `https://github.com/${manifest.repo}/releases/${tagPath}`
  const lines = [
    `# agent-kernel ${manifest.tag}`,
    '',
    'Release assets are Node.js 22 single-file executables plus bash bootstraps that download and verify the matching asset before running it.',
    '',
    '## One-line startup',
    '',
  ]
  if (manifest.assets.includes('run-host.sh')) {
    lines.push('Run Host with curl:', '', '```bash', `curl -fsSL ${base}/run-host.sh | bash`, '```', '')
    lines.push('Run Host with wget:', '', '```bash', `wget -qO- ${base}/run-host.sh | bash`, '```', '')
  }
  if (manifest.assets.includes('run-executor.sh')) {
    lines.push('Run Executor with curl:', '', '```bash', `curl -fsSL ${base}/run-executor.sh | HOST_URL=http://localhost:3000 bash`, '```', '')
    lines.push('Run Executor with wget:', '', '```bash', `wget -qO- ${base}/run-executor.sh | HOST_URL=http://localhost:3000 bash`, '```', '')
  }
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
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}`))
    })
  })
}
