import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  buildDeployPlan,
  installScript,
  RETIRED_RELEASE_ASSETS,
  releaseFiles,
  rollbackScript,
  remotePathForShell,
  rsyncUploadArgs,
  seedUploadScript,
  sh,
} from './deploy-plan.mjs'

const ROOT = '/repo'
const REQUIRED = ['SHA256SUMS', 'agent-kernel-executor.cjs', 'agent-runlab-dedicated-deploy-supervisor.cjs', 'agent-runlab-dedicated-ingress.cjs', 'bundle-dashboard-with-runtime.cjs']

function fakeFs(names) {
  return {
    exists(path) {
      if (path === `${ROOT}/release`) return true
      const name = path.split('/').pop()
      return names.includes(name)
    },
    readDir() {
      return names
    },
  }
}

describe('deploy plan', () => {
  it('keeps the LXD deployment contract available from deploy:remote', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./deploy-remote.mjs', import.meta.url), 'utf8'))
    expect(source).toContain("optionValueLocal(effectiveArgs, '--lxd')")
    expect(source).toContain('createGenerationPlan')
    expect(source).toContain('deploy-finalize.mjs')
    expect(source).toContain('launchFinalizeScript')
    expect(source).not.toContain('systemctl restart')
    expect(source).toContain("['exec', container, '--', 'bash', '-lc', command]")
    expect(source).toContain('const files = releaseFiles(releaseDir)')
    expect(source).toContain('transactionJson')
    expect(source).toContain('assertPortableTarget')
    expect(source).toContain('LEGACY_DEPLOYMENT_FORBIDDEN')
    expect(source).toContain("rawArgs.includes('--dry-run')")
    expect(source).toContain("rawArgs.includes('--help')")
    expect(source).toContain('pnpm run deploy:remote -- --lxd <container>')
    expect(source.indexOf("rawArgs.includes('--help')")).toBeLessThan(source.indexOf("optionValueLocal(effectiveArgs, '--lxd')"))
    expect(source).toContain('no build, SSH command, upload, activation, restart, or rollback was executed')
  })
  it('shows help without requiring a deployment target or touching release assets', () => {
    const script = fileURLToPath(new URL('./deploy-remote.mjs', import.meta.url))
    const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
    expect(output).toContain('Agent RunLab transactional deployment')
    expect(output).toContain('pnpm run deploy:remote -- --lxd <container>')
    expect(output).toContain('self-deployment checkpoint')
  })

  it('discovers only deployable release assets in stable order', () => {
    const fs = fakeFs(['z.tmp', 'run.sh', ...REQUIRED, 'manifest.json', 'agent-runlab-model-catalog-seed.json'])
    expect(releaseFiles(`${ROOT}/release`, fs)).toEqual([
      'SHA256SUMS',
      'agent-kernel-executor.cjs',
      'agent-runlab-dedicated-deploy-supervisor.cjs',
      'agent-runlab-dedicated-ingress.cjs',
      'agent-runlab-model-catalog-seed.json',
      'bundle-dashboard-with-runtime.cjs',
      'manifest.json',
      'run.sh',
    ])
  })

  it('includes the complete Dedicated control-plane update payload', () => {
    const names = [
      'agent-runlab-dedicated-control-updater.service',
      'update-dedicated-control-plane.mjs',
      'dedicated-data-migration.mjs',
      'rollback-dedicated-systemd.mjs',
    ]
    const fs = fakeFs([...REQUIRED, ...names])
    expect(releaseFiles(`${ROOT}/release`, fs)).toEqual(expect.arrayContaining(names))
  })

  it('builds a deploy plan from explicit options', () => {
    const fs = fakeFs([...REQUIRED, 'run.sh'])
    const plan = buildDeployPlan({
      args: ['--ssh', 'deploy-target', '--host-url=http://127.0.0.1:3000/', '--remote-bin', '~/bin'],
      env: {},
      root: ROOT,
      now: new Date('2026-07-22T10:11:12.000Z'),
      ...fs,
    })

    expect(plan.sshTarget).toBe('deploy-target')
    expect(plan.hostUrl).toBe('http://127.0.0.1:3000')
    expect(plan.remoteBinShell).toBe('"$HOME"/\'bin\'')
    expect(plan.uploadDir).toBe('~/bin/.agent-kernel-upload-20260722101112')
    expect(plan.restartMode).toBe('checkpoint')
    expect(plan.restartTimeoutMs).toBe(600000)
    expect(plan.statusTimeoutMs).toBe(660000)
    expect(plan.pollMs).toBe(2000)
    expect(plan.seedCommand).toContain('cp -p "$REMOTE_BIN/bundle-dashboard-with-runtime.cjs"')
    expect(plan.installCommand).toContain('agent-kernel-executor.cjs')
    expect(plan.service).toBeUndefined()
    expect(plan.sudo).toBe(false)
  })

  it('supports non-interactive sudo service recovery options', () => {
    const fs = fakeFs([...REQUIRED])
    const plan = buildDeployPlan({
      args: ['--ssh', 'target', '--host-url', 'http://127.0.0.1:3000', '--remote-bin', '~/bin', '--service', 'agent-runlab-host', '--sudo'],
      env: {},
      root: ROOT,
      ...fs,
    })
    expect(plan.service).toBe('agent-runlab-host')
    expect(plan.sudo).toBe(true)
    expect(plan.rollbackCommand).toContain("sudo -n systemctl restart 'agent-runlab-host'")
  })

  it('requires core release assets before deployment can run', () => {
    const fs = fakeFs(REQUIRED.filter((name) => name !== 'agent-kernel-executor.cjs'))
    expect(() => buildDeployPlan({
      args: ['--ssh', 'target', '--host-url', 'http://127.0.0.1:3000', '--remote-bin', '~/bin'],
      env: {},
      root: ROOT,
      ...fs,
    })).toThrow(/agent-kernel-executor\.cjs/)
  })

  it('quotes shell values and home-relative remote paths', () => {
    expect(sh("a'b")).toBe("'a'\\''b'")
    expect(remotePathForShell('~')).toBe('"$HOME"')
    expect(remotePathForShell('~/bin dir')).toBe('"$HOME"/\'bin dir\'')
    expect(remotePathForShell('/opt/agent kernel')).toBe("'/opt/agent kernel'")
  })

  it('builds an install script that backs up and chmods executable assets', () => {
    const script = installScript('~/bin', '~/bin/.upload', ['agent-kernel-executor.cjs', 'agent-runlab-model-catalog-seed.json', 'manifest.json', 'run.sh'])
    expect(script).toContain('BACKUP_DIR="$REMOTE_BIN/.agent-kernel-backup-$(date +%Y%m%d%H%M%S)"')
    expect(script).toContain('cp -p "$REMOTE_BIN/manifest.json" "$BACKUP_DIR/manifest.json"')
    expect(script).toContain('chmod +x "$REMOTE_BIN/agent-kernel-executor.cjs"')
    expect(script).toContain('chmod +x "$REMOTE_BIN/run.sh"')
    expect(script).not.toContain('chmod +x "$REMOTE_BIN/manifest.json"')
    expect(script).toContain('cp -p "$REMOTE_BIN/agent-runlab-model-catalog-seed.json" "$MODEL_CATALOG_DIR/models-dev-seed.json"')
    expect(script).toContain('sha256sum -c SHA256SUMS --ignore-missing')
    expect(script).toContain('>> "$BACKUP_DIR/.deployed-files"')
    expect(script.indexOf('.agent-kernel-backup-current')).toBeLessThan(script.indexOf('mv "$UPLOAD_DIR/agent-kernel-executor.cjs"'))
    for (const retired of RETIRED_RELEASE_ASSETS) {
      expect(script).toContain(`cp -p "$REMOTE_BIN/${retired}" "$BACKUP_DIR/${retired}"`)
      expect(script).toContain(`rm -f "$REMOTE_BIN/${retired}"`)
    }
  })

  it('builds a rollback script that restores the last backup and restarts the service', () => {
    const script = rollbackScript('~/bin', 'agent-runlab-host')
    expect(script).toContain('.agent-kernel-backup-current')
    expect(script).toContain('while IFS= read -r name')
    expect(script).toContain('rm -f "$REMOTE_BIN/$name"')
    expect(script).toContain('cp -p "$BACKUP_DIR/$name" "$REMOTE_BIN/$name"')
    expect(script).toContain("systemctl restart 'agent-runlab-host'")
    expect(rollbackScript('~/bin', 'agent-runlab-host', true)).toContain("sudo -n systemctl restart 'agent-runlab-host'")
  })

  it('seeds the upload directory from installed assets for incremental transfer', () => {
    const script = seedUploadScript('~/bin', '~/bin/.upload', [
      'agent-kernel-executor.cjs',
      'bundle-dashboard-with-runtime.cjs',
    ])
    expect(script).toContain('command -v rsync')
    expect(script).toContain('mkdir -p "$REMOTE_BIN" "$UPLOAD_DIR"')
    expect(script).toContain('if [ -f "$REMOTE_BIN/agent-kernel-executor.cjs" ]')
    expect(script).toContain('cp -p "$REMOTE_BIN/bundle-dashboard-with-runtime.cjs" "$UPLOAD_DIR/bundle-dashboard-with-runtime.cjs"')
  })

  it('builds a compressed, resumable rsync transfer with SSH liveness checks', () => {
    const args = rsyncUploadArgs({
      releaseDir: '/repo/release',
      files: ['bundle-dashboard-with-runtime.cjs', 'manifest.json'],
      sshTarget: 'deploy-target',
      uploadDir: '~/bin/.upload',
    })
    expect(args).toContain('--checksum')
    expect(args).toContain('--compress')
    expect(args).toContain('--no-whole-file')
    expect(args).toContain('--partial')
    expect(args).toContain('--inplace')
    expect(args).toContain('--timeout=120')
    expect(args).toContain('--rsh=ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3')
    expect(args).toContain('/repo/release/bundle-dashboard-with-runtime.cjs')
    expect(args.at(-1)).toBe('deploy-target:~/bin/.upload/')
  })
})
