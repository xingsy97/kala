import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ExecutorInstallationError, ExecutorInstallationStore } from './executor-installation.js'

describe('ExecutorInstallationStore', () => {
  it('persists only a bootstrap hash and resumes status after reload', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'executor-installs-')), 'installs.json')
    const store = new ExecutorInstallationStore(path)
    const created = store.create({ platform: 'linux', mode: 'service', workspaceRoot: '/work' })
    expect(readFileSync(path, 'utf8')).not.toContain(created.setupCode)
    expect(readFileSync(path, 'utf8')).toContain('sha256:')

    const claimed = store.claim(created.setupCode)
    expect(claimed?.install.status).toBe('bootstrap_downloaded')
    const bootstrap = claimed!.bootstrap
    expect(store.reportClient(created.install.id, bootstrap, 'asset_verified').seq).toBe(2)
    expect(store.reportClient(created.install.id, bootstrap, 'pairing_pending').status).toBe('paired')
    expect(store.reportClient(created.install.id, bootstrap, 'service_installing').status).toBe('service_installing')
    expect(store.reportClient(created.install.id, bootstrap, 'starting').status).toBe('starting')

    const reloaded = new ExecutorInstallationStore(path)
    reloaded.load()
    expect(reloaded.get(created.install.id)?.status).toBe('starting')
  })

  it('redeems once and only host observation can complete', () => {
    const store = new ExecutorInstallationStore(join(mkdtempSync(join(tmpdir(), 'executor-installs-')), 'installs.json'))
    const created = store.create({ platform: 'macos', mode: 'temporary', workspaceRoot: '/work' })
    const bootstrap = store.claim(created.setupCode)!.bootstrap
    store.reportClient(created.install.id, bootstrap, 'asset_verified')
    expect(store.reportClient(created.install.id, bootstrap, 'pairing_pending').status).toBe('paired')
    store.redeem(created.install.id, bootstrap, 'ws-1')
    expect(() => store.redeem(created.install.id, bootstrap, 'ws-1')).toThrow(ExecutorInstallationError)
    store.reportClient(created.install.id, bootstrap, 'starting')
    expect(() => store.reportClient(created.install.id, bootstrap, 'online')).toThrow('host_observed_status_required')
    expect(store.markOnline(created.install.id, 'wrong')).toBeUndefined()
    expect(store.markOnline(created.install.id, 'ws-1')?.status).toBe('completed')
    expect(store.events(created.install.id)?.map((event) => event.status)).toContain('online')
  })
})
