import { describe, expect, it } from 'vitest'

import {
  buildDeployPlan,
  installScript,
  releaseFiles,
  remotePathForShell,
  rsyncUploadArgs,
  seedUploadScript,
  sh,
} from './deploy-plan.mjs'

const ROOT = '/repo'
const REQUIRED = ['SHA256SUMS', 'agent-kernel-executor.cjs', 'bundle-dashboard-with-runtime.cjs']

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
  it('discovers only deployable release assets in stable order', () => {
    const fs = fakeFs(['z.tmp', 'run.sh', ...REQUIRED, 'manifest.json'])
    expect(releaseFiles(`${ROOT}/release`, fs)).toEqual([
      'SHA256SUMS',
      'agent-kernel-executor.cjs',
      'bundle-dashboard-with-runtime.cjs',
      'manifest.json',
      'run.sh',
    ])
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
  })

  it('requires core release assets before deployment can run', () => {
    const fs = fakeFs(['SHA256SUMS', 'bundle-dashboard-with-runtime.cjs'])
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
    const script = installScript('~/bin', '~/bin/.upload', ['agent-kernel-executor.cjs', 'manifest.json', 'run.sh'])
    expect(script).toContain('BACKUP_DIR="$REMOTE_BIN/.agent-kernel-backup-$(date +%Y%m%d%H%M%S)"')
    expect(script).toContain('cp -p "$REMOTE_BIN/manifest.json" "$BACKUP_DIR/manifest.json"')
    expect(script).toContain('chmod +x "$REMOTE_BIN/agent-kernel-executor.cjs"')
    expect(script).toContain('chmod +x "$REMOTE_BIN/run.sh"')
    expect(script).not.toContain('chmod +x "$REMOTE_BIN/manifest.json"')
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
    expect(args).toContain('--partial')
    expect(args).toContain('--timeout=120')
    expect(args).toContain('--rsh=ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3')
    expect(args).toContain('/repo/release/bundle-dashboard-with-runtime.cjs')
    expect(args.at(-1)).toBe('deploy-target:~/bin/.upload/')
  })
})
