#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
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
import { loadProductDeploymentConfig } from '../src/deployment-config.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  // Private Cloud Runtime Units are operator-controlled. Match the Dedicated
  // binary's default while retaining an explicit opt-out.
  if (process.env.AK_ALLOW_ALL_OK === undefined) process.env.AK_ALLOW_ALL_OK = '1'
  const deployment = loadProductDeploymentConfig({ configPath: required('AGENT_RUNLAB_DEPLOYMENT_CONFIG') })
  if (productVariant(deployment) !== 'private-cloud') throw new Error('Runtime service requires a Private Cloud deployment config')
  const capabilities = deployment.runtimeProfile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES
  const port = Number(process.env.RUNTIME_HOST_PORT ?? 13002)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_HOST_PORT must be a valid port')
  const ingressSecret = await readRequiredSecretEnv('RUNTIME_INGRESS_SHARED_SECRET')
  if (Buffer.byteLength(ingressSecret) < 32) throw new Error('RUNTIME_INGRESS_SHARED_SECRET must contain at least 32 bytes')
  const dataRoot = resolve(required('RUNTIME_HOST_DATA_ROOT'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const catalog = new RuntimeUnitMaterializationStore(join(dataRoot, 'host', 'runtime-unit-catalog.json'))
  await catalog.load()
  const catalogPath = process.env.RUNTIME_HOST_LLM_CATALOG_FILE?.trim()
  const runtimeProvider = catalogPath
    ? await createRuntimeProviderRuntime(
        await loadRuntimeProviderCatalog(catalogPath),
        new ExplicitLLMClientFactory(new FileSecretResolver(process.env.RUNTIME_HOST_SECRET_ROOT ?? '/run/agent-runlab-secrets')),
      )
    : await createEnvironmentRuntimeProvider()
  const agentModule = resolveBuiltinAgentModule()
  const dashboardDir = process.env.RUNTIME_HOST_DASHBOARD_DIR
  const docsDir = process.env.RUNTIME_HOST_DOCS_DIR
  const releaseAssetsDir = process.env.RUNTIME_HOST_RELEASE_ASSETS_DIR
  const host = await startTenantRuntimeService({
    port,
    listenHost: process.env.RUNTIME_HOST_LISTEN_HOST ?? '127.0.0.1',
    ingressSecret,
    requireProvisioning: true,
    maxLoadedUnits: Number(process.env.RUNTIME_HOST_MAX_LOADED_UNITS ?? 100),
    resolveUnitId: (request) => {
      const value = request.headers['x-agent-runlab-runtime-unit']
      return typeof value === 'string' ? value : undefined
    },
    factory: async (id) => {
      const unitRoot = join(dataRoot, 'tenant-runtime-units', id)
      const workspaceDir = join(unitRoot, 'workspace')
      const webSearchCredentialStore = new LocalWebSearchCredentialStore(join(unitRoot, 'credentials'))
      await mkdir(workspaceDir, { recursive: true, mode: 0o700 })
      return startLoopbackHostRuntimeUnit(id, {
        sessionsDir: join(unitRoot, 'sessions'),
        artifactRootDir: join(unitRoot, 'artifacts'),
        workspaceDir,
        executorIdentityStorePath: join(unitRoot, 'executor-identities.json'),
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
  attachTenantRuntimeControlApi({ http: host.http, serviceSecret: ingressSecret, service: host, store: catalog, dataRoot, capabilities })
  process.stdout.write(`${JSON.stringify({ event: 'tenant_runtime_service_ready', port: host.port, dataRoot })}\n`)
  const shutdown = async (): Promise<void> => { await host.drain(); await host.close(); process.exit(0) }
  process.on('SIGTERM', () => { void shutdown() }); process.on('SIGINT', () => { void shutdown() })
}

async function createEnvironmentRuntimeProvider() {
  const llmApiKey = await readRequiredSecretEnv('RUNTIME_HOST_LLM_API_KEY')
  const model = required('RUNTIME_HOST_LLM_MODEL')
  const wire = process.env.RUNTIME_HOST_LLM_WIRE ?? 'openai'
  if (wire !== 'openai' && wire !== 'anthropic') throw new Error('RUNTIME_HOST_LLM_WIRE must be openai or anthropic')
  const baseUrl = required('RUNTIME_HOST_LLM_BASE_URL')
  const llm = await new ExplicitLLMClientFactory({ resolve: async () => llmApiKey }).create({ id: 'runtime-provider', wire, model, baseUrl, credentialRef: 'runtime-secret' })
  return { llm, models: [{ id: model, ref: model, providerId: wire, provider: wire, label: model }], defaultModel: model }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
