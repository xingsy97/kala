#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { SAAS_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import { startLoopbackHostRuntimeUnit } from '../src/tenant-runtime/loopback-host-unit.js'
import { resolveBuiltinAgentModule } from '../src/builtin-tools.js'
import { ExplicitLLMClientFactory } from '../src/llm/client-factory.js'
import { startTenantRuntimeService } from '../src/tenant-runtime/service.js'
import { readRequiredSecretEnv } from '../src/config/secret-env.js'
import { createRuntimeProviderRuntime, FileSecretResolver, loadRuntimeProviderCatalog } from '../src/llm/runtime-provider-catalog.js'
import { RuntimeUnitMaterializationStore } from '../src/tenant-runtime/materialization-store.js'
import { attachTenantRuntimeControlApi } from '../src/tenant-runtime/control-api.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  // Hosted RuntimeUnits are private, operator-controlled runtimes. Match the
  // standalone binary's default while retaining an explicit opt-out.
  if (process.env.AK_ALLOW_ALL_OK === undefined) process.env.AK_ALLOW_ALL_OK = '1'
  const port = Number(process.env.RUNTIME_HOST_PORT ?? process.env.SAAS_HOST_PORT ?? 13002)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_HOST_PORT must be a valid port')
  const ingressSecret = await readRequiredSecretEnv('RUNTIME_INGRESS_SHARED_SECRET')
  if (Buffer.byteLength(ingressSecret) < 32) throw new Error('RUNTIME_INGRESS_SHARED_SECRET must contain at least 32 bytes')
  const dataRoot = resolve(required(process.env.RUNTIME_HOST_DATA_ROOT ? 'RUNTIME_HOST_DATA_ROOT' : 'SAAS_DATA_ROOT'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const catalog = new RuntimeUnitMaterializationStore(join(dataRoot, 'host', 'runtime-unit-catalog.json'))
  await catalog.load()
  const catalogPath = process.env.RUNTIME_HOST_LLM_CATALOG_FILE?.trim()
  const runtimeProvider = catalogPath
    ? await createRuntimeProviderRuntime(
        await loadRuntimeProviderCatalog(catalogPath),
        new ExplicitLLMClientFactory(new FileSecretResolver(process.env.RUNTIME_HOST_SECRET_ROOT ?? '/run/agent-runlab-secrets')),
      )
    : await createLegacyRuntimeProvider()
  const agentModule = resolveBuiltinAgentModule()
  const dashboardDir = process.env.RUNTIME_HOST_DASHBOARD_DIR ?? process.env.SAAS_DASHBOARD_DIR
  const docsDir = process.env.RUNTIME_HOST_DOCS_DIR ?? process.env.SAAS_DOCS_DIR
  const releaseAssetsDir = process.env.RUNTIME_HOST_RELEASE_ASSETS_DIR ?? process.env.SAAS_RELEASE_ASSETS_DIR
  const host = await startTenantRuntimeService({
    port,
    listenHost: process.env.RUNTIME_HOST_LISTEN_HOST ?? process.env.SAAS_LISTEN_HOST ?? '127.0.0.1',
    ingressSecret,
    requireProvisioning: true,
    maxLoadedUnits: Number(process.env.RUNTIME_HOST_MAX_LOADED_UNITS ?? process.env.SAAS_MAX_LOADED_UNITS ?? 100),
    resolveUnitId: (request) => {
      const value = request.headers['x-agent-runlab-runtime-unit']
      return typeof value === 'string' ? value : undefined
    },
    factory: async (id) => {
      const unitRoot = join(dataRoot, 'tenant-runtime-units', id)
      const workspaceDir = join(unitRoot, 'workspace')
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
        deploymentMode: 'saas',
        capabilities: SAAS_RUNTIME_CAPABILITIES,
        ...(dashboardDir ? { staticDir: resolve(dashboardDir) } : {}),
        ...(docsDir ? { docsRootDir: resolve(docsDir) } : {}),
        ...(releaseAssetsDir ? { releaseAssetsDir: resolve(releaseAssetsDir) } : {}),
        settings: {
          providers: [], defaultModel: '', hooks: [],
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: join(unitRoot, 'sessions') },
          mcp: { supported: false, note: 'disabled in SaaS bootstrap' },
          ...(releaseAssetsDir ? { release: { bootstrapBaseUrl: '/release-assets', source: 'local' as const } } : {}),
        },
      })
    },
  })
  for (const entry of catalog.list()) if (entry.desiredState === 'ready') host.markRoutable(entry.unitId)
  attachTenantRuntimeControlApi({ http: host.http, serviceSecret: ingressSecret, service: host, store: catalog, dataRoot })
  process.stdout.write(`${JSON.stringify({ event: 'tenant_runtime_service_ready', port: host.port, dataRoot })}\n`)
  const shutdown = async (): Promise<void> => { await host.drain(); await host.close(); process.exit(0) }
  process.on('SIGTERM', () => { void shutdown() }); process.on('SIGINT', () => { void shutdown() })
}

async function createLegacyRuntimeProvider() {
  const llmApiKey = await readRequiredSecretEnv(process.env.RUNTIME_HOST_LLM_API_KEY || process.env.RUNTIME_HOST_LLM_API_KEY_FILE ? 'RUNTIME_HOST_LLM_API_KEY' : 'SAAS_LLM_API_KEY')
  const model = required(process.env.RUNTIME_HOST_LLM_MODEL ? 'RUNTIME_HOST_LLM_MODEL' : 'SAAS_LLM_MODEL')
  const wire = process.env.RUNTIME_HOST_LLM_WIRE ?? process.env.SAAS_LLM_WIRE ?? 'openai'
  if (wire !== 'openai' && wire !== 'anthropic') throw new Error('RUNTIME_HOST_LLM_WIRE must be openai or anthropic')
  const baseUrl = required(process.env.RUNTIME_HOST_LLM_BASE_URL ? 'RUNTIME_HOST_LLM_BASE_URL' : 'SAAS_LLM_BASE_URL')
  const llm = await new ExplicitLLMClientFactory({ resolve: async () => llmApiKey }).create({ id: 'runtime-provider', wire, model, baseUrl, credentialRef: 'runtime-secret' })
  return { llm, models: [{ id: model, ref: model, providerId: wire, provider: wire, label: model }], defaultModel: model }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })
