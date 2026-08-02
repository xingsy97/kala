/**
 * HTTP request routing for the host process.
 *
 *   - `/models`     JSON, GET/HEAD    — sanitised model list for the dashboard
 *   - `/settings`   JSON, GET/HEAD    — settings snapshot
 *   - `/settings/models` POST/DELETE  — manually managed model ids
 *   - everything else                 — static bundle (dashboard `dist/`),
 *                                       with SPA fallback to `index.html`
 *
 * Socket.IO owns `/socket.io/*` on the same HTTP server; every handler here
 * short-circuits on that prefix so the two listeners don't clobber each
 * other. JSON routes always run first because static serving falls back to
 * `index.html` for unknown paths and would otherwise mask a missing endpoint.
 */

import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'

import type {
  AttachedExecutor,
  ClientAddManualModel,
  ClientAddManualProvider,
  ClientDeleteManualModel,
  ClientDeleteManualProvider,
  ClientSetDefaultModel,
  ClientUpdateAgentPromptSettings,
  ServerExecutorIdentitiesPayload,
  ServerExecutorIdentityRevokedPayload,
  ServerExecutorInvitePayload,
  ServerExecutorInviteRevokedPayload,
  ServerExecutorInvitesPayload,
  ModelInfo,
  HostRestartStatus,
  HostRestartAttempt,
  ServerModelsPayload,
  ServerSettingsPayload,
} from '@agent-kernel/shared'
import { schema } from '@agent-kernel/shared'
import { parseWire } from '../wire-validation.js'
import { disabledEnhancementCapability } from '../runtime-capabilities.js'

import { buildArtifactManifest, pruneArtifacts } from '../artifact-manifest.js'
import {
  exportRolloutFrameworkAdapter,
  exportRolloutSegments,
  exportRolloutSidecar,
} from '../rl-export.js'
import { verifyReward } from '../rl-reward.js'
import { exportSessionTraceArtifacts } from '../session-export.js'
import { exportTraceOtlp, loadHeadersFile } from '../trace-otlp-export.js'
import { compareEvalRuns, judgeScore, profileSession, scoreSession } from '../eval/session/generic.js'
import { evaluateRegressionGate, type RegressionThresholdPolicy } from '../eval/session/regression-gate.js'
import { aggregateProfiles } from '../eval/session/cost-aggregate.js'
import { evaluateProfileBudget, type ProfileBudgetPolicy } from '../eval/session/profile-budget.js'
import {
  exportSessionForSweBench,
  inferSweBenchPatchRun,
  ingestSweBenchResults,
  planSweBenchWorkerRun,
  runSweBenchAgentPatchRun,
  runSweBenchGrade,
  sweBenchRunLayout,
} from '../eval/swebench/swebench.js'
import {
  importTerminalBenchResults,
  resolveTerminalBenchTasks,
  runTerminalBenchRun,
  terminalBenchRunLayout,
} from '../eval/terminal-bench/terminal-bench.js'
import { runTerminalBench21Run } from '../eval/terminal-bench/terminal-bench-2_1.js'
import {
  importProgramBenchResults,
  programBenchRunLayout,
  runProgramBenchRun,
} from '../eval/programbench/programbench.js'
import {
  importSweMarathonResults,
  runSweMarathonRun,
} from '../eval/swe-marathon/swe-marathon.js'
import { mineBadCases } from '../eval/badcases/badcase-mining.js'
import { readSweBenchRunRegistry, unregisterSweBenchRun } from '../eval/core/run-registry.js'
import { getAgentBackend, listAgentBackends } from '../eval/core/agent-backend.js'
import { importLegacySweBench } from '../eval/core/legacy-swebench-import.js'
import { BenchmarkRunService } from '../eval/core/benchmark-run-service.js'
import { AgentBackendIdSchema } from '@agent-kernel/shared'
import { exportForRL, exportForSFT } from '../eval/badcases/badcase-export.js'
import { exportRollouts } from '../eval/badcases/rollout-export.js'
import { annotateBadCase, readBadCaseAnnotations, BAD_CASE_LABELS, type BadCaseLabel } from '../eval/badcases/badcase-annotations.js'
import {
  InstancesSourceError,
  resolveSweBenchInstances,
  type InstancesSource,
} from '../eval/swebench/swebench-instances-source.js'
import {
  PatchesSourceError,
  resolveSweBenchPatches,
} from '../eval/swebench/swebench-patches-source.js'
import {
  ResultsSourceError,
  resolveSweBenchResults,
} from '../eval/swebench/swebench-results-source.js'
import { buildMemoryIndex } from '../memory-index.js'
import { retrieveMemory } from '../memory-retrieval.js'
import { auditSessionReliability, replayReliabilityChaos } from '../reliability.js'
import { evaluateReliabilityGate, type ReliabilityGatePolicy } from '../reliability-gate.js'
import { classifyReliability } from '../reliability-classify.js'
import type { AuthConfig } from '../auth-control.js'
import {
  authenticateDashboardHandshake,
  buildGithubStart,
  clearGithubSessionCookie,
  finishGithubOAuth,
  setGithubSessionCookie,
  readGithubSession,
} from '../auth-control.js'
import type { AuditActor, AuditLogger } from '../audit-log.js'
import type { SessionArtifactRegistry } from '../session-artifact-registry.js'
import type { OperationalMetrics } from '../operational-metrics.js'
import type { MemoStore } from '../memo-store.js'
import { diffToolCatalogs } from '../tool-catalog-diff.js'
import { writeExecutorCapabilitySnapshot } from '../executor-capabilities.js'
import type { SessionStore } from '../store/session.js'
import { compareToolVersions } from '../tool-version.js'
import { exportSubAgentGraph } from '../subagent-graph.js'
import { ContentInputError, resolveContentToPath } from './content-inputs.js'
import {
  HttpThemeError,
  readMarketplaceTheme,
  readMarketplaceThemeExtension,
  searchMarketplaceThemes,
} from '../vscode-themes.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const ROUTE_CLAIMED = Symbol('agent-kernel-route-claimed')
const BENCHMARK_RUN_SERVICES = new Map<string, BenchmarkRunService>()

function benchmarkRunService(rootDir: string): BenchmarkRunService {
  const key = resolvePath(rootDir)
  const existing = BENCHMARK_RUN_SERVICES.get(key)
  if (existing) return existing
  const service = new BenchmarkRunService(key)
  BENCHMARK_RUN_SERVICES.set(key, service)
  return service
}

const MAX_ARTIFACT_CONTENT_BYTES = 1024 * 1024
const MAX_DOC_CONTENT_BYTES = 1024 * 1024

type CreateSweBenchPlanRequest = {
  rootDir?: string
  runId?: string
  dataset?: string
  split?: string
  model?: string
  instancesJsonl?: string
  instanceIds?: readonly string[] | string
  limit?: number
  maxWorkers?: number
  timeoutMs?: number
  repoCacheDir?: string
}

type EnhancementActionRequest = {
  action?: string
  rootDir?: string
  sessionId?: string
  text?: string
  sessionLogPath?: string
  sessionLogPaths?: readonly string[] | string
  workspaceRoot?: string
  runId?: string
  confirmRunId?: string
  confirmPermanent?: boolean
  evalInstanceId?: string
  instanceId?: string
  patchPath?: string
  requireDone?: boolean
  pricingPath?: string
  baselineSummaryPath?: string
  candidateSummaryPath?: string
  promptPath?: string
  responsePath?: string
  judgeModel?: string
  scorer?: string
  threshold?: number | string
  inputRef?: string
  includeGlobal?: boolean
  sessionsDir?: string
  taskId?: string
  frameworkTarget?: string
  framework?: string
  model?: string
  weightVersion?: string
  rewardPath?: string
  tokenSegmentsPath?: string
  sidecarPath?: string
  trialPath?: string
  scorePath?: string
  dataset?: string
  split?: string
  instancesJsonl?: string
  instanceIds?: readonly string[] | string
  limit?: number | string
  patchesDir?: string
  modelPatchPath?: string
  resultsDir?: string
  predictionsPath?: string
  maxWorkers?: number | string
  modal?: boolean
  cwd?: string
  minPassRate?: number | string
  maxPassRateDrop?: number | string
  maxFailedIncrease?: number | string
  maxTimeoutIncrease?: number | string
  maxResolvedDrop?: number | string
  failureLabelCaps?: Record<string, number | string>
  outputFilename?: string
  summaryPath?: string
  profilePath?: string
  maxEstimatedCostUsd?: number | string
  maxInputTokens?: number | string
  maxOutputTokens?: number | string
  maxTotalTokens?: number | string
  maxLlmCalls?: number | string
  maxToolCalls?: number | string
  maxToolErrors?: number | string
  maxWallTimeMs?: number | string
  maxAverageLlmDurationMs?: number | string
  maxP95LlmDurationMs?: number | string
  maxAverageTimeToFirstChunkMs?: number | string
  maxP95TimeToFirstChunkMs?: number | string
  maxMissingUsageCalls?: number | string
  maxLlmTraceMissingCalls?: number | string
  requireCostEstimated?: boolean | string
  chaosReportPath?: string
  maxDanglingCount?: number | string
  minRecoverableRatio?: number | string
  maxRecoveryEventCount?: number | string
  maxDanglingByKind?: Record<string, number | string>
  requireStatusIn?: readonly string[] | string
  maxIntegrityIssueCount?: number | string
  heartbeatPath?: string
  wedgedThresholdMs?: number | string
  baselineCatalogPath?: string
  candidateCatalogPath?: string
  query?: string
  maxTokens?: number | string
  maxHits?: number | string
  outputPath?: string
  maxHashBytes?: number | string
  olderThanDays?: number | string
  maxTotalBytes?: number | string
  kinds?: readonly string[] | string
  kind?: string
  dryRun?: boolean
  endpoint?: string
  headers?: Record<string, string> | string
  headersFilePath?: string
  retries?: number | string
  retryDelayMs?: number | string
  timeoutMs?: number | string
  serviceName?: string
  hostVersion?: string
  source?: string
  inlineContent?: string
  datasetRef?: string
  configName?: string
  datasetSplit?: string
  datasetLimit?: number | string
  hfToken?: string
  hfDatasetsServerBaseUrl?: string
  patches?: Record<string, string>
  resultsFiles?: Record<string, string>
  sessionLogContent?: string
  patchContent?: string
  promptContent?: string
  responseContent?: string
  baselineSummaryContent?: string
  candidateSummaryContent?: string
  chaosReportContent?: string
  heartbeatContent?: string
  baselineCatalogContent?: string
  candidateCatalogContent?: string
  rewardContent?: string
  tokenSegmentsContent?: string
  sidecarContent?: string
  trialContent?: string
  scoreContent?: string
  headersFileContent?: string
  modelPatchContent?: string
  profileContent?: string
  summaryContent?: string
  pricingContent?: string
  agentCommand?: string
  agentBackend?: string
  agentBackendConfig?: Record<string, unknown>
  spec?: unknown
  after?: number | string
  sourceDir?: string
  importId?: string
  skipCompleted?: boolean
  tasksJsonl?: string
  tasksContent?: string
  tasksDir?: string
  taskIds?: readonly string[] | string
  label?: string
  note?: string
  format?: string
  target?: string
  includeStatuses?: readonly string[] | string
}

function parseAllowedOriginsFromEnv(): string[] | null {
  const raw = process.env.AGENT_KERNEL_ALLOWED_ORIGINS
  if (!raw) return null
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : null
}

function applyCorsHeaders(req: IncomingMessage, headers: Record<string, string>): void {
  const allowed = parseAllowedOriginsFromEnv()
  if (allowed === null) {
    headers['access-control-allow-origin'] = '*'
    return
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['vary'] = 'Origin'
    headers['access-control-allow-credentials'] = 'true'
  }
}

export function attachJsonRoutes(
  server: HttpServer,
  payloads: {
    models: readonly ModelInfo[] | (() => readonly ModelInfo[])
    defaultModel: string | (() => string)
    settings?: ServerSettingsPayload | (() => ServerSettingsPayload)
    addManualModel?: (input: ClientAddManualModel) => ServerSettingsPayload
    deleteManualModel?: (input: ClientDeleteManualModel) => ServerSettingsPayload
    addManualProvider?: (input: ClientAddManualProvider) => ServerSettingsPayload
    deleteManualProvider?: (input: ClientDeleteManualProvider) => ServerSettingsPayload
    setDefaultModel?: (input: ClientSetDefaultModel) => ServerSettingsPayload
    updateAgentPrompt?: (input: ClientUpdateAgentPromptSettings) => ServerSettingsPayload
    initializeSocketAdmin?: (input: { password: string; mode?: 'development' | 'production' }) => ServerSettingsPayload
    updateSocketAdminMode?: (input: { mode: 'development' | 'production' }) => ServerSettingsPayload
    artifactRootDir?: string | false
    docsRootDir?: string
    sessionArtifacts?: SessionArtifactRegistry
    sessions?: SessionStore
    routerHealth?: () => unknown
    executorsSnapshot?: () => readonly AttachedExecutor[]
    toolRegistry?: () => readonly import('@agent-kernel/kernel').ToolSchema[]
    restartStatus?: () => HostRestartStatus
    requestRestart?: (input: { mode?: 'checkpoint' | 'when_idle' | 'force'; reason?: 'manual' | 'deploy' | 'settings_changed'; timeoutMs?: number }) => Promise<HostRestartAttempt>
    abortRestart?: () => HostRestartAttempt | null
    auth?: AuthConfig
    audit?: AuditLogger
    /**
     * Minimal queue access for the reliable "queue a message even if the
     * browser is closing" beacon path. Lets the HTTP layer enqueue+drain a
     * user message without a live socket.
     */
    enqueueUserMessage?: (input: { sessionId: string; text: string }) => Promise<void>
    capabilities?: import('@agent-kernel/shared').RuntimeCapabilities
    metrics?: OperationalMetrics
    memoStore?: MemoStore
  },
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    // Engine.IO exclusively owns this path and may already have committed the
    // polling response before Node invokes this later request listener.
    if (url.startsWith('/socket.io/') || routeClaimed(req) || res.headersSent || res.writableEnded) return
    // Keep error responses CORS-readable too; sendJson also applies the same
    // policy, but capability denials commonly use sendError.
    const corsHeaders: Record<string, string> = {}
    applyCorsHeaders(req, corsHeaders)
    for (const [name, value] of Object.entries(corsHeaders)) res.setHeader(name, value)
    // Strip query string / fragment before matching, so `/models?ts=…`
    // (cache-buster) still hits.
    const path = url.split('?')[0]?.split('#')[0] ?? ''
    if ((path === '/memo' || path === '/user/session-tabs') && ['GET', 'HEAD', 'PUT'].includes(req.method ?? '') && payloads.memoStore) {
      claimRoute(req)
      const principalOwner = memoOwner(req)
      const owner = principalOwner ? `${principalOwner}:${path === '/memo' ? 'memo' : 'session-tabs'}` : undefined
      if (!owner) { sendError(res, 401, 'memo_authentication_required'); return }
      if (req.method === 'GET' || req.method === 'HEAD') {
        void payloads.memoStore.read(owner).then((body) => sendJson(req, res, body)).catch((error) => sendError(res, 500, error instanceof Error ? error.message : String(error)))
        return
      }
      void readJson(req).then((raw) => {
        const body = raw as { content?: unknown; expectedRevision?: unknown }
        if (typeof body.content !== 'string' || (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0))) throw new HttpRouteError(400, 'invalid_memo_document')
        return payloads.memoStore!.write(owner, { content: body.content, ...(body.expectedRevision !== undefined ? { expectedRevision: Number(body.expectedRevision) } : {}) })
      }).then((body) => sendJson(req, res, body)).catch((error) => sendError(res, error instanceof Error && error.message === 'memo_revision_conflict' ? 409 : error instanceof HttpRouteError ? error.status : 500, error instanceof Error ? error.message : String(error)))
      return
    }
    if (path === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      const body = payloads.metrics?.render() ?? ''
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    if (req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type, authorization',
        'access-control-max-age': '600',
      }
      applyCorsHeaders(req, headers)
      if (headers['access-control-allow-origin']) {
        claimRoute(req)
        res.writeHead(204, headers)
        res.end()
        return
      }
    }
    const sessionToolLockMatch = path.match(/^\/runtime\/sessions\/([^/]+)\/tool-lock$/u)
    if (sessionToolLockMatch && req.method === 'GET' && payloads.sessions) {
      claimRoute(req)
      const record = payloads.sessions.get(decodeURIComponent(sessionToolLockMatch[1] ?? ''))
      if (!record) { sendError(res, 404, 'session not found'); return }
      sendJson(req, res, { sessionId: record.sessionId, tools: record.toolLock })
      return
    }
    if (path === '/runtime/tool-registry' && req.method === 'GET' && payloads.toolRegistry) {
      claimRoute(req)
      const executors = payloads.executorsSnapshot?.() ?? []
      sendJson(req, res, {
        generatedAt: new Date().toISOString(),
        tools: payloads.toolRegistry().map((tool) => { const required = tool.version ?? '0.0.0'; return { name: tool.name, version: required, schemaHash: tool.schemaHash ?? null, source: tool.toolsetId ?? 'unknown', execution: tool.executionKind ?? 'executor', implementations: executors.map((executor) => { const version = executor.toolImplementations?.[tool.executionHandler ?? tool.name]?.version; return { workspaceId: executor.workspaceId, version: version ?? null, status: compareToolVersions(required, version) } }) } }),
      })
      return
    }
    if (path === '/runtime/capabilities' && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      sendJson(req, res, {
        mode: payloads.capabilities?.benchmarks === false && payloads.capabilities?.evaluations === false ? 'saas' : 'standalone',
        capabilities: payloads.capabilities ?? { agent: true, benchmarks: true, evaluations: true },
      })
      return
    }
    if (path === '/themes/marketplace/search' && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''
      void searchMarketplaceThemes(query)
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, err instanceof HttpThemeError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    const themeExtensionMatch = path.match(/^\/themes\/marketplace\/extensions\/([^/]+)\/([^/]+)$/u)
    if (themeExtensionMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      void readMarketplaceThemeExtension(decodeURIComponent(themeExtensionMatch[1] ?? ''), decodeURIComponent(themeExtensionMatch[2] ?? ''))
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, err instanceof HttpThemeError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    const themeMatch = path.match(/^\/themes\/marketplace\/extensions\/([^/]+)\/([^/]+)\/themes\/([^/]+)$/u)
    if (themeMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      void readMarketplaceTheme(
        decodeURIComponent(themeMatch[1] ?? ''),
        decodeURIComponent(themeMatch[2] ?? ''),
        decodeURIComponent(themeMatch[3] ?? ''),
      )
        .then((body) => sendJson(req, res, body))
        .catch((err: unknown) => sendError(res, err instanceof HttpThemeError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/auth/github/start' && req.method === 'GET' && payloads.auth?.github) {
      claimRoute(req)
      try {
        const location = buildGithubStart(payloads.auth.github, res)
        res.statusCode = 302
        res.setHeader('location', location)
        res.end()
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/auth/github/callback' && req.method === 'GET' && payloads.auth?.github) {
      claimRoute(req)
      void finishGithubOAuth(req, payloads.auth.github)
        .then((result) => {
          if (!result.ok) {
            payloads.audit?.log({ action: 'auth.github_callback', actor: { kind: 'anonymous' }, outcome: 'denied', error: result.reason })
            sendError(res, 403, result.reason)
            return
          }
          setGithubSessionCookie(res, payloads.auth!.github!, result.session)
          payloads.audit?.log({ action: 'auth.github_login', actor: { kind: 'github_user', login: result.session.login, ...(result.session.id !== undefined ? { id: result.session.id } : {}) }, outcome: 'ok' })
          res.statusCode = 302
          res.setHeader('location', '/')
          res.end()
        })
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      claimRoute(req)
      clearGithubSessionCookie(res)
      sendJson(req, res, { ok: true })
      return
    }
    if (path === '/auth/executor-invites' && req.method === 'GET') {
      claimRoute(req)
      const auth = payloads.auth?.github?.required ? authenticateDashboardHandshake(undefined, req, payloads.auth) : { ok: true as const }
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_invite.list', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, 401, auth.reason)
        return
      }
      const body: ServerExecutorInvitesPayload = { invites: payloads.auth?.executorIdentityStore?.inviteSnapshot() ?? [] }
      sendJson(req, res, body)
      return
    }
    if (path === '/auth/executor-pairings' && req.method === 'POST') {
      claimRoute(req)
      void readJson(req).then((body) => {
        const input=body as {workspaceId?:unknown;label?:unknown};const workspaceId=cleanString(input.workspaceId)
        if(!workspaceId){sendError(res,400,'workspaceId is required');return}
        const pairing=payloads.auth?.executorIdentityStore?.createPairing({workspaceId,label:cleanString(input.label)})
        if(!pairing){sendError(res,500,'executor identity store is not configured');return}
        payloads.audit?.log({action:'executor_pairing.request',actor:{kind:'anonymous'},target:{workspaceId},outcome:'ok',metadata:{id:pairing.id}})
        sendJson(req,res,pairing)
      }).catch((e)=>sendError(res,400,e instanceof Error?e.message:String(e)));return
    }
    if (path === '/auth/executor-pairings' && req.method === 'GET') { claimRoute(req);sendJson(req,res,{pairings:payloads.auth?.executorIdentityStore?.pairingSnapshot()??[]});return }
    const pairingMatch=path.match(/^\/auth\/executor-pairings\/([^/]+)\/(approve|reject|claim)$/u)
    if(pairingMatch&&req.method==='POST'){
      claimRoute(req);const id=decodeURIComponent(pairingMatch[1]??''),action=pairingMatch[2]
      if(action==='claim'){void readJson(req).then((body)=>{const secret=cleanString((body as {claimSecret?:unknown}).claimSecret);const result=secret?payloads.auth?.executorIdentityStore?.claimPairing(id,secret):undefined;if(!result){sendError(res,404,'pairing not found');return}sendJson(req,res,result)});return}
      const result=payloads.auth?.executorIdentityStore?.decidePairing(id,action==='approve');if(!result){sendError(res,404,'pending pairing not found');return}payloads.audit?.log({action:`executor_pairing.${action}`,actor:httpActor(req,payloads.auth),target:{workspaceId:result.workspaceId},outcome:'ok',metadata:{id}});sendJson(req,res,result);return
    }
    if (path === '/auth/executor-invites' && req.method === 'POST') {
      claimRoute(req)
      const auth = payloads.auth?.github?.required ? authenticateDashboardHandshake(undefined, req, payloads.auth) : { ok: true as const }
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_invite.create', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, 401, auth.reason)
        return
      }
      void readJson(req)
        .then((body) => {
          const input = typeof body === 'object' && body !== null ? body as { label?: unknown; workspaceId?: unknown } : {}
          const invite = payloads.auth?.executorIdentityStore?.createInvite({ label: cleanString(input.label), workspaceId: cleanString(input.workspaceId) })
          if (!invite) {
            sendError(res, 500, 'executor identity store is not configured')
            return
          }
          const response: ServerExecutorInvitePayload = invite
          payloads.audit?.log({ action: 'executor_invite.create', actor: httpActor(req, payloads.auth), outcome: 'ok', target: invite.workspaceId ? { workspaceId: invite.workspaceId } : undefined, metadata: { id: invite.id } })
          sendJson(req, res, response)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    const invitePathMatch = path.match(/^\/auth\/executor-invites\/([^/]+)(?:\/(regenerate))?$/u)
    if (invitePathMatch && (req.method === 'PATCH' || req.method === 'DELETE' || req.method === 'POST')) {
      claimRoute(req)
      const auth = payloads.auth?.github?.required ? authenticateDashboardHandshake(undefined, req, payloads.auth) : { ok: true as const }
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_invite.manage', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, 401, auth.reason)
        return
      }
      const id = decodeURIComponent(invitePathMatch[1] ?? '').trim()
      const action = invitePathMatch[2]
      if (!id) {
        sendError(res, 400, 'invite id is required')
        return
      }
      if (req.method === 'PATCH' && !action) {
        void readJson(req)
          .then((body) => {
            const input = typeof body === 'object' && body !== null ? body as { label?: unknown; workspaceId?: unknown } : {}
            const updated = payloads.auth?.executorIdentityStore?.updateInvite(id, {
              ...(Object.prototype.hasOwnProperty.call(input, 'label') ? { label: cleanString(input.label) ?? '' } : {}),
              ...(Object.prototype.hasOwnProperty.call(input, 'workspaceId') ? { workspaceId: input.workspaceId === null ? null : cleanString(input.workspaceId) ?? '' } : {}),
            })
            if (!updated) {
              sendError(res, 404, 'invite not found')
              return
            }
            payloads.audit?.log({ action: 'executor_invite.update', actor: httpActor(req, payloads.auth), outcome: 'ok', metadata: { id } })
            sendJson(req, res, updated)
          })
          .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
        return
      }
      if (req.method === 'DELETE' && !action) {
        const revoked = payloads.auth?.executorIdentityStore?.revokeInvite(id) ?? false
        payloads.audit?.log({ action: 'executor_invite.revoke', actor: httpActor(req, payloads.auth), outcome: revoked ? 'ok' : 'denied', ...(revoked ? {} : { error: 'invite_not_found' }), metadata: { id } })
        const body: ServerExecutorInviteRevokedPayload = { ok: true, id, revoked }
        sendJson(req, res, body)
        return
      }
      if (req.method === 'POST' && action === 'regenerate') {
        const invite = payloads.auth?.executorIdentityStore?.regenerateInvite(id)
        if (!invite) {
          sendError(res, 404, 'invite not found')
          return
        }
        const response: ServerExecutorInvitePayload = invite
        payloads.audit?.log({ action: 'executor_invite.regenerate', actor: httpActor(req, payloads.auth), outcome: 'ok', metadata: { id } })
        sendJson(req, res, response)
        return
      }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (path === '/auth/executor-identities' && req.method === 'GET') {
      claimRoute(req)
      const auth = payloads.auth?.github?.required ? authenticateDashboardHandshake(undefined, req, payloads.auth) : { ok: true as const }
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_identity.list', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, 401, auth.reason)
        return
      }
      const identities = payloads.auth?.executorIdentityStore?.snapshot() ?? []
      const body: ServerExecutorIdentitiesPayload = {
        identities: identities.map((entry) => ({
          workspaceId: entry.workspaceId,
          ...(entry.label ? { label: entry.label } : {}),
          createdAt: entry.createdAt,
          ...(entry.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
        })),
      }
      sendJson(req, res, body)
      return
    }
    if (path === '/auth/executor-identities' && req.method === 'DELETE') {
      claimRoute(req)
      const auth = payloads.auth?.github?.required ? authenticateDashboardHandshake(undefined, req, payloads.auth) : { ok: true as const }
      if (!auth.ok) {
        payloads.audit?.log({ action: 'executor_identity.revoke', actor: { kind: 'anonymous' }, outcome: 'denied', error: auth.reason })
        sendError(res, 401, auth.reason)
        return
      }
      const parsed = new URL(url, 'http://x')
      const workspaceId = parsed.searchParams.get('workspaceId')?.trim() ?? ''
      if (!workspaceId) {
        sendError(res, 400, 'workspaceId is required')
        return
      }
      const revoked = payloads.auth?.executorIdentityStore?.revokeWorkspace(workspaceId) ?? false
      payloads.audit?.log({ action: 'executor_identity.revoke', actor: httpActor(req, payloads.auth), target: { workspaceId }, outcome: revoked ? 'ok' : 'denied', ...(revoked ? {} : { error: 'identity_not_found' }) })
      const body: ServerExecutorIdentityRevokedPayload = { ok: true, workspaceId, revoked }
      sendJson(req, res, body)
      return
    }
    if (payloads.auth?.github?.required && isProtectedJsonRoute(path)) {
      const auth = authenticateDashboardHandshake(undefined, req, payloads.auth)
      if (!auth.ok) {
        payloads.audit?.log({ action: 'http.auth_reject', actor: { kind: 'anonymous' }, target: { path, method: req.method }, outcome: 'denied', error: auth.reason })
        claimRoute(req)
        sendError(res, 401, auth.reason)
        return
      }
    }
    if (path === '/runtime/restart/status' && payloads.restartStatus && (req.method === 'GET' || req.method === 'HEAD')) {
      claimRoute(req)
      sendJson(req, res, payloads.restartStatus())
      return
    }
    if (path === '/runtime/restart' && payloads.requestRestart && req.method === 'POST') {
      claimRoute(req)
      void readJson(req)
        .then(async (body) => {
          const input = parseRestartRequest(body)
          const result = await payloads.requestRestart!(input)
          payloads.audit?.log({ action: 'runtime.restart_request', actor: httpActor(req, payloads.auth), outcome: 'ok', metadata: { mode: result.mode, reason: result.reason, attemptId: result.attemptId } })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/runtime/restart/abort' && payloads.abortRestart && req.method === 'POST') {
      claimRoute(req)
      const result = payloads.abortRestart()
      payloads.audit?.log({ action: 'runtime.restart_abort', actor: httpActor(req, payloads.auth), outcome: result ? 'ok' : 'denied' })
      sendJson(req, res, result ?? { ok: false })
      return
    }
    if (path === '/settings/models' && req.method === 'POST' && payloads.addManualModel) {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientAddManualModelSchema, body, { channel: 'POST /settings/models' })
          if (!input) {
            sendError(res, 400, 'invalid manual model input')
            return
          }
          const result = payloads.addManualModel!(input)
          payloads.audit?.log({ action: 'settings.model_add', actor: httpActor(req, payloads.auth), target: { providerId: input.providerId, model: input.id }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/models' && req.method === 'DELETE' && payloads.deleteManualModel) {
      claimRoute(req)
      const parsed = new URL(url, 'http://x')
      try {
        const input = parseWire(schema.ClientDeleteManualModelSchema, {
          providerId: parsed.searchParams.get('providerId') ?? '',
          id: parsed.searchParams.get('id') ?? '',
        }, { channel: 'DELETE /settings/models' })
        if (!input) {
          sendError(res, 400, 'invalid manual model delete input')
          return
        }
        const result = payloads.deleteManualModel(input)
        payloads.audit?.log({ action: 'settings.model_delete', actor: httpActor(req, payloads.auth), target: { providerId: input.providerId, model: input.id }, outcome: 'ok' })
        sendJson(req, res, result)
      } catch (err: unknown) {
        sendError(res, 400, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/settings/providers' && req.method === 'POST' && payloads.addManualProvider) {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientAddManualProviderSchema, body, { channel: 'POST /settings/providers' })
          if (!input) {
            sendError(res, 400, 'invalid manual provider input')
            return
          }
          const result = payloads.addManualProvider!(input)
          payloads.audit?.log({ action: 'settings.provider_add', actor: httpActor(req, payloads.auth), target: { providerId: input.id }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/providers' && req.method === 'DELETE' && payloads.deleteManualProvider) {
      claimRoute(req)
      const parsed = new URL(url, 'http://x')
      try {
        const input = parseWire(schema.ClientDeleteManualProviderSchema, {
          providerId: parsed.searchParams.get('providerId') ?? '',
        }, { channel: 'DELETE /settings/providers' })
        if (!input) {
          sendError(res, 400, 'invalid manual provider delete input')
          return
        }
        const result = payloads.deleteManualProvider(input)
        payloads.audit?.log({ action: 'settings.provider_delete', actor: httpActor(req, payloads.auth), target: { providerId: input.providerId }, outcome: 'ok' })
        sendJson(req, res, result)
      } catch (err: unknown) {
        sendError(res, 400, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/settings/default-model' && req.method === 'POST' && payloads.setDefaultModel) {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientSetDefaultModelSchema, body, { channel: 'POST /settings/default-model' })
          if (!input) {
            sendError(res, 400, 'invalid default model input')
            return
          }
          const result = payloads.setDefaultModel!(input)
          payloads.audit?.log({ action: 'settings.default_model_set', actor: httpActor(req, payloads.auth), target: { model: input.model }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/agent-prompt' && req.method === 'POST' && payloads.updateAgentPrompt) {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const input = parseWire(schema.ClientUpdateAgentPromptSettingsSchema, body, { channel: 'POST /settings/agent-prompt' })
          if (!input) {
            sendError(res, 400, 'invalid agent prompt settings input')
            return
          }
          const result = payloads.updateAgentPrompt!(input)
          payloads.audit?.log({ action: 'settings.agent_prompt_update', actor: httpActor(req, payloads.auth), target: { preset: input.preset }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/socket-admin/init' && req.method === 'POST' && payloads.initializeSocketAdmin) {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const input = typeof body === 'object' && body !== null ? body as { password?: unknown; mode?: unknown } : {}
          const password = typeof input.password === 'string' ? input.password : ''
          if (!password.trim()) {
            sendError(res, 400, 'password is required')
            return
          }
          if (input.mode !== undefined && input.mode !== 'development' && input.mode !== 'production') {
            sendError(res, 400, 'mode must be development or production')
            return
          }
          const result = payloads.initializeSocketAdmin!({ password, ...(input.mode ? { mode: input.mode } : {}) })
          payloads.audit?.log({ action: 'settings.socket_admin_init', actor: httpActor(req, payloads.auth), outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => {
          const status = err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
            ? (err as { status: number }).status
            : 400
          sendError(res, status, err instanceof Error ? err.message : String(err))
        })
      return
    }
    if (path === '/settings/socket-admin/mode' && req.method === 'POST' && payloads.updateSocketAdminMode) {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const input = typeof body === 'object' && body !== null ? body as { mode?: unknown } : {}
          if (input.mode !== 'development' && input.mode !== 'production') {
            sendError(res, 400, 'mode must be development or production')
            return
          }
          const result = payloads.updateSocketAdminMode!({ mode: input.mode })
          payloads.audit?.log({ action: 'settings.socket_admin_mode_update', actor: httpActor(req, payloads.auth), target: { mode: input.mode }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/eval/swebench/plan' && req.method === 'POST') {
      claimRoute(req)
      if (payloads.capabilities?.evaluations === false || payloads.capabilities?.benchmarks === false) {
        sendError(res, 403, 'FEATURE_DISABLED: evaluations')
        return
      }
      void readJson(req)
        .then((body) => createSweBenchPlan(body as CreateSweBenchPlanRequest, payloads.artifactRootDir))
        .then((result) => sendJson(req, res, result))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/enhancement/action' && req.method === 'POST') {
      claimRoute(req)
      void readJson(req)
        .then((body) => {
          const request = body as EnhancementActionRequest
          const action = requiredString(request.action, 'action')
          const disabled = payloads.capabilities ? disabledEnhancementCapability(action, payloads.capabilities) : null
          if (disabled) throw new HttpRouteError(403, `FEATURE_DISABLED: ${disabled}`)
          return runEnhancementAction(request, payloads)
        })
        .then((result) => {
          payloads.audit?.log({ action: 'http.enhancement_action', actor: httpActor(req, payloads.auth), target: { action: (result as { action?: unknown }).action }, outcome: 'ok' })
          sendJson(req, res, result)
        })
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (req.method === 'POST' && path === '/session-artifacts/register') {
      claimRoute(req)
      if (!payloads.sessionArtifacts || !payloads.sessions) { sendError(res, 404, 'session artifacts are not configured'); return }
      void readJson(req).then(async (body) => {
        const input = body as { sessionId?: string; title?: string; fileName?: string; data?: string }
        if (!input.sessionId || !input.fileName || !input.data) throw new HttpRouteError(400, 'sessionId, fileName, and base64 data are required')
        await payloads.sessions!.load(input.sessionId)
        const record = await payloads.sessionArtifacts!.registerImage({ sessionId: input.sessionId, title: input.title, fileName: input.fileName, data: Buffer.from(input.data, 'base64') })
        sendJson(req, res, { ...record, uri: `artifact://${record.artifactId}` })
      }).catch((error: unknown) => sendError(res, error instanceof HttpRouteError ? error.status : 400, error instanceof Error ? error.message : String(error)))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (path.startsWith('/session-artifacts/')) {
      claimRoute(req)
      const artifactId = decodeURIComponent(path.slice('/session-artifacts/'.length))
      const record = payloads.sessionArtifacts?.get(artifactId)
      if (!record || !payloads.sessions) { sendError(res, 404, 'artifact not found'); return }
      const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId')
      if (!sessionId || record.sessionId !== sessionId) { sendError(res, 403, 'artifact does not belong to this session'); return }
      void payloads.sessions.load(sessionId)
        .then(() => {
          const headers = { 'content-type': record.mediaType, 'content-length': String(record.bytes), 'cache-control': 'private, max-age=31536000, immutable', etag: `"${record.sha256}"` }
          res.writeHead(200, headers)
          if (req.method === 'HEAD') res.end()
          else createReadStream(payloads.sessionArtifacts!.contentPath(record)).pipe(res)
        })
        .catch(() => sendError(res, 404, 'session not found'))
      return
    }
    if (path === '/artifacts/manifest') {
      claimRoute(req)
      if (!payloads.artifactRootDir) {
        sendError(res, 404, 'artifact capture is not configured')
        return
      }
      void buildArtifactManifest({ rootDir: payloads.artifactRootDir })
        .then((result) => sendJson(req, res, result.manifest))
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/artifacts/content') {
      claimRoute(req)
      if (!payloads.artifactRootDir) {
        sendError(res, 404, 'artifact capture is not configured')
        return
      }
      void readArtifactContent(url, payloads.artifactRootDir)
        .then((content) => sendJson(req, res, content))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/docs/index') {
      claimRoute(req)
      void listDocsIndex(payloads.docsRootDir)
        .then((result) => sendJson(req, res, result))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/docs/content') {
      claimRoute(req)
      void readDocContent(url, payloads.docsRootDir)
        .then((content) => sendJson(req, res, content))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/models') {
      claimRoute(req)
      const body: ServerModelsPayload = {
        models: valueOf(payloads.models),
        defaultModel: valueOf(payloads.defaultModel),
      }
      sendJson(req, res, body)
      return
    }
    if (path === '/settings' && payloads.settings) {
      claimRoute(req)
      sendJson(req, res, valueOf(payloads.settings))
      return
    }
    if (path === '/router/health' && payloads.routerHealth) {
      claimRoute(req)
      sendJson(req, res, payloads.routerHealth())
      return
    }
  })
}

function isProtectedJsonRoute(path: string): boolean {
  return path === '/models' ||
    path === '/settings' ||
    path === '/runtime/capabilities' ||
    path === '/runtime/tool-registry' ||
    /^\/runtime\/sessions\/[^/]+\/tool-lock$/u.test(path) ||
    path === '/runtime/restart/status' ||
    path === '/runtime/restart' ||
    path === '/runtime/restart/abort' ||
    path === '/settings/models' ||
    path === '/settings/agent-prompt' ||
    path === '/settings/socket-admin/init' ||
    path === '/settings/socket-admin/mode' ||
    path === '/auth/executor-invites' ||
    path.startsWith('/auth/executor-invites/') ||
    path === '/auth/executor-identities' ||
    path.startsWith('/eval/') ||
    path.startsWith('/enhancement/') ||
    path.startsWith('/artifacts/') ||
    path.startsWith('/docs/') ||
    path.startsWith('/router/')
}

function httpActor(req: IncomingMessage, auth: AuthConfig | undefined): AuditActor {
  if (auth?.github?.required) {
    const session = readGithubSession(req, auth.github)
    if (session) return { kind: 'github_user', login: session.login, ...(session.id !== undefined ? { id: session.id } : {}) }
  }
  if (auth?.sharedToken) return { kind: 'token' }
  return { kind: 'anonymous' }
}

async function runEnhancementAction(
  body: EnhancementActionRequest,
  payloads: {
    artifactRootDir?: string | false
    sessions?: SessionStore
    executorsSnapshot?: () => readonly AttachedExecutor[]
    enqueueUserMessage?: (input: { sessionId: string; text: string }) => Promise<void>
  },
): Promise<unknown> {
  const action = requiredString(body.action, 'action')
  if (action === 'enqueue-user-message') {
    // Reliable queue path used by the dashboard's pagehide beacon: enqueue a
    // follow-up message even when the WebSocket is gone because the browser is
    // closing. Enqueue + drain so it is delivered as soon as the current turn
    // finishes, with no live socket required.
    if (!payloads.enqueueUserMessage) throw new HttpRouteError(503, 'queue is not available')
    const sessionId = requiredString(body.sessionId, 'sessionId')
    const text = requiredString(body.text, 'text')
    await payloads.enqueueUserMessage({ sessionId, text })
    return { action, sessionId, queued: true }
  }
  if (action === 'swebench-grade-command') {
    const maxWorkers = positiveInteger(body.maxWorkers, 'maxWorkers')
    const instanceIds = listInput(body.instanceIds)
    const runId = requiredString(body.runId, 'runId')
    let predictionsPath = cleanString(body.predictionsPath)
    if (!predictionsPath) {
      const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
      if (!rootDir) throw new HttpRouteError(400, 'predictionsPath is required (or configure artifact capture so it can be derived from runId)')
      predictionsPath = sweBenchRunLayout(rootDir, runId).predictionsPath
    }
    const result = await runSweBenchGrade({
      datasetName: requiredString(body.dataset, 'dataset'),
      predictionsPath,
      runId,
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      ...(instanceIds ? { instanceIds } : {}),
      ...(body.modal === true ? { modal: true } : {}),
      ...(cleanString(body.cwd) ? { cwd: cleanString(body.cwd) } : {}),
      execute: false,
    })
    // Hide absolute paths from clients: replace predictionsPath in the emitted
    // command with the plain filename so users don't see any server-side
    // filesystem layout. The command is meant to be run inside the run's
    // artifact directory (or with predictions.jsonl available in $PWD).
    const predictionsFilename = 'predictions.jsonl'
    const sanitizedCommand = result.command.map((token) => (token === predictionsPath ? predictionsFilename : token))
    return {
      action,
      gradingAuthority: 'official-swebench-harness',
      gradingMode: 'dry-run',
      requiresDocker: true,
      command: sanitizedCommand,
      shellCommand: sanitizedCommand.map(shellQuote).join(' '),
    }
  }
  const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
  if (!rootDir) throw new HttpRouteError(400, 'rootDir is required when artifact capture is not configured')
  if (action === 'profile-session') {
    const pricingPath = await resolveInputPath(body, 'pricingPath', 'pricingContent', 'pricing', '.json', rootDir, action)
    const result = await profileSession({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action), ...(pricingPath ? { pricingPath } : {}) })
    return { action, profilePath: result.profilePath, profile: result.profile }
  }
  if (action === 'reliability-audit-session') {
    const result = await auditSessionReliability({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action) })
    return { action, auditPath: result.auditPath, audit: result.audit }
  }
  if (action === 'reliability-chaos-replay') {
    const result = await replayReliabilityChaos({ rootDir, sessionLogPaths: sessionLogPaths(body) })
    return { action, reportPath: result.reportPath, report: result.report }
  }
  if (action === 'reliability-gate') {
    const policy: ReliabilityGatePolicy = {}
    const maxDanglingCount = positiveNumber(body.maxDanglingCount, 'maxDanglingCount')
    const minRecoverableRatio = positiveNumber(body.minRecoverableRatio, 'minRecoverableRatio')
    const maxRecoveryEventCount = positiveNumber(body.maxRecoveryEventCount, 'maxRecoveryEventCount')
    const maxIntegrityIssueCount = positiveNumber(body.maxIntegrityIssueCount, 'maxIntegrityIssueCount')
    if (maxDanglingCount !== undefined) policy.maxDanglingCount = maxDanglingCount
    if (minRecoverableRatio !== undefined) policy.minRecoverableRatio = minRecoverableRatio
    if (maxRecoveryEventCount !== undefined) policy.maxRecoveryEventCount = maxRecoveryEventCount
    if (maxIntegrityIssueCount !== undefined) policy.maxIntegrityIssueCount = maxIntegrityIssueCount
    const rawKindCaps = body.maxDanglingByKind
    if (rawKindCaps && typeof rawKindCaps === 'object' && !Array.isArray(rawKindCaps)) {
      const parsed: Record<string, number> = {}
      for (const [kind, raw] of Object.entries(rawKindCaps as Record<string, unknown>)) {
        const cap = positiveNumber(raw, `maxDanglingByKind.${kind}`)
        if (cap !== undefined) parsed[kind] = cap
      }
      if (Object.keys(parsed).length > 0) policy.maxDanglingByKind = parsed
    }
    const requireStatus = listInput(body.requireStatusIn)
    if (requireStatus && requireStatus.length > 0) policy.requireStatusIn = requireStatus
    const chaosReport = await resolveInputPath(body, 'chaosReportPath', 'chaosReportContent', 'chaosReport', '.json', rootDir, action)
    const logPaths = listInput(body.sessionLogPaths)
    if (!chaosReport && (!logPaths || logPaths.length === 0)) {
      throw new HttpRouteError(400, 'reliability-gate requires chaosReportPath or sessionLogPaths')
    }
    const output = cleanString(body.outputFilename)
    const result = await evaluateReliabilityGate({
      rootDir,
      ...(chaosReport ? { chaosReportPath: chaosReport } : {}),
      ...(logPaths && logPaths.length > 0 ? { sessionLogPaths: logPaths } : {}),
      policy,
      ...(output ? { outputFilename: output } : {}),
    })
    return { action, verdictPath: result.verdictPath, verdict: result.verdict }
  }
  if (action === 'reliability-classify') {
    const wedgedThresholdMs = positiveNumber(body.wedgedThresholdMs, 'wedgedThresholdMs')
    const heartbeatPath = await resolveInputPath(body, 'heartbeatPath', 'heartbeatContent', 'heartbeat', '.jsonl', rootDir, action, { required: true })
    const result = await classifyReliability({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      heartbeatPath: heartbeatPath!,
      ...(wedgedThresholdMs !== undefined ? { wedgedThresholdMs } : {}),
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return { action, reportPath: result.reportPath, report: result.report }
  }
  if (action === 'tool-catalog-diff') {
    const baselinePath = await resolveInputPath(body, 'baselineCatalogPath', 'baselineCatalogContent', 'baselineCatalog', '.json', rootDir, action, { required: true })
    const candidatePath = await resolveInputPath(body, 'candidateCatalogPath', 'candidateCatalogContent', 'candidateCatalog', '.json', rootDir, action, { required: true })
    const result = await diffToolCatalogs({
      rootDir,
      baselinePath: baselinePath!,
      candidatePath: candidatePath!,
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return { action, diffPath: result.diffPath, diff: result.diff }
  }
  if (action === 'executor-capabilities-snapshot') {
    if (!payloads.executorsSnapshot) {
      throw new HttpRouteError(500, 'executor snapshot is not available in this host build')
    }
    const executors = payloads.executorsSnapshot()
    const result = await writeExecutorCapabilitySnapshot({
      rootDir,
      executors,
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return { action, snapshotPath: result.snapshotPath, snapshot: result.snapshot }
  }
  if (action === 'memory-index') {
    const result = await buildMemoryIndex({ rootDir, ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}), ...(body.includeGlobal === true ? { includeGlobal: true } : {}) })
    return { action, indexPath: result.indexPath, entries: result.index.entries.length, warnings: result.index.warnings }
  }
  if (action === 'memory-retrieve') {
    const maxTokens = positiveInteger(body.maxTokens, 'maxTokens')
    const maxHits = positiveInteger(body.maxHits, 'maxHits')
    const result = await retrieveMemory({
      rootDir,
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot)! } : {}),
      ...(body.includeGlobal === true ? { includeGlobal: true } : {}),
      query: requiredString(body.query, 'query'),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(maxHits === undefined ? {} : { maxHits }),
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
    })
    return {
      action,
      artifactPath: result.artifactPath,
      hitCount: result.artifact.hitCount,
      budget: result.artifact.budget,
      reasonCodes: result.artifact.reasonCodes,
      hits: result.artifact.hits,
    }
  }
  if (action === 'subagents-graph') {
    const result = await exportSubAgentGraph({ rootDir, sessionsDir: cleanString(body.sessionsDir) ?? payloads.sessions?.dir ?? requiredString(body.sessionsDir, 'sessionsDir') })
    return { action, graphPath: result.graphPath, nodes: result.graph.nodes.length, edges: result.graph.edges.length, warnings: result.graph.warnings }
  }
  if (action === 'trace-export-session') {
    const result = await exportSessionTraceArtifacts({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action), ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}), ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, sessionId: result.sessionId, traceArtifact: result.traceArtifact, llmArtifacts: result.llmArtifacts }
  }
  if (action === 'rollout-export-segments') {
    const result = await exportRolloutSegments({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action), ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}), ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, sessionId: result.sessionId, artifact: result.artifact, segmentCount: result.segments.segments.length }
  }
  if (action === 'rollout-export-session') {
    const rewardPath = await resolveInputPath(body, 'rewardPath', 'rewardContent', 'reward', '.json', rootDir, action)
    const tokenSegmentsPath = await resolveInputPath(body, 'tokenSegmentsPath', 'tokenSegmentsContent', 'tokenSegments', '.json', rootDir, action)
    const result = await exportRolloutSidecar({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      taskId: requiredString(body.taskId, 'taskId'),
      frameworkTarget: frameworkTarget(requiredString(body.frameworkTarget ?? body.framework, 'frameworkTarget')),
      ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}),
      ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(cleanString(body.weightVersion) ? { weightVersion: cleanString(body.weightVersion) } : {}),
      ...(rewardPath ? { rewardPath } : {}),
      ...(tokenSegmentsPath ? { tokenSegmentsPath } : {}),
    })
    return { action, rolloutId: result.sidecar.rollout_id, sidecarPath: result.sidecarPath, traceArtifact: result.traceArtifact }
  }
  if (action === 'rollout-export-adapter') {
    const framework = cleanString(body.frameworkTarget ?? body.framework)
    const sidecarPath = await resolveInputPath(body, 'sidecarPath', 'sidecarContent', 'sidecar', '.json', rootDir, action, { required: true })
    const result = await exportRolloutFrameworkAdapter({ rootDir, sidecarPath: sidecarPath!, ...(framework ? { frameworkTarget: frameworkTarget(framework) } : {}) })
    return { action, adapterPath: result.adapterPath, status: result.adapter.status, frameworkTarget: result.adapter.frameworkTarget }
  }
  if (action === 'rollout-verify-reward') {
    const trialPath = await resolveInputPath(body, 'trialPath', 'trialContent', 'trial', '.json', rootDir, action)
    const scorePath = await resolveInputPath(body, 'scorePath', 'scoreContent', 'score', '.json', rootDir, action)
    if (!trialPath && !scorePath) throw new HttpRouteError(400, 'missing required trialPath or scorePath')
    const result = await verifyReward({
      rootDir,
      ...(trialPath ? { trialPath } : {}),
      ...(scorePath ? { scorePath } : {}),
      ...(cleanString(body.taskId) ? { taskId: cleanString(body.taskId)! } : {}),
      ...(cleanString(body.sessionId) ? { sessionId: cleanString(body.sessionId)! } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot)! } : {}),
    })
    return {
      action,
      artifact: result.artifact,
      taskId: result.reward.taskId,
      reward: result.reward.reward,
      resolved: result.reward.resolved,
      shapedLabels: result.reward.shapedLabels,
      reasonCodes: result.reward.reasonCodes,
    }
  }
  if (action === 'eval-score-session') {
    const patchPath = await resolveInputPath(body, 'patchPath', 'patchContent', 'patch', '.diff', rootDir, action)
    const result = await scoreSession({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action), ...(cleanString(body.instanceId) ? { instanceId: cleanString(body.instanceId) } : {}), ...(patchPath ? { patchPath } : {}), ...(body.requireDone === true ? { requireDone: true } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, scoresPath: result.scoresPath, summary: result.summary }
  }
  if (action === 'eval-judge-score') {
    const threshold = positiveNumber(body.threshold, 'threshold')
    const promptPath = await resolveInputPath(body, 'promptPath', 'promptContent', 'prompt', '.txt', rootDir, action, { required: true })
    const responsePath = await resolveInputPath(body, 'responsePath', 'responseContent', 'response', '.txt', rootDir, action, { required: true })
    const result = await judgeScore({
      rootDir,
      promptPath: promptPath!,
      responsePath: responsePath!,
      judgeModel: requiredString(body.judgeModel, 'judgeModel'),
      ...(cleanString(body.scorer) ? { scorer: cleanString(body.scorer) } : {}),
      ...(cleanString(body.instanceId) ? { instanceId: cleanString(body.instanceId) } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(cleanString(body.inputRef) ? { inputRef: cleanString(body.inputRef) } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
    })
    return { action, scoresPath: result.scoresPath, judgeTrace: result.judgeTrace, summary: result.summary }
  }
  if (action === 'eval-compare-runs') {
    const baselineSummaryPath = await resolveInputPath(body, 'baselineSummaryPath', 'baselineSummaryContent', 'baselineSummary', '.json', rootDir, action, { required: true })
    const candidateSummaryPath = await resolveInputPath(body, 'candidateSummaryPath', 'candidateSummaryContent', 'candidateSummary', '.json', rootDir, action, { required: true })
    const result = await compareEvalRuns({ rootDir, baselineSummaryPath: baselineSummaryPath!, candidateSummaryPath: candidateSummaryPath! })
    return { action, comparisonPath: result.comparisonPath, comparison: result.comparison }
  }
  if (action === 'eval-regression-gate') {
    const policy: RegressionThresholdPolicy = {}
    const minPassRate = positiveNumber(body.minPassRate, 'minPassRate')
    const maxPassRateDrop = positiveNumber(body.maxPassRateDrop, 'maxPassRateDrop')
    const maxFailedIncrease = positiveNumber(body.maxFailedIncrease, 'maxFailedIncrease')
    const maxTimeoutIncrease = positiveNumber(body.maxTimeoutIncrease, 'maxTimeoutIncrease')
    const maxResolvedDrop = positiveNumber(body.maxResolvedDrop, 'maxResolvedDrop')
    if (minPassRate !== undefined) policy.minPassRate = minPassRate
    if (maxPassRateDrop !== undefined) policy.maxPassRateDrop = maxPassRateDrop
    if (maxFailedIncrease !== undefined) policy.maxFailedIncrease = maxFailedIncrease
    if (maxTimeoutIncrease !== undefined) policy.maxTimeoutIncrease = maxTimeoutIncrease
    if (maxResolvedDrop !== undefined) policy.maxResolvedDrop = maxResolvedDrop
    const rawCaps = body.failureLabelCaps
    if (rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps)) {
      const parsed: Record<string, number> = {}
      for (const [label, raw] of Object.entries(rawCaps as Record<string, unknown>)) {
        const cap = positiveNumber(raw, `failureLabelCaps.${label}`)
        if (cap !== undefined) parsed[label] = cap
      }
      if (Object.keys(parsed).length > 0) policy.failureLabelCaps = parsed
    }
    const baselineSummaryPath = await resolveInputPath(body, 'baselineSummaryPath', 'baselineSummaryContent', 'baselineSummary', '.json', rootDir, action, { required: true })
    const candidateSummaryPath = await resolveInputPath(body, 'candidateSummaryPath', 'candidateSummaryContent', 'candidateSummary', '.json', rootDir, action, { required: true })
    const result = await evaluateRegressionGate({
      rootDir,
      baselineSummaryPath: baselineSummaryPath!,
      candidateSummaryPath: candidateSummaryPath!,
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename)! } : {}),
      policy,
    })
    return { action, verdictPath: result.verdictPath, verdict: result.verdict }
  }
  if (action === 'profile-aggregate') {
    const summaryPath = await resolveInputPath(body, 'summaryPath', 'summaryContent', 'summary', '.json', rootDir, action)
    const output = cleanString(body.outputFilename)
    const result = await aggregateProfiles({
      rootDir,
      ...(summaryPath ? { summaryPath } : {}),
      ...(output ? { outputFilename: output } : {}),
    })
    return { action, reportPath: result.reportPath, report: result.report }
  }
  if (action === 'profile-budget') {
    const policy: ProfileBudgetPolicy = {}
    for (const key of [
      'maxEstimatedCostUsd',
      'maxInputTokens',
      'maxOutputTokens',
      'maxTotalTokens',
      'maxLlmCalls',
      'maxToolCalls',
      'maxToolErrors',
      'maxWallTimeMs',
      'maxAverageLlmDurationMs',
      'maxP95LlmDurationMs',
      'maxAverageTimeToFirstChunkMs',
      'maxP95TimeToFirstChunkMs',
      'maxMissingUsageCalls',
      'maxLlmTraceMissingCalls',
    ] as const) {
      const value = positiveNumber(body[key], key)
      if (value !== undefined) policy[key] = value
    }
    if (body.requireCostEstimated === true || body.requireCostEstimated === 'true') {
      policy.requireCostEstimated = true
    }
    const output = cleanString(body.outputFilename)
    const profilePath = await resolveInputPath(body, 'profilePath', 'profileContent', 'profile', '.json', rootDir, action, { required: true })
    const result = await evaluateProfileBudget({
      rootDir,
      profilePath: profilePath!,
      policy,
      ...(output ? { outputFilename: output } : {}),
    })
    return { action, verdictPath: result.verdictPath, verdict: result.verdict }
  }
  if (action === 'swebench-infer-patches') {
    const instanceIds = listInput(body.instanceIds)
    const limit = positiveInteger(body.limit, 'limit')
    const runId = requiredString(body.runId, 'runId')
    const layout = sweBenchRunLayout(rootDir, runId)
    const instancesJsonl = cleanString(body.instancesJsonl) ?? layout.instancesPath
    const patchesDir = cleanString(body.patchesDir) ?? layout.patchesDir
    const result = await inferSweBenchPatchRun({
      rootDir,
      runId,
      dataset: requiredString(body.dataset, 'dataset'),
      ...(cleanString(body.split) ? { split: cleanString(body.split) } : {}),
      model: requiredString(body.model, 'model'),
      instancesJsonl,
      patchesDir,
      ...(instanceIds ? { instanceIds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
    })
    return {
      action,
      runId: result.layout.runId,
      predictionsPath: result.layout.predictionsPath,
      experimentPath: result.layout.experimentPath,
      summaryPath: result.layout.summaryPath,
      trialCount: result.trials.length,
      gradingAuthority: 'official-swebench-harness',
      gradingStatus: 'not_graded',
    }
  }
  if (action === 'swebench-run-agent-infer') {
    const runId = requiredString(body.runId, 'runId')
    const layout = sweBenchRunLayout(rootDir, runId)
    const instanceIds = listInput(body.instanceIds)
    const limit = positiveInteger(body.limit, 'limit')
    const maxWorkers = positiveInteger(body.maxWorkers, 'maxWorkers')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    const skipCompletedFlag = body.skipCompleted
    const skipCompleted = typeof skipCompletedFlag === 'boolean' ? skipCompletedFlag : true
    const started = Date.now()
    const model = requiredString(body.model, 'model')
    const backendId = AgentBackendIdSchema.parse(cleanString(body.agentBackend) ?? (cleanString(body.agentCommand) ? 'custom-command' : 'agent-runlab'))
    const backend = getAgentBackend(backendId)
    const backendConfig = {
      id: backendId,
      model,
      config: {
        ...(body.agentBackendConfig ?? {}),
        ...(cleanString(body.agentCommand) ? { command: cleanString(body.agentCommand) } : {}),
      },
    }
    const validation = backend.validate(backendConfig)
    if (!backend.descriptor.available) throw new HttpRouteError(400, backend.descriptor.unavailableReason ?? `${backendId} backend is unavailable`)
    if (!validation.ok) throw new HttpRouteError(400, validation.errors.join('; '))
    const result = await runSweBenchAgentPatchRun({
      rootDir,
      runId,
      dataset: requiredString(body.dataset, 'dataset'),
      ...(cleanString(body.split) ? { split: cleanString(body.split) } : {}),
      model,
      instancesJsonl: cleanString(body.instancesJsonl) ?? layout.instancesPath,
      agentCommand: backend.command(backendConfig),
      ...(instanceIds ? { instanceIds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      skipCompleted,
    })
    const trials = result.trials
    let passed = 0
    let failed = 0
    let errored = 0
    for (const trial of trials) {
      if (trial.status === 'completed') passed += 1
      else if (trial.status === 'failed') failed += 1
      else errored += 1
    }
    return {
      action,
      runId: result.layout.runId,
      totalInstances: trials.length,
      completed: trials.length,
      passed,
      failed,
      errored,
      durationMs: Date.now() - started,
      predictionsPath: result.layout.predictionsPath,
      progressPath: result.layout.progressPath,
      summaryPath: result.layout.summaryPath,
      gradingAuthority: 'official-swebench-harness',
      gradingStatus: 'not_graded',
    }
  }
  if (action === 'swebench-read-progress') {
    const runId = requiredString(body.runId, 'runId')
    const layout = sweBenchRunLayout(rootDir, runId)
    let raw: string
    try {
      raw = await readFile(layout.progressPath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return { action, runId, status: 'not_started', total: 0, completed: 0, running: 0, failed: 0 }
      throw err
    }
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { parsed = {} }
    const status = typeof parsed.status === 'string' ? parsed.status : 'running'
    const total = typeof parsed.selectedCount === 'number' ? parsed.selectedCount : 0
    const completedCount = typeof parsed.completedCount === 'number' ? parsed.completedCount : 0
    const failedCount = typeof parsed.failedCount === 'number' ? parsed.failedCount : 0
    const runningCount = typeof parsed.runningCount === 'number' ? parsed.runningCount : 0
    const skippedCount = typeof parsed.skippedCount === 'number' ? parsed.skippedCount : 0
    const timedOutCount = typeof parsed.timedOutCount === 'number' ? parsed.timedOutCount : 0
    const instances = Array.isArray(parsed.instances) ? parsed.instances as Array<Record<string, unknown>> : []
    const currentInstance = instances.find((entry) => entry?.status === 'running')?.instanceId
    return {
      action,
      runId,
      status,
      total,
      completed: completedCount,
      failed: failedCount + timedOutCount,
      running: runningCount,
      skipped: skippedCount,
      ...(typeof currentInstance === 'string' ? { currentInstance } : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  }
  if (action === 'swebench-export-session') {
    let modelPatch: string
    const explicitModelPatchPath = cleanString(body.modelPatchPath ?? body.patchPath)
    if (explicitModelPatchPath) {
      modelPatch = await readFile(explicitModelPatchPath, 'utf8')
    } else if (typeof body.modelPatchContent === 'string' && body.modelPatchContent.length > 0) {
      modelPatch = body.modelPatchContent
    } else if (typeof body.patchContent === 'string' && body.patchContent.length > 0) {
      modelPatch = body.patchContent
    } else {
      throw new HttpRouteError(400, 'modelPatchPath is required (or provide modelPatchContent)')
    }
    const result = await exportSessionForSweBench({
      rootDir,
      runId: requiredString(body.runId, 'runId'),
      dataset: requiredString(body.dataset, 'dataset'),
      ...(cleanString(body.split) ? { split: cleanString(body.split) } : {}),
      model: requiredString(body.model, 'model'),
      instanceId: requiredString(body.instanceId, 'instanceId'),
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      modelPatch,
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
    })
    return { action, runId: result.layout.runId, predictionsPath: result.layout.predictionsPath, experimentPath: result.layout.experimentPath, traceArtifact: result.traceArtifact }
  }
  if (action === 'swebench-ingest-results') {
    const runId = requiredString(body.runId, 'runId')
    const layout = sweBenchRunLayout(rootDir, runId)
    const resultsDir = cleanString(body.resultsDir) ?? layout.gradeResultsDir
    const result = await ingestSweBenchResults({ rootDir, runId, resultsDir })
    return {
      action,
      runId: result.layout.runId,
      resultsPath: result.resultsPath,
      summaryPath: result.summaryPath,
      trialCount: result.trials.length,
      resolved: result.trials.filter((trial) => trial.resolved).length,
      gradingAuthority: 'official-swebench-harness',
      gradingStatus: 'ingested',
    }
  }
  if (action === 'swebench-resolve-instances') {
    const source = requiredString(body.source, 'source')
    const runId = requiredString(body.runId, 'runId')
    let instancesSource: InstancesSource
    if (source === 'inline') {
      const content = requiredString(body.inlineContent, 'inlineContent')
      instancesSource = { kind: 'inline', content }
    } else if (source === 'huggingface') {
      const datasetLimit = positiveInteger(body.datasetLimit, 'datasetLimit')
      instancesSource = {
        kind: 'huggingface',
        datasetRef: requiredString(body.datasetRef, 'datasetRef'),
        ...(cleanString(body.configName) ? { config: cleanString(body.configName) } : {}),
        ...(cleanString(body.datasetSplit) ? { split: cleanString(body.datasetSplit) } : {}),
        ...(datasetLimit !== undefined ? { limit: datasetLimit } : {}),
        ...(cleanString(body.hfToken) ? { hfToken: cleanString(body.hfToken) } : {}),
      }
    } else {
      throw new HttpRouteError(400, `unsupported instances source: ${source}`)
    }
    try {
      const result = await resolveSweBenchInstances({
        rootDir,
        runId,
        source: instancesSource,
        ...(cleanString(body.hfDatasetsServerBaseUrl)
          ? { huggingFaceOverrides: { baseUrl: cleanString(body.hfDatasetsServerBaseUrl)! } }
          : {}),
      })
      return {
        action,
        instancesJsonlPath: result.instancesJsonlPath,
        rowCount: result.rowCount,
        bytes: result.bytes,
        source: result.source,
      }
    } catch (err) {
      if (err instanceof InstancesSourceError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  if (action === 'swebench-upload-patches') {
    const runId = requiredString(body.runId, 'runId')
    const patches = body.patches
    if (!patches || typeof patches !== 'object' || Array.isArray(patches)) {
      throw new HttpRouteError(400, 'patches is required (object of instanceId → diff content)')
    }
    try {
      const result = await resolveSweBenchPatches({
        rootDir,
        runId,
        source: { kind: 'inline', patches: patches as Record<string, string> },
      })
      return {
        action,
        patchesDir: result.patchesDir,
        instanceCount: result.instanceCount,
        bytes: result.bytes,
      }
    } catch (err) {
      if (err instanceof PatchesSourceError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  if (action === 'swebench-upload-results') {
    const runId = requiredString(body.runId, 'runId')
    const files = body.resultsFiles
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      throw new HttpRouteError(400, 'resultsFiles is required (object of fileName → content)')
    }
    try {
      const result = await resolveSweBenchResults({
        rootDir,
        runId,
        source: { kind: 'inline', files: files as Record<string, string> },
      })
      return {
        action,
        resultsDir: result.resultsDir,
        fileCount: result.fileCount,
        bytes: result.bytes,
      }
    } catch (err) {
      if (err instanceof ResultsSourceError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  if (action === 'terminal-bench-resolve-tasks') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured to resolve tasks')
    const inline = cleanString(body.tasksContent)
    const path = cleanString(body.tasksJsonl)
    if (!inline && !path) throw new HttpRouteError(400, 'tasksContent or tasksJsonl is required')
    const taskIds = listInput(body.taskIds)
    const limit = positiveInteger(body.limit, 'limit')
    const tasks = await resolveTerminalBenchTasks({
      ...(inline ? { inlineContent: inline } : {}),
      ...(path ? { tasksJsonlPath: path } : {}),
      ...(taskIds ? { taskIds } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
    const layout = terminalBenchRunLayout(rootDir, runId)
    await mkdir(layout.rootDir, { recursive: true })
    await writeFile(layout.tasksJsonl, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8')
    // Response intentionally omits filesystem paths (see docs/meta/principles.md A1).
    return { action, runId, taskCount: tasks.length }
  }
  if (action === 'terminal-bench-run-agent') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured to run terminal-bench')
    const layout = terminalBenchRunLayout(rootDir, runId)
    const maxWorkers = positiveInteger(body.maxWorkers, 'maxWorkers')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    const started = Date.now()
    const result = await runTerminalBenchRun({
      rootDir,
      runId,
      agentCommand: cleanString(body.agentCommand) ?? 'true',
      tasksJsonl: cleanString(body.tasksJsonl) ?? layout.tasksJsonl,
      ...(cleanString(body.dataset) ? { dataset: cleanString(body.dataset) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    return {
      action,
      runId,
      total: result.summary.total,
      resolved: result.summary.resolved,
      unresolved: result.summary.unresolved,
      errored: result.summary.errored,
      accuracy: result.summary.accuracy,
      durationMs: Date.now() - started,
    }
  }
  if (action === 'terminal-bench-read-progress') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const layout = terminalBenchRunLayout(rootDir, runId)
    let raw: string
    try {
      raw = await readFile(layout.progressPath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return { action, runId, status: 'not_started', total: 0, completed: 0 }
      throw err
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      action,
      runId,
      status: typeof parsed.status === 'string' ? parsed.status : 'running',
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      completed: typeof parsed.completed === 'number' ? parsed.completed : 0,
      resolved: typeof parsed.resolved === 'number' ? parsed.resolved : 0,
      unresolved: typeof parsed.unresolved === 'number' ? parsed.unresolved : 0,
      errored: typeof parsed.errored === 'number' ? parsed.errored : 0,
      ...(typeof parsed.currentTask === 'string' ? { currentTask: parsed.currentTask } : {}),
      lastUpdatedAt: typeof parsed.lastUpdatedAt === 'string' ? parsed.lastUpdatedAt : null,
    }
  }
  if (action === 'terminal-bench-import-results') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const summary = await importTerminalBenchResults({ rootDir, runId })
    return {
      action,
      runId,
      total: summary.total,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      errored: summary.errored,
      accuracy: summary.accuracy,
    }
  }
  if (action === 'terminal-bench-2_1-run') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured to run terminal-bench 2.1')
    const datasetDir = requiredString(body.tasksDir, 'tasksDir')
    const taskIds = listInput(body.taskIds)
    const limit = positiveInteger(body.limit, 'limit')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    const started = Date.now()
    const { summary } = await runTerminalBench21Run({
      rootDir,
      runId,
      datasetDir,
      agent: cleanString(body.agentCommand) === 'none' ? 'none' : 'solution',
      ...(taskIds ? { taskIds } : {}),
      ...(cleanString(body.dataset) ? { dataset: cleanString(body.dataset) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    return {
      action,
      runId,
      total: summary.total,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      errored: summary.errored,
      accuracy: summary.accuracy,
      durationMs: Date.now() - started,
    }
  }
  if (action === 'program-bench-run-agent') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured to run program-bench')
    const layout = programBenchRunLayout(rootDir, runId)
    const limit = positiveInteger(body.limit, 'limit')
    const maxWorkers = positiveInteger(body.maxWorkers, 'maxWorkers')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    const started = Date.now()
    const result = await runProgramBenchRun({
      rootDir,
      runId,
      tasksJsonl: cleanString(body.tasksJsonl) ?? layout.tasksJsonl,
      ...(cleanString(body.tasksContent) ? { inlineTasksContent: cleanString(body.tasksContent) } : {}),
      ...(cleanString(body.agentCommand) ? { agentCommand: cleanString(body.agentCommand) } : {}),
      ...(cleanString(body.dataset) ? { dataset: cleanString(body.dataset) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    return {
      action,
      runId,
      total: result.summary.total,
      resolved: result.summary.resolved,
      unresolved: result.summary.unresolved,
      errored: result.summary.errored,
      accuracy: result.summary.accuracy,
      durationMs: Date.now() - started,
    }
  }
  if (action === 'program-bench-import-results') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const summary = await importProgramBenchResults({ rootDir, runId })
    return {
      action,
      runId,
      total: summary.total,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      errored: summary.errored,
      accuracy: summary.accuracy,
    }
  }
  if (action === 'swe-marathon-run-agent') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured to run swe-marathon')
    const tasksDir = requiredString(body.tasksDir, 'tasksDir')
    const taskIds = listInput(body.taskIds)
    const limit = positiveInteger(body.limit, 'limit')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    const started = Date.now()
    const result = await runSweMarathonRun({
      rootDir,
      runId,
      tasksDir,
      ...(taskIds ? { taskIds } : {}),
      ...(cleanString(body.dataset) ? { dataset: cleanString(body.dataset) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    return {
      action,
      runId,
      total: result.summary.total,
      resolved: result.summary.resolved,
      unresolved: result.summary.unresolved,
      errored: result.summary.errored,
      accuracy: result.summary.accuracy,
      durationMs: Date.now() - started,
    }
  }
  if (action === 'swe-marathon-import-results') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const summary = await importSweMarathonResults({ rootDir, runId })
    return {
      action,
      runId,
      total: summary.total,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      errored: summary.errored,
      accuracy: summary.accuracy,
    }
  }
  if (action === 'badcase-list') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (runId.startsWith('legacy:')) {
      if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
      const name = runId.slice('legacy:'.length)
      const imported = JSON.parse(await readFile(join(rootDir, 'legacy-imports', name, 'import.json'), 'utf8')) as {
        failureTaxonomy?: { cases?: Record<string, { category?: string; label?: string; cause?: string; failedTests?: string[]; evidence?: string; lesson?: string }> }
      }
      const rows = Object.entries(imported.failureTaxonomy?.cases ?? {}).map(([instanceId, item]) => ({
        instanceId,
        failureCategory: item.category === 'regression' ? 'verifier-failure' : 'unresolved-other',
        traceHead: item.label ? [item.label] : [],
        traceTail: item.lesson ? [item.lesson] : [],
        toolCallErrors: [],
        verifierReason: [item.cause, item.evidence, ...(item.failedTests ?? [])].filter(Boolean).join('\n'),
      }))
      return { action, runId, counts: { 'patch-apply-failure': 0, 'test-timeout': 0, 'agent-error': 0, 'infra-error': 0, 'verifier-failure': rows.filter((row) => row.failureCategory === 'verifier-failure').length, 'unresolved-other': rows.filter((row) => row.failureCategory === 'unresolved-other').length }, cases: rows }
    }
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const [{ cases, counts }, annotations] = await Promise.all([
      mineBadCases({ rootDir, runId }),
      readBadCaseAnnotations(rootDir, runId),
    ])
    // Response intentionally omits filesystem paths (see docs/meta/principles.md A1).
    return {
      action,
      runId,
      counts,
      cases: cases.map((c) => ({
        instanceId: c.instanceId,
        failureCategory: c.failureCategory,
        traceHead: c.traceHead,
        traceTail: c.traceTail,
        toolCallErrors: c.toolCallErrors,
        ...(c.verifierReason ? { verifierReason: c.verifierReason } : {}),
        ...(c.minimalRepro ? { minimalRepro: c.minimalRepro } : {}),
        ...(annotations.get(c.instanceId) ? {
          annotation: {
            label: annotations.get(c.instanceId)!.label,
            ...(annotations.get(c.instanceId)!.note ? { note: annotations.get(c.instanceId)!.note } : {}),
            updatedAt: annotations.get(c.instanceId)!.updatedAt,
          },
        } : {}),
      })),
    }
  }
  if (action === 'badcase-annotate') {
    const runId = requiredString(body.runId, 'runId')
    const instanceId = requiredString(body.instanceId, 'instanceId')
    const rawLabel = requiredString(body.label, 'label')
    if (!BAD_CASE_LABELS.includes(rawLabel as BadCaseLabel)) {
      throw new HttpRouteError(400, `unknown label: ${rawLabel}`)
    }
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const annotation = await annotateBadCase({
      rootDir,
      runId,
      instanceId,
      label: rawLabel as BadCaseLabel,
      ...(cleanString(body.note) ? { note: cleanString(body.note) } : {}),
    })
    return { action, runId, instanceId, label: annotation.label, updatedAt: annotation.updatedAt }
  }
  if (action === 'badcase-export') {
    const runId = requiredString(body.runId, 'runId')
    const rawFormat = requiredString(body.format, 'format')
    if (rawFormat !== 'sft' && rawFormat !== 'rl') {
      throw new HttpRouteError(400, `unsupported format: ${rawFormat}`)
    }
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const wanted = listInput(body.instanceIds)
    const { cases } = await mineBadCases({ rootDir, runId })
    const selected = wanted && wanted.length > 0
      ? cases.filter((c) => wanted.includes(c.instanceId))
      : cases
    const content = rawFormat === 'sft' ? exportForSFT(selected) : exportForRL(selected)
    // Content string is returned inline; the browser wraps it in a Blob and
    // downloads. No absolute path leaks into the response envelope.
    return { action, runId, format: rawFormat, count: selected.length, content }
  }
  if (action === 'rollout-export') {
    const runId = requiredString(body.runId, 'runId')
    const rawTarget = requiredString(body.target, 'target')
    if (rawTarget !== 'verl' && rawTarget !== 'slime') {
      throw new HttpRouteError(400, `unsupported target: ${rawTarget}`)
    }
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const includeStatuses = listInput(body.includeStatuses)
    const { content, rolloutCount } = await exportRollouts({
      rootDir,
      runId,
      target: rawTarget,
      ...(includeStatuses ? { includeStatuses } : {}),
    })
    // No paths in the response — the browser wraps `content` in a Blob.
    return { action, target: rawTarget, rolloutCount, content }
  }
  if (action === 'agent-backend-list') {
    return { action, backends: listAgentBackends() }
  }
  if (action === 'benchmark-run-create') {
    const service = benchmarkRunService(rootDir)
    return { action, run: await service.create(body.spec) }
  }
  if (action === 'benchmark-run-list') {
    const service = benchmarkRunService(rootDir)
    return { action, runs: await service.list() }
  }
  if (action === 'benchmark-run-get') {
    const service = benchmarkRunService(rootDir)
    return { action, run: await service.get(requiredString(body.runId, 'runId')) }
  }
  if (action === 'benchmark-run-start') {
    const service = benchmarkRunService(rootDir)
    return { action, run: await service.start(requiredString(body.runId, 'runId')) }
  }
  if (action === 'benchmark-run-grade') {
    const service = benchmarkRunService(rootDir)
    return { action, run: await service.grade(requiredString(body.runId, 'runId'), body.dryRun !== true) }
  }
  if (action === 'benchmark-run-cancel') {
    const service = benchmarkRunService(rootDir)
    return { action, run: await service.cancel(requiredString(body.runId, 'runId')) }
  }
  if (action === 'benchmark-run-events') {
    const service = benchmarkRunService(rootDir)
    return { action, ...(await service.events(requiredString(body.runId, 'runId'), nonNegativeInteger(body.after, 'after') ?? -1, positiveInteger(body.limit, 'limit') ?? 100)) }
  }
  if (action === 'legacy-swebench-import') {
    const sourceDir = requiredString(body.sourceDir, 'sourceDir')
    const result = await importLegacySweBench({
      sourceDir,
      outputRoot: rootDir,
      ...(cleanString(body.importId) ? { importId: cleanString(body.importId) } : {}),
    })
    const headline = result.imported.headline as { agent_runlab?: { resolved?: number; selected?: number }; claude_code?: { resolved?: number; selected?: number } }
    const taxonomy = result.imported.failureTaxonomy as { cases?: Record<string, unknown> }
    return {
      action,
      importPath: result.path,
      source: result.imported.source,
      agentRunLab: headline.agent_runlab,
      claudeCode: headline.claude_code,
      badCaseCount: Object.keys(taxonomy.cases ?? {}).length,
    }
  }
  if (action === 'run-registry-list') {
    const kindFilter = cleanString(body.kind)
    const registry = await readSweBenchRunRegistry(rootDir)
    const entries = registry.entries.filter((entry) => {
      if (!kindFilter) return true
      const entryKind = entry.kind ?? 'swebench'
      return entryKind === kindFilter
    })
    const runs = await Promise.all(entries.map(async (entry) => {
      // Best-effort enrich: read summary.json for resolved/total, or progress.json
      // for status. Paths intentionally NOT surfaced in the response (principle A1).
      let status: 'running' | 'complete' | 'failed' | 'pending' = 'pending'
      let totalInstances: number | undefined
      let resolved: number | undefined
      try {
        const summaryText = await readFile(join(entry.runDir, 'summary.json'), 'utf8')
        const summary = JSON.parse(summaryText) as { total?: number; resolved?: number }
        if (typeof summary.total === 'number') totalInstances = summary.total
        if (typeof summary.resolved === 'number') resolved = summary.resolved
        status = 'complete'
      } catch {
        try {
          const progressText = await readFile(join(entry.runDir, 'progress.json'), 'utf8')
          const progress = JSON.parse(progressText) as { status?: string; total?: number }
          if (progress.status === 'error' || progress.status === 'failed') status = 'failed'
          else if (progress.status === 'complete' || progress.status === 'done') status = 'complete'
          else status = 'running'
          if (typeof progress.total === 'number') totalInstances = progress.total
        } catch {
          // Neither summary nor progress present — leave as pending.
        }
      }
      const kind = entry.kind ?? 'swebench'
      return {
        runId: entry.runId,
        kind,
        label: entry.runId,
        dataset: entry.dataset,
        ...(entry.split ? { split: entry.split } : {}),
        model: entry.model,
        selectedCount: entry.selectedCount,
        status,
        createdAt: entry.registeredAt,
        updatedAt: entry.updatedAt,
        ...(totalInstances !== undefined ? { totalInstances } : {}),
        ...(resolved !== undefined ? { resolved } : {}),
      }
    }))
    const unified: Array<Record<string, unknown> & { runId: string; updatedAt: string }> = [...runs]
    for (const record of await benchmarkRunService(rootDir).list()) {
      const totalInstances = Math.max(0, ...record.status.backends.map((backend) => backend.total ?? 0))
      const allTrialsFailed = totalInstances > 0 && record.status.backends.every((backend) => (backend.completed ?? 0) === 0 && (backend.failed ?? 0) + (backend.timedOut ?? 0) >= (backend.total ?? 0))
      const officiallyGraded = record.status.backends.length > 0 && record.status.backends.every((backend) => backend.state === 'completed' && backend.gradingCommand && typeof backend.resolved === 'number')
      unified.push({
        runId: record.spec.runId,
        kind: record.spec.benchmark,
        label: record.spec.runId,
        dataset: record.spec.dataset.source,
        ...(record.spec.dataset.split ? { split: record.spec.dataset.split } : {}),
        model: record.spec.backends.map((backend) => `${backend.id}:${backend.model || 'none'}`).join(', '),
        selectedCount: record.spec.dataset.instanceIds?.length ?? record.spec.dataset.limit ?? totalInstances,
        status: record.status.state === 'failed' || allTrialsFailed ? 'failed' : record.status.state === 'completed' ? 'complete' : record.status.state === 'running' ? 'running' : 'pending',
        createdAt: record.status.createdAt,
        updatedAt: record.status.updatedAt,
        evidenceLevel: record.spec.backends.some((backend) => backend.id === 'smoke') ? 'smoke' : officiallyGraded ? 'official' : 'predictions_only',
        orchestrated: true,
        backends: record.status.backends,
        totalInstances,
        ...(record.status.state === 'completed' ? { resolved: Math.max(0, ...record.status.backends.map((backend) => backend.resolved ?? 0)) } : {}),
      })
    }
    try {
      for (const name of await readdir(join(rootDir, 'legacy-imports'))) {
        try {
          const imported = JSON.parse(await readFile(join(rootDir, 'legacy-imports', name, 'import.json'), 'utf8')) as {
            importedAt: string
            headline?: { agent_runlab?: { run_id?: string; selected?: number; resolved?: number }; claude_code?: { resolved?: number } }
            failureTaxonomy?: { cases?: Record<string, unknown> }
          }
          const agent = imported.headline?.agent_runlab
          if (!agent?.run_id) continue
          unified.push({
            runId: `legacy:${name}`,
            kind: 'swebench',
            label: `Historical SWE-bench: ${name}`,
            dataset: 'princeton-nlp/SWE-bench_Lite',
            model: 'multiple historical backends/models',
            selectedCount: agent.selected ?? 0,
            status: 'complete',
            createdAt: imported.importedAt,
            updatedAt: imported.importedAt,
            totalInstances: agent.selected,
            resolved: agent.resolved,
            evidenceLevel: 'legacy_official',
            legacy: true,
            badCaseCount: Object.keys(imported.failureTaxonomy?.cases ?? {}).length,
            comparison: { agentRunLabResolved: agent.resolved, claudeCodeResolved: imported.headline?.claude_code?.resolved },
          })
        } catch { /* ignore malformed imports */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const deduped = [...new Map(unified.map((run) => [run.runId, run])).values()]
    deduped.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return { action, runs: deduped }
  }
  if (action === 'benchmark-run-delete-impact' || action === 'benchmark-run-delete') {
    const runId = requiredString(body.runId, 'runId')
    if (!rootDir) throw new HttpRouteError(400, 'artifact capture must be configured')
    const targets: string[] = []
    const orchestratedDir = join(rootDir, 'benchmark-runs', runId)
    if (existsSync(orchestratedDir)) targets.push(orchestratedDir)
    if (runId.startsWith('legacy:')) {
      const importDir = join(rootDir, 'legacy-imports', runId.slice('legacy:'.length))
      if (existsSync(importDir)) targets.push(importDir)
    } else {
      const registry = await readSweBenchRunRegistry(rootDir)
      const entry = registry.entries.find((candidate) => candidate.runId === runId)
      if (entry && isPathInside(rootDir, entry.runDir) && existsSync(entry.runDir)) targets.push(entry.runDir)
    }
    const uniqueTargets = [...new Set(targets.map((target) => resolvePath(target)))]
    let files = 0
    let bytes = 0
    for (const target of uniqueTargets) { const impact = await deletionDirectoryImpact(target); files += impact.files; bytes += impact.bytes }
    if (action === 'benchmark-run-delete-impact') return { action, runId, files, bytes, targets: uniqueTargets.map((target) => target.slice(resolvePath(rootDir).length + 1)) }
    if (body.confirmRunId !== runId || body.confirmPermanent !== true) throw new HttpRouteError(400, 'permanent deletion confirmation does not match')
    const service = benchmarkRunService(rootDir)
    if (existsSync(orchestratedDir)) await service.delete(runId)
    for (const target of uniqueTargets) if (target !== resolvePath(orchestratedDir)) await rm(target, { recursive: true, force: false })
    if (!runId.startsWith('legacy:')) await unregisterSweBenchRun(rootDir, runId)
    return { action, runId, deleted: true, files, bytes }
  }
  if (action === 'artifacts-manifest') {
    const maxHashBytes = positiveInteger(body.maxHashBytes, 'maxHashBytes')
    const result = await buildArtifactManifest({
      rootDir,
      ...(cleanString(body.outputPath) ? { outputPath: cleanString(body.outputPath) } : {}),
      ...(maxHashBytes !== undefined ? { maxHashBytes } : {}),
    })
    return { action, manifestPath: result.manifestPath, summary: result.manifest.summary }
  }
  if (action === 'artifacts-prune') {
    const olderThanDays = positiveNumber(body.olderThanDays, 'olderThanDays')
    const maxTotalBytes = positiveNumber(body.maxTotalBytes, 'maxTotalBytes')
    const kinds = listInput(body.kinds)
    const result = await pruneArtifacts({
      rootDir,
      ...(olderThanDays !== undefined ? { olderThanDays } : {}),
      ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      dryRun: body.dryRun === true,
      ...(cleanString(body.outputPath) ? { outputPath: cleanString(body.outputPath) } : {}),
    })
    return {
      action,
      reportPath: result.reportPath,
      dryRun: result.report.dryRun,
      before: result.report.before,
      after: result.report.after,
      removedCount: result.report.removed.length,
      protectedCount: result.report.protected.length,
    }
  }
  if (action === 'trace-export-otlp') {
    const retries = positiveInteger(body.retries, 'retries')
    const retryDelayMs = positiveInteger(body.retryDelayMs, 'retryDelayMs')
    const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
    let headers: Record<string, string> | undefined
    if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
      const parsed: Record<string, string> = {}
      for (const [name, raw] of Object.entries(body.headers as Record<string, unknown>)) {
        if (typeof raw !== 'string' || !name.trim()) continue
        parsed[name.trim()] = raw
      }
      if (Object.keys(parsed).length > 0) headers = parsed
    } else if (typeof body.headers === 'string' && body.headers.trim().length > 0) {
      const parsed: Record<string, string> = {}
      for (const line of body.headers.split(/[\n,]/)) {
        const [name, ...rest] = line.split('=')
        const trimmedName = name?.trim()
        const value = rest.join('=').trim()
        if (trimmedName && value) parsed[trimmedName] = value
      }
      if (Object.keys(parsed).length > 0) headers = parsed
    }
    const headersFilePath = await resolveInputPath(body, 'headersFilePath', 'headersFileContent', 'headers', '.json', rootDir, action)
    const fileHeaders = await loadHeadersFile(headersFilePath)
    const mergedHeaders = fileHeaders || headers
      ? { ...(fileHeaders ?? {}), ...(headers ?? {}) }
      : undefined
    const result = await exportTraceOtlp({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions, rootDir, action),
      ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}),
      ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}),
      ...(cleanString(body.endpoint) ? { endpoint: cleanString(body.endpoint) } : {}),
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      ...(retries !== undefined ? { retries } : {}),
      ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(cleanString(body.outputFilename) ? { outputFilename: cleanString(body.outputFilename) } : {}),
      ...(cleanString(body.serviceName) ? { serviceName: cleanString(body.serviceName) } : {}),
      ...(cleanString(body.hostVersion) ? { hostVersion: cleanString(body.hostVersion) } : {}),
    })
    return {
      action,
      sessionId: result.sessionId,
      spanCount: result.spanCount,
      bundlePath: result.bundlePath,
      export: result.export,
    }
  }
  throw new HttpRouteError(400, `unsupported enhancement action: ${action}`)
}

async function sessionLogPath(body: EnhancementActionRequest, sessions: SessionStore | undefined, rootDir: string, action: string): Promise<string> {
  const explicit = cleanString(body.sessionLogPath)
  if (explicit) return explicit
  const content = cleanString(body.sessionLogContent)
  if (content) {
    try {
      return await resolveContentToPath(
        { content: body.sessionLogContent },
        { action, field: 'sessionLog', extension: '.jsonl', rootDir },
      )
    } catch (err) {
      if (err instanceof ContentInputError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  const sessionId = requiredString(body.sessionId, 'sessionId')
  if (!sessions) throw new HttpRouteError(400, 'sessionId lookup is unavailable')
  const cached = sessions.get(sessionId)
  if (cached) return cached.logPath
  return (await sessions.load(sessionId)).logPath
}

async function resolveInputPath(
  body: EnhancementActionRequest,
  pathField: keyof EnhancementActionRequest,
  contentField: keyof EnhancementActionRequest,
  logicalField: string,
  extension: string,
  rootDir: string,
  action: string,
  options: { required?: boolean } = {},
): Promise<string | undefined> {
  const path = cleanString(body[pathField])
  if (path) return path
  const rawContent = body[contentField]
  if (rawContent !== undefined && rawContent !== null && rawContent !== '') {
    try {
      return await resolveContentToPath(
        { content: rawContent as string },
        { action, field: logicalField, extension, rootDir },
      )
    } catch (err) {
      if (err instanceof ContentInputError) throw new HttpRouteError(err.httpStatus, err.message)
      throw err
    }
  }
  if (options.required) {
    throw new HttpRouteError(400, `${String(pathField)} is required (or provide ${String(contentField)})`)
  }
  return undefined
}

function sessionLogPaths(body: EnhancementActionRequest): readonly string[] {
  const paths = listInput(body.sessionLogPaths)
  if (!paths) throw new HttpRouteError(400, 'sessionLogPaths is required')
  return paths
}

function frameworkTarget(value: string): 'slime' | 'verl' | 'trl' | 'openrlhf' | 'unknown' {
  if (value === 'slime' || value === 'verl' || value === 'trl' || value === 'openrlhf' || value === 'unknown') return value
  throw new HttpRouteError(400, `invalid frameworkTarget: ${value}`)
}

async function createSweBenchPlan(body: CreateSweBenchPlanRequest, artifactRootDir: string | false | undefined): Promise<unknown> {
  const rootDir = cleanString(body.rootDir) ?? (artifactRootDir || undefined)
  if (!rootDir) throw new HttpRouteError(400, 'rootDir is required when artifact capture is not configured')
  const split = cleanString(body.split)
  const instanceIds = listInput(body.instanceIds)
  const limit = positiveInteger(body.limit, 'limit')
  const maxWorkers = positiveInteger(body.maxWorkers, 'maxWorkers')
  const timeoutMs = positiveInteger(body.timeoutMs, 'timeoutMs')
  const repoCacheDir = cleanString(body.repoCacheDir)
  const result = await planSweBenchWorkerRun({
    rootDir,
    runId: requiredString(body.runId, 'runId'),
    dataset: requiredString(body.dataset, 'dataset'),
    ...(split ? { split } : {}),
    model: requiredString(body.model, 'model'),
    instancesJsonl: requiredString(body.instancesJsonl, 'instancesJsonl'),
    ...(instanceIds ? { instanceIds } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(repoCacheDir ? { repoCacheDir } : {}),
  })
  return {
    planPath: result.planPath,
    registryPath: result.registryPath,
    runId: result.layout.runId,
    selectedCount: result.plan.selectedCount,
    maxWorkers: result.plan.maxWorkers,
    shardCount: result.plan.shards.length,
    warnings: result.plan.warnings,
    plan: result.plan,
  }
}

function requiredString(value: unknown, name: string): string {
  const cleaned = cleanString(value)
  if (!cleaned) throw new HttpRouteError(400, `${name} is required`)
  return cleaned
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function listInput(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    return out.length > 0 ? out : undefined
  }
  if (typeof value === 'string') {
    const out = value.split(',').map((item) => item.trim()).filter(Boolean)
    return out.length > 0 ? out : undefined
  }
  return undefined
}

function nonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(number) || number < 0) throw new HttpRouteError(400, `${name} must be a non-negative integer`)
  return number
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(number) || number <= 0) throw new HttpRouteError(400, `${name} must be a positive integer`)
  return number
}

function positiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number) || number < 0) throw new HttpRouteError(400, `${name} must be a non-negative number`)
  return number
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\''`)}'`
}

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

export function claimRoute(req: IncomingMessage): void {
  ;(req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] = true
}

export function routeClaimed(req: IncomingMessage): boolean {
  return (req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] === true
}

class HttpRouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function readArtifactContent(url: string, rootDir: string): Promise<{ path: string; mediaType: string; body: unknown }> {
  const parsed = new URL(url, 'http://x')
  const requested = parsed.searchParams.get('path') ?? ''
  if (!requested || requested.includes('\0')) throw new HttpRouteError(400, 'missing artifact path')
  const root = resolvePath(rootDir)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  if (!abs.startsWith(root + sep) && abs !== root) throw new HttpRouteError(403, 'artifact path escapes root')
  const st = await stat(abs).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpRouteError(404, 'artifact not found')
    throw err
  })
  if (!st.isFile()) throw new HttpRouteError(400, 'artifact path is not a file')
  if (st.size > MAX_ARTIFACT_CONTENT_BYTES) throw new HttpRouteError(413, 'artifact is too large to read inline')
  const mediaType = MIME[extname(abs).toLowerCase()] ?? 'text/plain; charset=utf-8'
  const raw = await readFile(abs, 'utf8')
  if (mediaType.startsWith('application/json')) {
    return { path: rel.split(sep).join('/'), mediaType, body: JSON.parse(raw) as unknown }
  }
  return { path: rel.split(sep).join('/'), mediaType, body: raw }
}

type DocsIndexEntry = {
  path: string
  title: string
  size: number
  updatedAt: string
}

async function listDocsIndex(configuredRoot?: string): Promise<{ root: 'docs'; docs: DocsIndexEntry[] }> {
  const root = docsRoot(configuredRoot)
  const docs: DocsIndexEntry[] = []
  await collectDocs(root, '', docs)
  docs.sort((a, b) => a.path.localeCompare(b.path))
  return { root: 'docs', docs }
}

async function collectDocs(root: string, relativeDir: string, out: DocsIndexEntry[]): Promise<void> {
  const dir = relativeDir ? join(root, relativeDir) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpRouteError(404, 'docs directory not found')
    throw err
  })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = relativeDir ? join(relativeDir, entry.name) : entry.name
    if (entry.isDirectory()) {
      await collectDocs(root, rel, out)
      continue
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    const abs = join(root, rel)
    const info = await stat(abs)
    out.push({
      path: rel.split(sep).join('/'),
      title: titleFromDocPath(rel),
      size: info.size,
      updatedAt: info.mtime.toISOString(),
    })
  }
}

async function readDocContent(url: string, configuredRoot?: string): Promise<{ path: string; title: string; body: string; updatedAt: string }> {
  const parsed = new URL(url, 'http://x')
  const requested = parsed.searchParams.get('path') ?? ''
  if (!requested || requested.includes('\0')) throw new HttpRouteError(400, 'missing doc path')
  if (extname(requested).toLowerCase() !== '.md') throw new HttpRouteError(400, 'doc path must be a markdown file')
  const root = docsRoot(configuredRoot)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  if (!abs.startsWith(root + sep) && abs !== root) throw new HttpRouteError(403, 'doc path escapes docs root')
  const info = await stat(abs).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpRouteError(404, 'doc not found')
    throw err
  })
  if (!info.isFile()) throw new HttpRouteError(400, 'doc path is not a file')
  if (info.size > MAX_DOC_CONTENT_BYTES) throw new HttpRouteError(413, 'doc is too large to read inline')
  const body = await readFile(abs, 'utf8')
  return {
    path: rel.split(sep).join('/'),
    title: titleFromMarkdown(body) ?? titleFromDocPath(rel),
    body,
    updatedAt: info.mtime.toISOString(),
  }
}

function docsRoot(configuredRoot?: string): string {
  if (configuredRoot) return resolvePath(configuredRoot)
  const starts = [resolvePath(process.cwd())]
  const executable = process.argv[1]
  if (executable) starts.push(dirname(resolvePath(executable)))
  for (const start of starts) {
    let cursor = start
    for (let i = 0; i < 8; i++) {
      const candidate = join(cursor, 'docs')
      if (existsSync(candidate)) return candidate
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return resolvePath(process.cwd(), 'docs')
}

function titleFromMarkdown(body: string): string | undefined {
  const line = body.split(/\r?\n/u).find((candidate) => candidate.startsWith('# '))
  return line?.replace(/^#\s+/, '').trim() || undefined
}

function titleFromDocPath(path: string): string {
  const name = path.split(/[\\/]/u).pop() ?? path
  return name
    .replace(/\.md$/iu, '')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function memoOwner(req: IncomingMessage): string | undefined {
  const principal = req.headers['x-agent-runlab-principal']
  if (typeof principal === 'string' && principal.length > 0) return `ingress:${principal}`
  // Standalone has no user identity provider; one local owner is intentional.
  if (!req.headers['x-agent-runlab-organization-id']) return 'standalone:local-user'
  return undefined
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  return JSON.parse(raw) as unknown
}

function sendJson(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const json = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  }
  applyCorsHeaders(req, headers)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(json)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const json = JSON.stringify({ error: message })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  })
  res.end(json)
}

export function attachStaticHandler(server: HttpServer, staticDir: string): void {
  const root = resolvePath(staticDir)
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Socket.IO's own request listener handles /socket.io/*; skip so we don't
    // clobber its response.
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    // Another handler (e.g. `/models` JSON) may have already responded.
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return

    void serveStatic(root, req, res)
  })
}

export type EmbeddedStaticAsset = {
  readonly path: string
  readonly contentBase64: string
}

export type StaticMount = {
  readonly path: string
  readonly rootDir?: string
  readonly assets?: readonly EmbeddedStaticAsset[]
}

export type DynamicStaticMount = () => StaticMount | undefined

export function attachEmbeddedStaticHandler(server: HttpServer, assets: readonly EmbeddedStaticAsset[]): void {
  const byPath = new Map<string, EmbeddedStaticAsset>()
  for (const asset of assets) {
    const normalized = normalizeStaticAssetPath(asset.path)
    byPath.set(normalized, { ...asset, path: normalized })
  }
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return

    serveEmbeddedStatic(byPath, req, res)
  })
}

export function attachStaticMountHandler(server: HttpServer, mount: StaticMount): void {
  const mountPath = normalizeMountPath(mount.path)
  const root = mount.rootDir ? resolvePath(mount.rootDir) : undefined
  const byPath = mount.assets ? embeddedAssetMap(mount.assets) : undefined
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (!isMountedPath(url, mountPath)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    claimRoute(req)
    if (new URL(url, 'http://x').pathname === mountPath) {
      redirectToMountedRoot(req, res, mountPath)
      return
    }
    const originalUrl = req.url
    req.url = mountedRequestUrl(originalUrl ?? '/', mountPath)
    if (root) {
      void serveStatic(root, req, res).finally(() => {
        req.url = originalUrl
      })
      return
    }
    if (byPath) {
      serveEmbeddedStatic(byPath, req, res)
      req.url = originalUrl
      return
    }
    req.url = originalUrl
    res.writeHead(404).end('not found')
  })
}

export function attachDynamicStaticMountHandler(server: HttpServer, getMount: DynamicStaticMount): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const mount = getMount()
    if (!mount) return
    const url = req.url ?? '/'
    const mountPath = normalizeMountPath(mount.path)
    if (!isMountedPath(url, mountPath)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    claimRoute(req)
    if (new URL(url, 'http://x').pathname === mountPath) {
      redirectToMountedRoot(req, res, mountPath)
      return
    }
    const originalUrl = req.url
    req.url = mountedRequestUrl(originalUrl ?? '/', mountPath)
    if (mount.rootDir) {
      void serveStatic(resolvePath(mount.rootDir), req, res).finally(() => {
        req.url = originalUrl
      })
      return
    }
    if (mount.assets) {
      serveEmbeddedStatic(embeddedAssetMap(mount.assets), req, res)
      req.url = originalUrl
      return
    }
    req.url = originalUrl
    res.writeHead(404).end('not found')
  })
}

export function attachReleaseAssetsHandler(
  server: HttpServer,
  releaseDir: string,
  embeddedAssets: readonly EmbeddedStaticAsset[] = [],
): void {
  const root = resolvePath(releaseDir)
  const embedded = embeddedAssetMap(embeddedAssets)
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (!url.startsWith('/release-assets/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    claimRoute(req)
    void serveReleaseAsset(root, embedded, req, res)
  })
}

function embeddedAssetMap(assets: readonly EmbeddedStaticAsset[]): Map<string, EmbeddedStaticAsset> {
  const byPath = new Map<string, EmbeddedStaticAsset>()
  for (const asset of assets) {
    const normalized = normalizeStaticAssetPath(asset.path)
    byPath.set(normalized, { ...asset, path: normalized })
  }
  return byPath
}

function normalizeMountPath(path: string): string {
  const trimmed = path.trim() || '/'
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '') || '/'
}

function isMountedPath(rawUrl: string, mountPath: string): boolean {
  const pathname = new URL(rawUrl, 'http://x').pathname
  return pathname === mountPath || pathname.startsWith(`${mountPath}/`)
}

function mountedRequestUrl(rawUrl: string, mountPath: string): string {
  const url = new URL(rawUrl, 'http://x')
  const suffix = url.pathname === mountPath ? '/' : url.pathname.slice(mountPath.length)
  url.pathname = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${url.pathname}${url.search}`
}

function redirectToMountedRoot(req: IncomingMessage, res: ServerResponse, mountPath: string): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const location = `${mountPath}/${url.search}`
  res.writeHead(308, {
    location,
    'cache-control': 'no-store',
    'content-length': '0',
  })
  res.end()
}

export function attachRequestHandler(
  server: HttpServer,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    handler(req, res)
  })
}

async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = decodeURIComponent(url.pathname)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  // Reject traversal above root.
  if (!abs.startsWith(root + sep) && abs !== root) {
    res.writeHead(403).end()
    return
  }

  const filePath = await pickFile(abs, root)
  if (!filePath) {
    res.writeHead(404).end('not found')
    return
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = { 'content-type': mime }
  // Vite emits `assets/*.<hash>.<ext>` — safe to cache forever. Everything
  // else (index.html, favicon, etc.) must revalidate so stale dashboard
  // builds don't survive a redeploy in the user's browser.
  if (/[/\\]assets[/\\][^/\\]+\.[0-9a-f]{6,}\./i.test(filePath)) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['cache-control'] = 'no-cache, must-revalidate'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

function serveEmbeddedStatic(
  assets: ReadonlyMap<string, EmbeddedStaticAsset>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = normalizeStaticAssetPath(decodeURIComponent(url.pathname))
  const asset = pickEmbeddedAsset(assets, requested)
  if (!asset) {
    res.writeHead(404).end('not found')
    return
  }
  const body = Buffer.from(asset.contentBase64, 'base64')
  const mime = MIME[extname(asset.path).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'content-type': mime,
    'content-length': String(body.byteLength),
  }
  if (/^assets\/[^/]+\.[0-9a-f]{6,}\./i.test(asset.path)) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['cache-control'] = 'no-cache, must-revalidate'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

function pickEmbeddedAsset(
  assets: ReadonlyMap<string, EmbeddedStaticAsset>,
  requested: string,
): EmbeddedStaticAsset | null {
  if (requested === '__forbidden__') return null
  const direct = assets.get(requested)
  if (direct) return direct
  const index = assets.get(`${requested.replace(/\/+$/u, '')}/index.html`)
  if (index) return index
  return assets.get('index.html') ?? null
}

function normalizeStaticAssetPath(path: string): string {
  const rel = normalize(path).replace(/^[/\\]+/, '')
  if (!rel || rel === '.') return 'index.html'
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return '__forbidden__'
  return rel.replace(/\\/g, '/')
}

function parseRestartRequest(body: unknown): { mode?: 'checkpoint' | 'when_idle' | 'force'; reason?: 'manual' | 'deploy' | 'settings_changed'; timeoutMs?: number } {
  if (body === null || typeof body !== 'object') return {}
  const input = body as Record<string, unknown>
  const out: { mode?: 'checkpoint' | 'when_idle' | 'force'; reason?: 'manual' | 'deploy' | 'settings_changed'; timeoutMs?: number } = {}
  if (input.mode !== undefined) {
    if (input.mode !== 'checkpoint' && input.mode !== 'when_idle' && input.mode !== 'force') throw new Error('invalid restart mode')
    out.mode = input.mode
  }
  if (input.reason !== undefined) {
    if (input.reason !== 'manual' && input.reason !== 'deploy' && input.reason !== 'settings_changed') throw new Error('invalid restart reason')
    out.reason = input.reason
  }
  if (input.timeoutMs !== undefined) {
    const n = Number(input.timeoutMs)
    if (!Number.isFinite(n) || n <= 0) throw new Error('invalid restart timeoutMs')
    out.timeoutMs = Math.floor(n)
  }
  return out
}

async function serveReleaseAsset(
  root: string,
  embeddedAssets: ReadonlyMap<string, EmbeddedStaticAsset>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = decodeURIComponent(url.pathname.replace(/^\/release-assets\//, ''))
  if (!requested || requested.includes('/')) {
    res.writeHead(404).end('not found')
    return
  }
  const abs = join(root, normalize(requested).replace(/^[/\\]+/, ''))
  if (!abs.startsWith(root + sep) && abs !== root) {
    res.writeHead(403).end()
    return
  }
  try {
    const st = await stat(abs)
    if (!st.isFile()) {
      serveEmbeddedReleaseAsset(embeddedAssets, requested, req, res)
      return
    }
  } catch {
    serveEmbeddedReleaseAsset(embeddedAssets, requested, req, res)
    return
  }
  const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache, must-revalidate' })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(abs).pipe(res)
}

function serveEmbeddedReleaseAsset(
  assets: ReadonlyMap<string, EmbeddedStaticAsset>,
  requested: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const asset = assets.get(normalizeStaticAssetPath(requested))
  if (!asset) {
    res.writeHead(404).end('not found')
    return
  }
  const body = Buffer.from(asset.contentBase64, 'base64')
  const mime = MIME[extname(asset.path).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': mime,
    'content-length': String(body.byteLength),
    'cache-control': 'no-cache, must-revalidate',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolvePath(root)
  const normalizedCandidate = resolvePath(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

async function deletionDirectoryImpact(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    const info = await stat(path)
    if (!info.isDirectory()) { files += 1; bytes += info.size; return }
    for (const name of await readdir(path)) await visit(join(path, name))
  }
  await visit(directory)
  return { files, bytes }
}

async function pickFile(abs: string, root: string): Promise<string | null> {
  try {
    const st = await stat(abs)
    if (st.isFile()) return abs
    if (st.isDirectory()) {
      const idx = join(abs, 'index.html')
      try {
        const s = await stat(idx)
        if (s.isFile()) return idx
      } catch {}
    }
  } catch {}
  // SPA fallback: unknown routes serve index.html (client-side routing).
  const fallback = join(root, 'index.html')
  try {
    const s = await stat(fallback)
    if (s.isFile()) return fallback
  } catch {}
  return null
}
