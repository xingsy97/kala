#!/usr/bin/env node
import { resolve } from 'node:path'
import process from 'node:process'

import { JsonOrganizationStore } from '../organizations/json-store.js'
import { PostgresOrganizationStore } from '../organizations/postgres-store.js'
import { startRuntimeIngressGateway } from '../edge/server.js'
import { createOidcClient } from '../auth/oidc-client.js'
import { readRequiredSecretEnv } from '../config/secret-env.js'
import { FileLoginStateStore } from '../auth/login-state-store.js'
import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import { PostgresBrowserSessionStore } from '../auth/postgres-browser-session-store.js'
import { createPostgresControlPlaneDatabase, type ControlPlaneDatabase } from '../persistence/postgres.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import { loadEnterpriseSsoResolver } from '../auth/enterprise-sso-config.js'

async function main(): Promise<void> {
  const port = Number(process.env.RUNTIME_INGRESS_PORT ?? 13001)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_INGRESS_PORT must be a valid port')
  const cacheNamespaceSecret = await readRequiredSecretEnv('RUNTIME_INGRESS_SESSION_SECRET')
  const ingressSecret = await readRequiredSecretEnv('RUNTIME_INGRESS_SHARED_SECRET')
  if (Buffer.byteLength(cacheNamespaceSecret) < 32 || Buffer.byteLength(ingressSecret) < 32) throw new Error('Private Cloud secrets must contain at least 32 bytes')
  let database: ControlPlaneDatabase | undefined
  const databaseUrl = process.env.RUNTIME_INGRESS_DATABASE_URL || (process.env.RUNTIME_INGRESS_DATABASE_URL_FILE ? await readRequiredSecretEnv('RUNTIME_INGRESS_DATABASE_URL') : undefined)
  if (!databaseUrl && process.env.NODE_ENV === 'production') throw new Error('RUNTIME_INGRESS_DATABASE_URL is required in production; JSON control stores are migration-only')
  const organizations = databaseUrl
    ? new PostgresOrganizationStore(database = createPostgresControlPlaneDatabase({ connectionString: databaseUrl }))
    : new JsonOrganizationStore(resolve(await readRequiredSecretEnv('RUNTIME_INGRESS_UNIT_DIRECTORY')))
  if (organizations instanceof JsonOrganizationStore) await organizations.load()
  else await database!.health()
  const loginStates = new FileLoginStateStore(resolve(await readRequiredSecretEnv('RUNTIME_INGRESS_LOGIN_STATE_STORE')))
  await loginStates.load()
  const sessions = database
    ? new PostgresBrowserSessionStore(database)
    : new FileBrowserSessionStore(resolve(process.env.RUNTIME_INGRESS_BROWSER_SESSION_STORE ?? `${await readRequiredSecretEnv('RUNTIME_INGRESS_LOGIN_STATE_STORE')}.sessions`))
  if (sessions instanceof FileBrowserSessionStore) await sessions.load()
  const secretBox = createSessionSecretBox('active', [{ id: 'active', key: Buffer.from(cacheNamespaceSecret).subarray(0, 32) }])
  const oidc = await createOidcClient({
    issuer: new URL(await readRequiredSecretEnv('OIDC_ISSUER')),
    clientId: await readRequiredSecretEnv('OIDC_CLIENT_ID'),
    clientSecret: await readRequiredSecretEnv('OIDC_CLIENT_SECRET'),
    discoveryOrigin: new URL(await readRequiredSecretEnv('RUNTIME_INGRESS_IDENTITY_ORIGIN')),
    allowInsecureHttp: process.env.RUNTIME_INGRESS_ALLOW_INSECURE_HTTP === '1',
  })
  const enterpriseSso = process.env.RUNTIME_INGRESS_ENTERPRISE_SSO_CONFIG
    ? await loadEnterpriseSsoResolver(resolve(process.env.RUNTIME_INGRESS_ENTERPRISE_SSO_CONFIG))
    : undefined
  const gateway = await startRuntimeIngressGateway({
    port,
    listenHost: process.env.RUNTIME_INGRESS_LISTEN_HOST ?? '127.0.0.1',
    oidc,
    organizations,
    ...(enterpriseSso ? { enterpriseSso } : {}),
    directory: {
      getOrCreateForIdentity: async (identity) => { const access = await organizations.getOrCreateForIdentity(identity); return { unitId: access.organization.unitId, identity } },
      findByIdentity: async (identity) => { const access = await organizations.findAccess(identity); return access ? { unitId: access.organization.unitId, identity } : undefined },
      bindExecutorInvite: (token, unitId) => organizations.bindExecutorInvite(token, unitId),
      findUnitByExecutorInvite: (token) => organizations.findUnitByExecutorInvite(token),
    },
    loginStates,
    sessions,
    hostOrigin: await readRequiredSecretEnv('RUNTIME_HOST_ORIGIN'),
    ...(process.env.RUNTIME_DASHBOARD_ORIGIN ? { dashboardOrigin: await readRequiredSecretEnv('RUNTIME_DASHBOARD_ORIGIN') } : {}),
    publicOrigin: await readRequiredSecretEnv('INGRESS_PUBLIC_ORIGIN'),
    cacheNamespaceSecret,
    secretBox,
    ingressSecret,
    provision: async (unitId) => {
      const response = await fetch(`${await readRequiredSecretEnv('RUNTIME_HOST_ORIGIN')}/internal/runtime-units`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-secret': ingressSecret },
        body: JSON.stringify({ unitId, operationId: `provision:${unitId}`, generation: 1 }),
      })
      if (!response.ok) throw new Error(`Tenant provisioning failed: ${response.status} ${await response.text()}`)
    },
  })
  process.stdout.write(`${JSON.stringify({ event: 'private_cloud_gateway_ready', port: gateway.port })}\n`)
  const close = async (): Promise<void> => { await gateway.close(); await database?.close(); process.exit(0) }
  process.on('SIGTERM', () => { void close() }); process.on('SIGINT', () => { void close() })
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
