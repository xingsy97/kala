import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./runlab-dedicated.mjs', import.meta.url))
const roots = []
const children = []
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGTERM'); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Dedicated operator CLI', () => {
  it('exposes the complete source-free lifecycle and preserves data on uninstall', () => {
    const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
    for (const command of ['install', 'status', 'upgrade', 'rollback', 'backup', 'restore', 'uninstall']) expect(output).toContain(command)
    expect(output).toContain('preserves all data')
  })

  it('creates, extracts, verifies, and restores an offline backup with bounded recovery', () => {
    const fixture = createFixture()
    const backup = join(fixture.root, 'persistent-backup')
    const backupOutput = run(fixture, ['backup', '--output', backup, '--operation-id', 'operation-backup-test'])
    expect(backupOutput.ok).toBe(true)
    expect(backupOutput.backupId).toMatch(/^backup-/u)
    expect(readdirSync(backup).sort()).toEqual(['config.tar', 'data.tar', 'install.tar', 'manifest.json', 'systemd-units.tar'])
    expect(fixture.systemctlLog().filter((entry) => entry.startsWith('stop ')).length).toBeGreaterThan(0)
    expect(fixture.systemctlLog().filter((entry) => entry.startsWith('start ')).length).toBeGreaterThan(0)

    writeFileSync(join(fixture.data, 'state.txt'), 'mutated\n')
    writeFileSync(join(fixture.config, 'private.env'), 'mutated-config\n')
    const restored = run(fixture, ['restore', '--backup', backup, '--confirm', `RESTORE:${backupOutput.backupId}`, '--operation-id', 'operation-restore-test'])
    expect(restored).toMatchObject({ ok: true, backupId: backupOutput.backupId, recoveryRetained: true })
    expect(readFileSync(join(fixture.data, 'state.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(fixture.config, 'private.env'), 'utf8')).toBe('private-config\n')
    expect(existsSync(`${fixture.data}.runlab-recovery-operation-restore-test`)).toBe(true)
  })

  it('requires backup-bound restore confirmation and installation-bound uninstall confirmation', () => {
    const fixture = createFixture()
    const backup = join(fixture.root, 'persistent-backup')
    const created = run(fixture, ['backup', '--output', backup, '--operation-id', 'operation-backup-confirm'])
    const deniedRestore = execute(fixture, ['restore', '--backup', backup, '--confirm', 'RESTORE:wrong', '--operation-id', 'operation-restore-wrong'])
    expect(deniedRestore.status).not.toBe(0)
    expect(deniedRestore.stderr).toContain('confirmation must equal RESTORE:')
    expect(readFileSync(join(fixture.data, 'state.txt'), 'utf8')).toBe('original\n')

    const deniedUninstall = execute(fixture, ['uninstall', '--confirm', 'UNINSTALL:wrong'])
    expect(deniedUninstall.status).not.toBe(0)
    expect(existsSync(fixture.data)).toBe(true)
    const removed = run(fixture, ['uninstall', '--confirm', 'UNINSTALL:installation-test-0001'])
    expect(removed.ok).toBe(true)
    expect(existsSync(fixture.install)).toBe(false)
    expect(existsSync(fixture.data)).toBe(true)
    expect(existsSync(fixture.config)).toBe(true)
    expect(existsSync(fixture.operator)).toBe(true)
    expect(created.confirmation).toBe(`RESTORE:${created.backupId}`)
  })

  it('refuses an output inside a backed-up root and blocks concurrent deployment state', () => {
    const fixture = createFixture()
    const nested = execute(fixture, ['backup', '--output', join(fixture.data, 'backup'), '--operation-id', 'operation-backup-nested'])
    expect(nested.status).not.toBe(0)
    expect(nested.stderr).toContain('backup output must be outside installation roots')

    mkdirSync(join(fixture.data, 'deploy', 'receipts'), { recursive: true })
    writeFileSync(join(fixture.data, 'deploy', 'receipts', 'deployment-live.json'), JSON.stringify({ deploymentId: 'deployment-live', phase: 'verifying' }))
    const active = execute(fixture, ['backup', '--output', join(fixture.root, 'other-backup'), '--operation-id', 'operation-backup-live'])
    expect(active.status).not.toBe(0)
    expect(active.stderr).toContain('deployment deployment-live is active')
  })

  it('rejects a modified backup archive before stopping services', () => {
    const fixture = createFixture()
    const backup = join(fixture.root, 'persistent-backup')
    const created = run(fixture, ['backup', '--output', backup, '--operation-id', 'operation-backup-tamper'])
    writeFileSync(join(backup, 'data.tar'), 'tampered\n')
    const before = fixture.systemctlLog().length
    const result = execute(fixture, ['restore', '--backup', backup, '--confirm', `RESTORE:${created.backupId}`, '--operation-id', 'operation-restore-tamper'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('backup archive verification failed: data.tar')
    expect(fixture.systemctlLog().length).toBe(before)
    expect(readFileSync(join(fixture.data, 'state.txt'), 'utf8')).toBe('original\n')
  })
})

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'runlab-dedicated-operator-')); roots.push(root)
  const data = join(root, 'var/lib/agent-runlab')
  const install = join(root, 'opt/agent-runlab')
  const config = join(root, 'etc/agent-runlab')
  const systemd = join(root, 'etc/systemd/system')
  const operator = join(root, 'var/lib/agent-runlab-operator')
  const operatorBin = join(root, 'usr/local/bin/runlab-dedicated')
  const bin = join(root, 'bin')
  for (const path of [data, install, config, systemd, operator, bin]) mkdirSync(path, { recursive: true })
  mkdirSync(join(data, 'deploy'), { recursive: true })
  writeFileSync(join(data, 'state.txt'), 'original\n')
  writeFileSync(join(install, 'runtime.txt'), 'runtime\n')
  writeFileSync(join(config, 'private.env'), 'private-config\n')
  writeFileSync(join(operator, 'installation.json'), JSON.stringify({ schemaVersion: 1, installationId: 'installation-test-0001' }))
  writeFileSync(join(data, 'deploy', 'migration-receipt.json'), JSON.stringify({ schemaVersion: 1, revision: 9, phase: 'cutover_completed' }))
  const runtimeOrigin = startRuntimeFixture(root)
  writeFileSync(join(data, 'deploy', 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 4, activeSlot: 'blue', slots: { blue: { origin: runtimeOrigin, releaseId: 'release-old' }, green: { origin: runtimeOrigin, releaseId: 'release-old' } } }))
  for (const name of unitFiles()) writeFileSync(join(systemd, name), `[Unit]\nDescription=${name}\n`)
  const state = Object.fromEntries(services().map((name) => [name, { active: !name.includes('green') && !name.includes('control-updater') && !name.includes('migration-finalizer'), enabled: true }]))
  writeFileSync(join(root, 'systemctl-state.json'), JSON.stringify(state))
  writeFileSync(join(root, 'systemctl.log'), '')
  const systemctl = join(bin, 'systemctl')
  writeFileSync(systemctl, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(root)},args=process.argv.slice(2);
const statePath=path.join(root,'systemctl-state.json');const state=JSON.parse(fs.readFileSync(statePath));fs.appendFileSync(path.join(root,'systemctl.log'),args.join(' ')+'\\n');
if(args[0]==='show'){const s=state[args[1]]||{active:false,enabled:false};process.stdout.write('ActiveState='+(s.active?'active':'inactive')+'\\nUnitFileState='+(s.enabled?'enabled':'disabled')+'\\nMainPID='+(s.active?'1234':'0')+'\\n');process.exit(0)}
if(args[0]==='stop'||args[0]==='start'){for(const name of args.slice(1).filter(x=>!x.startsWith('-'))){state[name]??={enabled:false};state[name].active=args[0]==='start'}}
if(args[0]==='disable'||args[0]==='enable'){for(const name of args.slice(1).filter(x=>!x.startsWith('-'))){state[name]??={active:false};state[name].enabled=args[0]==='enable'}}
fs.writeFileSync(statePath,JSON.stringify(state));
`); chmodSync(systemctl, 0o755)
  const curl = join(bin, 'curl'); writeFileSync(curl, '#!/bin/sh\nexit 0\n'); chmodSync(curl, 0o755)
  return {
    root, data, install, config, systemd, operator, operatorBin, bin,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_RUNLAB_DATA_ROOT: data, AGENT_RUNLAB_INSTALL_ROOT: install,
      AGENT_RUNLAB_CONFIG_ROOT: config, AGENT_RUNLAB_SYSTEMD_DIR: systemd, AGENT_RUNLAB_OPERATOR_ROOT: operator,
      AGENT_RUNLAB_OPERATOR_BIN: operatorBin, NODE_ENV: 'test', AGENT_RUNLAB_OPERATOR_TEST_MODE: '1', AGENT_RUNLAB_OPERATOR_TEST_ORIGIN: runtimeOrigin,
    },
    systemctlLog: () => readFileSync(join(root, 'systemctl.log'), 'utf8').trim().split('\n').filter(Boolean),
  }
}
function startRuntimeFixture(root) {
  const server = join(root, 'runtime-fixture.mjs'); const portFile = join(root, 'runtime-port')
  writeFileSync(server, `import{createServer}from'node:http';import{writeFileSync}from'node:fs';const server=createServer((request,response)=>{response.setHeader('content-type','application/json');if(request.url==='/internal/runtime/quiescence')response.end(JSON.stringify({safe:true}));else if(request.url==='/internal/runtime/cutover/reserve'&&request.method==='POST')response.end(JSON.stringify({safe:true}));else if(request.url==='/internal/runtime/cutover/release'&&request.method==='POST')response.end(JSON.stringify({ok:true}));else if(request.url==='/runtime/capabilities')response.end(JSON.stringify({product:'dedicated'}));else{response.statusCode=404;response.end('{}')}});server.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(portFile)},String(server.address().port)));` )
  const child = spawn(process.execPath, [server], { stdio: 'ignore' }); children.push(child)
  const deadline = Date.now() + 5000
  while (!existsSync(portFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  if (!existsSync(portFile)) throw new Error('runtime fixture did not start')
  return `http://127.0.0.1:${readFileSync(portFile, 'utf8')}`
}
function execute(fixture, args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: fixture.env }) }
function run(fixture, args) { const result = execute(fixture, args); if (result.status !== 0) throw new Error(result.stderr); return JSON.parse(result.stdout) }
function services() { return ['agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-unit@blue.service', 'agent-runlab-dedicated-unit@green.service', 'agent-runlab-dedicated-deploy-supervisor.service', 'agent-runlab-dedicated-control-updater.service', 'agent-runlab-dedicated-migration-finalizer.service'] }
function unitFiles() { return ['agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-unit@.service', 'agent-runlab-dedicated-deploy-supervisor.service', 'agent-runlab-dedicated-control-updater.service', 'agent-runlab-dedicated-migration-finalizer.service'] }
