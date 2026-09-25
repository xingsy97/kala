import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./deploy-dedicated.mjs', import.meta.url))
const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    makeTreeRemovable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function makeTreeRemovable(path) {
  try {
    const value = statSync(path)
    if (!value.isDirectory()) return
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) makeTreeRemovable(join(path, name))
  } catch {}
}

describe('deploy:dedicated client', () => {
  it('exposes one explicit slot-topology command surface', () => {
    const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
    const pnpmStyleOutput = execFileSync(process.execPath, [script, '--', '--help'], { encoding: 'utf8' })
    for (const command of ['stage', 'status', 'wait', 'inspect', 'abort', 'rollback']) expect(output).toContain(command)
    expect(pnpmStyleOutput).toBe(output)
    expect(output).toContain('--local')
    expect(output).toContain('--lxd')
    expect(output).toContain('--ssh')
    expect(output).toContain('never invokes the legacy single-service')
  })

  it('reads authoritative receipts by deployment or operation id without mutating state', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-status-')); roots.push(root)
    mkdirSync(join(root, 'receipts'), { recursive: true })
    const receipt = { schemaVersion: 1, receiptRevision: 4, deploymentId: 'deployment-test-0001', operationId: 'operation-test-0001', operationIds: ['operation-test-0001'], phase: 'waiting_for_boundary', updatedAt: new Date().toISOString(), releaseDir: '/private/path' }
    writeFileSync(join(root, 'receipts', receipt.deploymentId + '.json'), JSON.stringify(receipt))
    writeFileSync(join(root, 'operation-index.json'), JSON.stringify({ [receipt.operationId]: receipt.deploymentId }))
    const direct = JSON.parse(execFileSync(process.execPath, [script, 'status', receipt.deploymentId, '--local', '--deploy-root', root], { encoding: 'utf8' }))
    const indexed = JSON.parse(execFileSync(process.execPath, [script, 'status', receipt.operationId, '--local', '--deploy-root', root], { encoding: 'utf8' }))
    expect(direct.receiptRevision).toBe(4)
    expect(indexed.deploymentId).toBe(receipt.deploymentId)
    expect(direct.releaseDir).toBeUndefined()
  })

  it('preserves each SSH bash script as one remote -lc argument', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-ssh-')); roots.push(root)
    const bin = join(root, 'bin')
    const deployRoot = join(root, 'deploy')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(deployRoot, 'receipts'), { recursive: true })
    const receipt = {
      schemaVersion: 1, receiptRevision: 7, deploymentId: 'deployment-ssh-0001',
      operationId: 'operation-ssh-0001', operationIds: ['operation-ssh-0001'],
      phase: 'waiting_for_boundary', updatedAt: new Date().toISOString(),
    }
    writeFileSync(join(deployRoot, 'receipts', receipt.deploymentId + '.json'), JSON.stringify(receipt))
    const fakeSsh = join(bin, 'ssh')
    writeFileSync(fakeSsh, [
      '#!/usr/bin/env node',
      "const { spawnSync } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const remoteCommand = process.argv.slice(3).join(' ')",
      "const result = spawnSync('/bin/sh', ['-c', remoteCommand], { input: fs.readFileSync(0) })",
      "process.stdout.write(result.stdout ?? '')",
      "process.stderr.write(result.stderr ?? '')",
      "process.exit(result.status ?? 1)",
      '',
    ].join('\n'))
    chmodSync(fakeSsh, 0o755)

    const output = JSON.parse(execFileSync(process.execPath, [
      script, 'status', receipt.deploymentId, '--ssh', 'deployer@example', '--deploy-root', deployRoot,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }))
    expect(output).toMatchObject({ deploymentId: receipt.deploymentId, receiptRevision: 7 })
  })

  it('contains durable submission and transport adapters without legacy restart calls', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(script, 'utf8'))
    expect(source).toContain('fsyncSync(file)')
    expect(source).toContain('fsyncSync(directory)')
    expect(source).toContain('commandTransport')
    expect(source).toContain('runCommand')
    expect(source).toContain('runSourceCommand')
    expect(source).toContain("'lxd'")
    expect(source).toContain("'ssh'")
    expect(source).not.toContain('/runtime/restart')
    expect(source).not.toContain('deploy-finalize.mjs')
  })

  it('automatically binds self-deployment origin identity from Executor environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-origin-env-')); roots.push(root)
    const releaseDir = join(root, 'release')
    const deployRoot = join(root, 'deploy')
    const predecessorDir = join(deployRoot, 'releases', 'predecessor')
    mkdirSync(releaseDir, { recursive: true })
    mkdirSync(predecessorDir, { recursive: true })
    mkdirSync(join(deployRoot, 'requests'), { recursive: true })
    mkdirSync(join(deployRoot, 'submissions'), { recursive: true })
    const assets = ['kala-runtime.cjs']
    writeFileSync(join(releaseDir, assets[0]), '#!/usr/bin/env node\nprocess.exit(0)\n')
    writeFileSync(join(releaseDir, 'RELEASE_NOTES.md'), '# test release\n')
    writeFileSync(join(releaseDir, 'manifest.json'), JSON.stringify({ assets }))
    const bundle = execFileSync('sha256sum', [join(releaseDir, assets[0])], { encoding: 'utf8' }).split(' ')[0]
    const notes = execFileSync('sha256sum', [join(releaseDir, 'RELEASE_NOTES.md')], { encoding: 'utf8' }).split(' ')[0]
    const manifest = execFileSync('sha256sum', [join(releaseDir, 'manifest.json')], { encoding: 'utf8' }).split(' ')[0]
    writeFileSync(join(releaseDir, 'SHA256SUMS'), `${bundle}  ${assets[0]}\n${notes}  RELEASE_NOTES.md\n${manifest}  manifest.json\n`)
    writeFileSync(join(predecessorDir, 'SHA256SUMS'), `${'a'.repeat(64)}  predecessor\n`)
    writeFileSync(join(deployRoot, 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 3, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'predecessor' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'predecessor' } } }))
    const output = JSON.parse(execFileSync(process.execPath, [script, '--', 'stage', '--local', '--skip-build', '--release-dir', releaseDir, '--deploy-root', deployRoot, '--release-id', 'candidate', '--operation-id', 'operation-origin-0001', '--deployment-id', 'deployment-origin-0001'], { encoding: 'utf8', env: { ...process.env, AGENT_RUNLAB_SESSION_ID: 'session-origin-0001', AGENT_RUNLAB_CALL_ID: 'call-origin-0001' } }))
    expect(output).toMatchObject({ accepted: true, operationId: 'operation-origin-0001', deploymentId: 'deployment-origin-0001' })
    const request = JSON.parse(readFileSync(join(deployRoot, 'requests', 'operation-origin-0001.json'), 'utf8'))
    expect(request.origin).toEqual({ sessionId: 'session-origin-0001', callId: 'call-origin-0001' })
    expect(request.stagedReleaseDir).toBe(join(deployRoot, 'submissions', request.operationId))
    expect(request.releaseDir).toBeUndefined()
  })

  it('runs from the immutable release directory without assuming a source checkout layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-packaged-')); roots.push(root)
    const packaged = join(root, 'release')
    const deployRoot = join(root, 'deploy')
    const predecessorDir = join(deployRoot, 'releases', 'predecessor')
    mkdirSync(packaged, { recursive: true })
    mkdirSync(predecessorDir, { recursive: true })
    mkdirSync(join(deployRoot, 'requests'), { recursive: true })
    mkdirSync(join(deployRoot, 'submissions'), { recursive: true })
    copyFileSync(script, join(packaged, 'deploy-dedicated.mjs'))
    writeFileSync(join(packaged, 'kala-runtime.cjs'), '#!/usr/bin/env node\nprocess.exit(0)\n')
    writeFileSync(join(packaged, 'RELEASE_NOTES.md'), '# packaged release\n')
    writeFileSync(join(packaged, 'manifest.json'), JSON.stringify({ assets: ['kala-runtime.cjs', 'deploy-dedicated.mjs'] }))
    const sum = (name) => execFileSync('sha256sum', [join(packaged, name)], { encoding: 'utf8' }).split(' ')[0]
    writeFileSync(join(packaged, 'SHA256SUMS'), [
      `${sum('RELEASE_NOTES.md')}  RELEASE_NOTES.md`,
      `${sum('kala-runtime.cjs')}  kala-runtime.cjs`,
      `${sum('deploy-dedicated.mjs')}  deploy-dedicated.mjs`,
      `${sum('manifest.json')}  manifest.json`,
    ].join('\n') + '\n')
    writeFileSync(join(predecessorDir, 'SHA256SUMS'), `${'a'.repeat(64)}  predecessor\n`)
    writeFileSync(join(deployRoot, 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 9, activeSlot: 'green', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'predecessor' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'predecessor' } } }))

    const output = JSON.parse(execFileSync(process.execPath, [join(packaged, 'deploy-dedicated.mjs'), 'stage', '--local', '--skip-build', '--deploy-root', deployRoot, '--release-id', 'packaged-candidate', '--operation-id', 'operation-packaged-0001', '--deployment-id', 'deployment-packaged-0001'], { encoding: 'utf8' }))
    expect(output).toMatchObject({ accepted: true, operationId: 'operation-packaged-0001', expectedRouteGeneration: 9 })
    expect(JSON.parse(readFileSync(join(deployRoot, 'requests', 'operation-packaged-0001.json'), 'utf8'))).toMatchObject({
      releaseId: 'packaged-candidate',
      stagedReleaseDir: join(deployRoot, 'submissions', 'operation-packaged-0001'),
    })
  })
})
