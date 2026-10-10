#!/usr/bin/env node
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { AGENT_RUNTIME_CAPABILITIES, FULL_RUNTIME_CAPABILITIES, productVariant } from '@agent-kernel/shared'

import { startLoopbackHostRuntimeUnit } from '../src/tenant-runtime/loopback-host-unit.js'
import { resolveBuiltinAgentModule } from '../src/builtin-tools.js'
import { ExplicitLLMClientFactory } from '../src/llm/client-factory.js'
import { startTenantRuntimeService } from '../src/tenant-runtime/service.js'
import { readRequiredSecretEnv } from '../src/config/secret-env.js'
import { createRuntimeProviderRuntime, FileSecretResolver, loadRuntimeProviderCatalog } from '../src/llm/runtime-provider-catalog.js'
import { RuntimeUnitMaterializationStore } from '../src/tenant-runtime/materialization-store.js'
import { attachTenantRuntimeControlApi } from '../src/tenant-runtime/control-api.js'
import { LocalWebSearchCredentialStore } from '../src/web-search/credential-store.js'
import { KalaStateStore } from '../src/store/state-store.js'
import { LocalAzureSpeechCredentialStore } from '../src/speech/credential-store.js'
import { loadProductDeploymentConfig } from '../src/deployment-config.js'
import { UnitResourceGovernor } from '../src/tenant-runtime/resource-governor.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  // Private Cloud Runtime Units are operator-controlled. Match the Dedicated
  // binary's default while retaining an explicit opt-out.
  if (process.env.KALA_ALLOW_ALL_OK === undefined) process.env.KALA_ALLOW_ALL_OK = '1'
  const deployment = loadProductDeploymentConfig({ configPath: required('KALA_DEPLOYMENT_CONFIG') })
  if (productVariant(deployment) !== 'private-cloud') throw new Error('Runtime service requires a Private Cloud deployment config')
  const capabilities = deployment.runtimeProfile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES
  const port = Number(process.env.KALA_RUNTIME_KALA_PORT ?? 13002)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('KALA_RUNTIME_KALA_PORT must be a valid port')
  const ingressSecret = await readRequiredSecretEnv('KALA_INGRESS_SHARED_SECRET')
  if (Buffer.byteLength(ingressSecret) < 32) throw new Error('KALA_INGRESS_SHARED_SECRET must contain at least 32 bytes')
  const dataRoot = resolve(required('KALA_RUNTIME_HOST_DATA_ROOT'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const catalog = new RuntimeUnitMaterializationStore(join(dataRoot, 'host', 'runtime-unit-catalog.json'))
  await catalog.load()
  const catalogPath = process.env.KALA_RUNTIME_HOST_LLM_CATALOG_FILE?.trim()
  const runtimeProvider = catalogPath
    ? await createRuntimeProviderRuntime(
        await loadRuntimeProviderCatalog(catalogPath),
        new ExplicitLLMClientFactory(new FileSecretResolver(process.env.KALA_RUNTIME_HOST_SECRET_ROOT ?? '/run/kala-secrets')),
      )
    : await createEnvironmentRuntimeProvider()
  const agentModule = resolveBuiltinAgentModule()
  const resourceGovernor = new UnitResourceGovernor({
    maxConcurrentTurns: positiveIntegerEnv('KALA_RUNTIME_UNIT_MAX_CONCURRENT_TURNS', 4),
    maxQueuedMessages: positiveIntegerEnv('KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES', 100),
    maxArtifactBytes: positiveIntegerEnv('KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES', 10 * 1024 * 1024 * 1024),
  })
  const dashboardDir = process.env.KALA_RUNTIME_HOST_DASHBOARD_DIR
  const docsDir = process.env.KALA_RUNTIME_HOST_DOCS_DIR
  const releaseAssetsDir = process.env.KALA_RUNTIME_HOST_RELEASE_ASSETS_DIR
  // Anonymous downloads must never be bound to whichever organization happens
  // to be active. This reserved unit exposes only shared, read-only installers.
  const publicInstallerUnitId = 'public-installer'
  const isPublicInstallerRequest = (request: import('node:http').IncomingMessage): boolean => {
    const path = (request.url ?? '').split('?', 1)[0] ?? ''
    return (request.method === 'GET' || request.method === 'HEAD')
      && (path === '/install' || path === '/install.ps1' || path === '/install/invite.ps1'
        || path.startsWith('/install/assets/') || path.startsWith('/release-assets/'))
  }
  const tlsPaths = [
    process.env.KALA_RUNTIME_TLS_KEY_FILE,
    process.env.KALA_RUNTIME_TLS_CERT_FILE,
    process.env.KALA_RUNTIME_TLS_CA_FILE,
  ]
  if (tlsPaths.some(Boolean) && !tlsPaths.every(Boolean)) {
    throw new Error('KALA_RUNTIME_TLS_KEY_FILE, KALA_RUNTIME_TLS_CERT_FILE, and KALA_RUNTIME_TLS_CA_FILE must be configured together')
  }
  const host = await startTenantRuntimeService({
    port,
    listenHost: process.env.KALA_RUNTIME_KALA_BIND_HOST ?? '127.0.0.1',
    ingressSecret,
    requireProvisioning: true,
    maxLoadedUnits: Number(process.env.KALA_RUNTIME_HOST_MAX_LOADED_UNITS ?? 100),
    ...(tlsPaths.every(Boolean) ? {
      tls: {
        key: await readFile(tlsPaths[0]!),
        cert: await readFile(tlsPaths[1]!),
        ca: await readFile(tlsPaths[2]!),
      },
    } : {}),
    resolveUnitId: (request) => {
      const value = request.headers['x-agent-runlab-runtime-unit']
      if (value === publicInstallerUnitId) return releaseAssetsDir && isPublicInstallerRequest(request) ? value : undefined
      return typeof value === 'string' ? value : undefined
    },
    factory: async (id) => {
      const unitRoot = join(dataRoot, 'tenant-runtime-units', id)
      const workspaceDir = join(unitRoot, 'workspace')
      const stateStore = new KalaStateStore(unitRoot, {
        ...(process.env.KALA_STATE_MASTER_KEY_PATH ? { keyPath: process.env.KALA_STATE_MASTER_KEY_PATH } : {}),
        legacyMemoDirectory: join(unitRoot, 'memos'),
        legacyCredentialDirectory: join(unitRoot, 'credentials'),
      })
      const webSearchCredentialStore = new LocalWebSearchCredentialStore(stateStore)
      const speechCredentialStore = new LocalAzureSpeechCredentialStore(stateStore)
      await mkdir(workspaceDir, { recursive: true, mode: 0o700 })
      resourceGovernor.reconcile(id, {
        artifactBytes: await directoryBytes([
          join(unitRoot, 'artifacts'),
          join(unitRoot, 'session-artifacts'),
          join(unitRoot, 'message-attachments'),
        ]),
      })
      return startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(unitRoot, 'sessions'),
        artifactRootDir: join(unitRoot, 'artifacts'),
        ...(id === publicInstallerUnitId ? {} : { workspaceDir, executorIdentityStorePath: join(unitRoot, 'executor-identities.json') }),
        llm: runtimeProvider.llm,
        defaultConfig: agentModule.config,
        models: runtimeProvider.models,
        defaultModel: runtimeProvider.defaultModel,
        deployment,
        capabilities,
        webSearchCredentials: webSearchCredentialStore,
        webSearchCredentialStatus: () => webSearchCredentialStore.status(),
        setWebSearchCredential: (provider, key) => webSearchCredentialStore.set(provider, key),
        deleteWebSearchCredential: (provider) => webSearchCredentialStore.delete(provider),
        speechCredentials: speechCredentialStore,
        stateStore,
        resourceGovernor,
        resourceUnitId: id,
        resourceArtifactUsage: async () => await directoryBytes([
          join(unitRoot, 'artifacts'),
          join(unitRoot, 'session-artifacts'),
          join(unitRoot, 'message-attachments'),
        ]),
        ...(dashboardDir ? { staticDir: resolve(dashboardDir) } : {}),
        ...(docsDir ? { docsRootDir: resolve(docsDir) } : {}),
        ...(releaseAssetsDir ? { releaseAssetsDir: resolve(releaseAssetsDir) } : {}),
        settings: {
          providers: [], defaultModel: '', hooks: [],
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: join(unitRoot, 'sessions') },
          mcp: { supported: false, note: 'disabled in Private Cloud bootstrap' },
          ...(releaseAssetsDir ? { release: { bootstrapBaseUrl: '/release-assets', source: 'local' as const } } : {}),
        },
      })
    },
  })
  for (const entry of catalog.list()) if (entry.desiredState === 'ready') host.markRoutable(entry.unitId)
  if (releaseAssetsDir) host.markRoutable(publicInstallerUnitId)
  attachTenantRuntimeControlApi({ http: host.http, serviceSecret: ingressSecret, service: host, store: catalog, dataRoot, capabilities })
  process.stdout.write(`${JSON.stringify({ event: 'tenant_runtime_service_ready', port: host.port, dataRoot })}\n`)
  const shutdown = async (): Promise<void> => { await host.drain(); await host.close(); process.exit(0) }
  process.on('SIGTERM', () => { void shutdown() }); process.on('SIGINT', () => { void shutdown() })
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

async function directoryBytes(paths: readonly string[]): Promise<number> {
  let total = 0
  const pending = [...paths]
  while (pending.length > 0) {
    const path = pending.pop()!
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  }
  return total
}

async function createEnvironmentRuntimeProvider() {
  const llmApiKey = await readRequiredSecretEnv('KALA_RUNTIME_HOST_LLM_API_KEY')
  const model = required('KALA_RUNTIME_HOST_LLM_MODEL')
  const wire = process.env.KALA_RUNTIME_HOST_LLM_WIRE ?? 'openai'
  if (wire !== 'openai' && wire !== 'anthropic') throw new Error('KALA_RUNTIME_HOST_LLM_WIRE must be openai or anthropic')
  const baseUrl = required('KALA_RUNTIME_HOST_LLM_BASE_URL')
  const llm = await new ExplicitLLMClientFactory({ resolve: async () => llmApiKey }).create({ id: 'runtime-provider', wire, model, baseUrl, credentialRef: 'runtime-secret' })
  return { llm, models: [{ id: model, ref: model, providerId: wire, provider: wire, label: model }], defaultModel: model }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
