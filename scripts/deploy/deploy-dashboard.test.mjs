import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./deploy-dashboard.mjs', import.meta.url))
const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const sha = (value) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-dashboard-')); roots.push(root)
  const release = join(root, 'release'), deploy = join(root, 'deploy')
  mkdirSync(join(root, 'assets', 'assets'), { recursive: true }); mkdirSync(release); mkdirSync(join(deploy, 'requests'), { recursive: true }); mkdirSync(join(deploy, 'submissions')); mkdirSync(join(deploy, 'receipts')); mkdirSync(join(deploy, 'releases'))
  writeFileSync(join(root, 'assets', 'index.html'), '<title>dashboard</title>'); writeFileSync(join(root, 'assets', 'assets', 'app.12345678.js'), 'export{}')
  execFileSync('tar', ['-czf', join(release, 'kala-dashboard-dist.tar.gz'), '-C', join(root, 'assets'), '.'])
  const files = [{ path: 'assets/app.12345678.js', bytes: 8, sha256: sha('export{}') }, { path: 'index.html', bytes: 24, sha256: sha('<title>dashboard</title>') }].sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { schemaVersion: 1, product: 'kala-dashboard', version: '1.0.0', builtAt: new Date().toISOString(), source: { revision: 'a'.repeat(40), snapshotSha256: 'b'.repeat(64), dirty: false }, protocol: { min: '1.0.0', max: '1.0.0' }, assetDigest: sha(JSON.stringify(files)), files }
  writeFileSync(join(release, 'dashboard-release.json'), JSON.stringify(manifest))
  writeFileSync(join(deploy, 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 7, releaseId: 'old', releaseDigest: 'c'.repeat(64), assetDigest: 'd'.repeat(64), version: '0.9.0', protocol: { min: '1.0.0', max: '1.0.0' }, activatedAt: new Date().toISOString() }))
  return { root, release, deploy }
}

describe('deploy:dashboard client', () => {
  it('exposes an independent command surface that promises no Runtime restart', () => { const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }); for (const command of ['stage', 'status', 'wait', 'inspect', 'rollback']) expect(output).toContain(command); expect(output).toContain('never restarts Ingress, Runtime slots, Sessions, or Executors') })
  it('atomically stages an immutable archive and fenced request', () => {
    const value = fixture(); const output = JSON.parse(execFileSync(process.execPath, [script, 'stage', '--local', '--skip-build', '--release-dir', value.release, '--deploy-root', value.deploy, '--release-id', 'dashboard-r2', '--operation-id', 'operation-dashboard-r2', '--deployment-id', 'deployment-dashboard-r2'], { encoding: 'utf8' }))
    expect(output).toMatchObject({ accepted: true, expectedGeneration: 7, releaseId: 'dashboard-r2' })
    const request = JSON.parse(readFileSync(join(value.deploy, 'requests', 'operation-dashboard-r2.json'), 'utf8'))
    expect(request).toMatchObject({ action: 'deploy', expectedGeneration: 7, stagedReleaseDir: join(value.deploy, 'submissions', 'operation-dashboard-r2') })
    expect(readFileSync(join(request.stagedReleaseDir, 'dashboard.tar.gz')).length).toBeGreaterThan(0)
  })
  it('finds a remote receipt by operation id when the file is named by deployment id', () => {
    const value = fixture()
    const receipt = { schemaVersion: 1, receiptRevision: 2, operationId: 'operation-dashboard-r2', deploymentId: 'deployment-dashboard-r2', phase: 'completed' }
    writeFileSync(join(value.deploy, 'receipts', 'deployment-dashboard-r2.json'), JSON.stringify(receipt))
    const bin = join(value.root, 'bin'); mkdirSync(bin)
    const lxc = join(bin, 'lxc')
    writeFileSync(lxc, '#!/bin/sh\n[ "$1" = exec ] || exit 64\nshift 3\nexec "$@"\n')
    chmodSync(lxc, 0o755)
    const output = JSON.parse(execFileSync(process.execPath, [script, 'status', 'operation-dashboard-r2', '--lxd', 'test-target', '--deploy-root', value.deploy], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }))
    expect(output).toEqual(receipt)
  })
})
