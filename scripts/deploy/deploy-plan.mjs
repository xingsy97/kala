import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEPLOYABLE_RELEASE_ASSETS = Object.freeze([
  'bundle-dashboard-with-runtime.cjs',
  'agent-kernel-executor.cjs',
  'agent-kernel-dashboard-dist.tar.gz',
  'agent-runlab-model-catalog-seed.json',
  'agent-runlab-swebench-runner.cjs',
  'claude-code-swebench-runner.cjs',
  'run.sh',
  'manifest.json',
  'RELEASE_NOTES.md',
  'SHA256SUMS',
])

export const REQUIRED_RELEASE_ASSETS = Object.freeze([
  'bundle-dashboard-with-runtime.cjs',
  'agent-kernel-executor.cjs',
  'agent-runlab-swebench-runner.cjs',
  'claude-code-swebench-runner.cjs',
  'SHA256SUMS',
])

const RESTART_MODES = new Set(['checkpoint', 'when_idle', 'force'])

export function buildDeployPlan({ args, env, root, now = new Date(), exists = existsSync, readDir = readdirSync }) {
  const releaseDir = join(root, 'release')
  const options = parseOptions(args)
  const sshTarget = requiredOption(options.ssh ?? env.AK_DEPLOY_SSH, '--ssh or AK_DEPLOY_SSH')
  const hostUrl = requiredOption(options.hostUrl ?? env.AK_DEPLOY_HOST_URL, '--host-url or AK_DEPLOY_HOST_URL')
  const remoteBin = requiredOption(options.remoteBin ?? env.AK_DEPLOY_REMOTE_BIN, '--remote-bin or AK_DEPLOY_REMOTE_BIN')
  const restartMode = options.restartMode ?? env.AK_DEPLOY_RESTART_MODE ?? 'checkpoint'
  const restartTimeoutMs = positiveNumber(options.restartTimeoutMs ?? env.AK_DEPLOY_RESTART_TIMEOUT_MS ?? 600000, '--restart-timeout-ms')
  const statusTimeoutMs = positiveNumber(options.statusTimeoutMs ?? env.AK_DEPLOY_STATUS_TIMEOUT_MS ?? restartTimeoutMs + 60000, '--status-timeout-ms')
  const pollMs = positiveNumber(options.pollMs ?? env.AK_DEPLOY_POLL_MS ?? 2000, '--poll-ms')

  if (!RESTART_MODES.has(restartMode)) throw new Error('--restart-mode must be checkpoint, when_idle, or force')

  const files = releaseFiles(releaseDir, { exists, readDir })
  if (files.length === 0) {
    throw new Error(`no deployable release assets found in ${releaseDir}; run pnpm run build:release-assets first`)
  }
  for (const required of REQUIRED_RELEASE_ASSETS) {
    if (!files.includes(required)) {
      throw new Error(`release asset ${required} is missing from ${releaseDir}; run pnpm run build:release-assets first`)
    }
  }

  const stamp = deployStamp(now)
  const uploadDir = `${remoteBin.replace(/\/$/, '')}/.agent-kernel-upload-${stamp}`
  return {
    root,
    releaseDir,
    sshTarget,
    hostUrl: hostUrl.replace(/\/$/, ''),
    remoteBin,
    remoteBinShell: remotePathForShell(remoteBin),
    restartMode,
    restartTimeoutMs,
    statusTimeoutMs,
    pollMs,
    files,
    uploadDir,
    uploadDirShell: remotePathForShell(uploadDir),
    seedCommand: seedUploadScript(remoteBin, uploadDir, files),
    installCommand: installScript(remoteBin, uploadDir, files),
  }
}

export function releaseFiles(releaseDir, { exists = existsSync, readDir = readdirSync } = {}) {
  if (!exists(releaseDir)) return []
  const wanted = new Set(DEPLOYABLE_RELEASE_ASSETS)
  return readDir(releaseDir)
    .filter((name) => wanted.has(name))
    .filter((name) => exists(join(releaseDir, name)))
    .sort()
}

export function installScript(remoteBinDir, remoteUploadDir, names) {
  const catalogSeed = 'agent-runlab-model-catalog-seed.json'
  const lines = [
    'set -euo pipefail',
    `REMOTE_BIN=${remotePathForShell(remoteBinDir)}`,
    `UPLOAD_DIR=${remotePathForShell(remoteUploadDir)}`,
    'BACKUP_DIR="$REMOTE_BIN/.agent-kernel-backup-$(date +%Y%m%d%H%M%S)"',
    'mkdir -p "$REMOTE_BIN" "$BACKUP_DIR"',
    'MODEL_CATALOG_DIR="$HOME/.local/share/agent-runlab/model-catalog"',
  ]
  for (const name of names) {
    lines.push(`if [ -e "$REMOTE_BIN/${name}" ]; then cp -p "$REMOTE_BIN/${name}" "$BACKUP_DIR/${name}"; fi`)
  }
  for (const name of names) {
    lines.push(`mv "$UPLOAD_DIR/${name}" "$REMOTE_BIN/${name}"`)
  }
  if (names.includes(catalogSeed)) {
    lines.push('mkdir -p "$MODEL_CATALOG_DIR"')
    lines.push(`cp -p "$REMOTE_BIN/${catalogSeed}" "$MODEL_CATALOG_DIR/models-dev-seed.json"`)
  }
  for (const name of names.filter((name) => name.endsWith('.cjs') || name === 'run.sh')) {
    lines.push(`chmod +x "$REMOTE_BIN/${name}"`)
  }
  lines.push('rm -f "$REMOTE_BIN/.agent-kernel-upload-current"')
  lines.push('printf "%s\n" "$UPLOAD_DIR" > "$REMOTE_BIN/.agent-kernel-upload-current"')
  lines.push('rmdir "$UPLOAD_DIR" 2>/dev/null || true')
  return lines.join('\n')
}

export function seedUploadScript(remoteBinDir, remoteUploadDir, names) {
  const lines = [
    'set -euo pipefail',
    'command -v rsync >/dev/null || { echo "remote deploy requires rsync" >&2; exit 127; }',
    `REMOTE_BIN=${remotePathForShell(remoteBinDir)}`,
    `UPLOAD_DIR=${remotePathForShell(remoteUploadDir)}`,
    'mkdir -p "$REMOTE_BIN" "$UPLOAD_DIR"',
  ]
  for (const name of names) {
    lines.push(`if [ -f "$REMOTE_BIN/${name}" ]; then cp -p "$REMOTE_BIN/${name}" "$UPLOAD_DIR/${name}"; fi`)
  }
  return lines.join('\n')
}

export function rsyncUploadArgs({ releaseDir, files, sshTarget, uploadDir }) {
  return [
    '--archive',
    '--checksum',
    '--compress',
    '--no-whole-file',
    '--human-readable',
    '--partial',
    '--inplace',
    '--timeout=120',
    '--info=progress2,stats2',
    '--rsh=ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3',
    ...files.map((file) => join(releaseDir, file)),
    `${sshTarget}:${uploadDir}/`,
  ]
}

export function parseOptions(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  return {
    ssh: optionValue(normalized, '--ssh'),
    hostUrl: optionValue(normalized, '--host-url'),
    remoteBin: optionValue(normalized, '--remote-bin'),
    restartMode: optionValue(normalized, '--restart-mode'),
    restartTimeoutMs: optionValue(normalized, '--restart-timeout-ms'),
    statusTimeoutMs: optionValue(normalized, '--status-timeout-ms'),
    pollMs: optionValue(normalized, '--poll-ms'),
  }
}

export function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function remotePathForShell(value) {
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return `"$HOME"/${sh(value.slice(2))}`
  return sh(value)
}

function deployStamp(now) {
  return now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function requiredOption(value, name) {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`missing ${name}`)
  return trimmed
}

function positiveNumber(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`)
  return parsed
}

function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === name) return args[i + 1]
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}
