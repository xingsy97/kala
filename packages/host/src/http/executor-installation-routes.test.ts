import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { attachExecutorInstallationRoutes } from './executor-installation-routes.js'
import { ExecutorInstallationStore } from '../store/executor-installation.js'
import { ExecutorIdentityStore } from '../store/executor-identity.js'

describe('executor installation routes', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

  async function start(tenancy: 'single-tenant' | 'multi-tenant' = 'single-tenant') {
    const dir = mkdtempSync(join(tmpdir(), 'executor-install-api-'))
    const store = new ExecutorInstallationStore(join(dir, 'installs.json'))
    const identities = new ExecutorIdentityStore(join(dir, 'identities.json'))
    const server = createServer(); servers.push(server)
    attachExecutorInstallationRoutes(server, { store, identities, tenancy })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    return { url: `http://localhost:${address.port}`, dir }
  }

  it('allows browser preflight for cross-origin dashboard install API calls', async () => {
    const { url } = await start()
    const response = await fetch(`${url}/api/executor-installs`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:5302',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type')
  })

  it('creates, patches, reports progress, approves, redeems, and short-polls', async () => {
    const { url, dir } = await start()
    const createdResponse = await fetch(`${url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'linux', mode: 'temporary', workspaceRoot: '/work' }) })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string; command: string; setupCode: string }
    expect(created.command).toBe(`curl -fsSL '${url}/install' | RUNLAB_SETUP_CODE='${created.setupCode}' RUNLAB_INSTALL_MODE='temporary' sh`)
    expect(created.command).not.toMatch(/sudo|ak_install_|[?&](?:invite|token|session)=/u)
    expect(created.setupCode).toMatch(/^[A-F0-9]{10}$/u)
    expect(readFileSync(join(dir, 'installs.json'), 'utf8')).not.toContain(created.setupCode)

    expect((await fetch(`${url}/api/executor-installs/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'runner' }) })).status).toBe(200)
    const installer = await fetch(`${url}/install`)
    expect(installer.status).toBe(200)
    const installerScript = await installer.text()
    expect(installerScript).toContain('RUNLAB_SETUP_CODE')
    expect(installerScript).toContain('/install/session')
    expect(installerScript).toContain('bash "$installer"')
    expect(installerScript.indexOf('/install/assets/install-executor.sh')).toBeLessThan(installerScript.indexOf('/install/session'))
    expect(installerScript).not.toContain('| sh')
    expect(installerScript).toContain('curl --fail --silent --show-error --location')
    expect(installerScript).toContain('[1/4] Downloading verified installer')
    expect(installerScript).toContain('[3/4] Installing Executor')
    expect(installerScript).not.toContain('curl -fSL')
    const powerShellInstaller = await fetch(`${url}/install.ps1`).then((response) => response.text())
    expect(powerShellInstaller).toContain("-Headers @{ Accept = 'application/json' }")
    expect(powerShellInstaller).toContain('$null -eq $claim.env')
    expect(powerShellInstaller).toContain('[1/4] Downloading verified installer')
    expect(powerShellInstaller).toContain('[3/4] Starting Executor')
    expect(powerShellInstaller).toContain("Read-Host 'Install the official Node.js LTS package with Windows Package Manager (winget)? [y/N]'")
    expect(powerShellInstaller).toContain('winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget')
    expect(powerShellInstaller).toContain('The setup code was not consumed')
    expect(powerShellInstaller.indexOf('winget.Source install')).toBeLessThan(powerShellInstaller.indexOf('/install/session'))
    expect(powerShellInstaller.split('\n').length).toBeGreaterThan(40)
    const claimed = await fetch(`${url}/install/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: created.setupCode }) })
    expect(claimed.status).toBe(200)
    const claim = await claimed.json() as { env: { EXECUTOR_INSTALL_BOOTSTRAP: string; RUNLAB_RELEASE_ASSETS_URL: string; RUNLAB_INSTALLER_ALLOW_UNSIGNED: string } }
    const bootstrap = claim.env.EXECUTOR_INSTALL_BOOTSTRAP
    expect(bootstrap).toMatch(/^ak_install_/u)
    expect(claim.env.RUNLAB_RELEASE_ASSETS_URL).toBe(`${url}/install/assets`)
    expect(claim.env.RUNLAB_INSTALLER_ALLOW_UNSIGNED).toBe('1')
    expect((await fetch(`${url}/install/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: created.setupCode }) })).status).toBe(401)
    for (const status of ['asset_verified', 'pairing_pending']) {
      expect((await fetch(`${url}/api/executor-installs/${created.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap, status }) })).status).toBe(200)
    }
    const redeemed = await fetch(`${url}/api/executor-installs/${created.id}/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap, workspaceId: 'ws-api' }) })
    expect((await redeemed.json() as { token: string }).token).toMatch(/^ak_exec_/)
    expect((await fetch(`${url}/api/executor-installs/${created.id}/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap, workspaceId: 'ws-api' }) })).status).toBe(409)
    const events = await fetch(`${url}/api/executor-installs/${created.id}/events?after=1`).then((response) => response.json()) as { events: Array<{ seq: number }> }
    expect(events.events.every((event) => event.seq > 1)).toBe(true)
  })

  it('requires ingress admin for multi-tenant Platform while single-tenant no-auth remains explicitly usable', async () => {
    const dedicated = await start('single-tenant')
    expect((await fetch(`${dedicated.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'linux', mode: 'service', workspaceRoot: '/work' }) })).status).toBe(201)
    const privateCloud = await start('multi-tenant')
    const body = JSON.stringify({ platform: 'linux', mode: 'service', workspaceRoot: '/work' })
    expect((await fetch(`${privateCloud.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(403)
    expect((await fetch(`${privateCloud.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-runlab-principal': 'p', 'x-agent-runlab-organization-id': 'o', 'x-agent-runlab-organization-role': 'admin' }, body })).status).toBe(201)
  })

  it('scopes multi-tenant executor install management to the creating Organization', async () => {
    const privateCloud = await start('multi-tenant')
    const orgAHeaders = {
      'content-type': 'application/json',
      'x-agent-runlab-principal': 'admin-a@example.test',
      'x-agent-runlab-organization-id': 'org_a',
      'x-agent-runlab-organization-role': 'admin',
    }
    const orgBHeaders = {
      'content-type': 'application/json',
      'x-agent-runlab-principal': 'admin-b@example.test',
      'x-agent-runlab-organization-id': 'org_b',
      'x-agent-runlab-organization-role': 'admin',
    }
    const created = await fetch(`${privateCloud.url}/api/executor-installs`, {
      method: 'POST',
      headers: orgAHeaders,
      body: JSON.stringify({ platform: 'linux', mode: 'service', workspaceRoot: '/work' }),
    }).then((response) => response.json()) as { id: string; organizationId: string; principal: string; organizationRole: string }
    expect(created).toMatchObject({ organizationId: 'org_a', principal: 'admin-a@example.test', organizationRole: 'admin' })

    const blockedGet = await fetch(`${privateCloud.url}/api/executor-installs/${created.id}`, { headers: orgBHeaders })
    expect(blockedGet.status).toBe(403)
    await expect(blockedGet.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })

    const blockedPatch = await fetch(`${privateCloud.url}/api/executor-installs/${created.id}`, {
      method: 'PATCH',
      headers: orgBHeaders,
      body: JSON.stringify({ label: 'stolen' }),
    })
    expect(blockedPatch.status).toBe(403)

    const allowedGet = await fetch(`${privateCloud.url}/api/executor-installs/${created.id}`, { headers: orgAHeaders })
    expect(allowedGet.status).toBe(200)
    await expect(allowedGet.json()).resolves.toMatchObject({ organizationId: 'org_a', id: created.id })
  })
})
