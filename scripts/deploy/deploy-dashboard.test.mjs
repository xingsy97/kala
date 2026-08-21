import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  execFileSync('tar', ['-czf', join(release, 'agent-kernel-dashboard-dist.tar.gz'), '-C', join(root, 'assets'), '.'])
  const files = [{ path: 'assets/app.12345678.js', bytes: 8, sha256: sha('export{}') }, { path: 'index.html', bytes: 24, sha256: sha('<title>dashboard</title>') }].sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { schemaVersion: 1, product: 'agent-runlab-dashboard', version: '1.0.0', builtAt: new Date().toISOString(), source: { revision: 'a'.repeat(40), snapshotSha256: 'b'.repeat(64), dirty: false }, protocol: { min: '1.0.0', max: '1.0.0' }, assetDigest: sha(JSON.stringify(files)), files }
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
})
