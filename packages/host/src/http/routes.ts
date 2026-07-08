/**
 * HTTP request routing for the host process.
 *
 *   - `/models`     JSON, GET/HEAD     -  sanitised model list for the dashboard
 *   - `/settings`   JSON, GET/HEAD     -  settings snapshot
 *   - `/settings/models` POST/DELETE   -  manually managed model ids
 *   - everything else                  -  static bundle (dashboard `dist/`),
 *                                       with SPA fallback to `index.html`
 *
 * Socket.IO owns `/socket.io/*` on the same HTTP server; every handler here
 * short-circuits on that prefix so the two listeners don't clobber each
 * other. JSON routes always run first because static serving falls back to
 * `index.html` for unknown paths and would otherwise mask a missing endpoint.
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path'

import type {
  ClientAddManualModel,
  ClientDeleteManualModel,
  ModelInfo,
  ServerModelsPayload,
  ServerSettingsPayload,
} from '@agent-kernel/shared'

import { buildArtifactManifest } from '../artifact-manifest.js'
import {
  exportRolloutFrameworkAdapter,
  exportRolloutSegments,
  exportRolloutSidecar,
  exportSessionTraceArtifacts,
} from '../enhancement-export.js'
import { compareEvalRuns, judgeScore, profileSession, scoreSession } from '../eval/generic.js'
import {
  exportSessionForSweBench,
  inferSweBenchPatchRun,
  ingestSweBenchResults,
  planSweBenchWorkerRun,
  runSweBenchGrade,
} from '../eval/swebench.js'
import { buildMemoryIndex } from '../memory-index.js'
import { auditSessionReliability, replayReliabilityChaos } from '../reliability.js'
import type { SessionStore } from '../store/session.js'
import { exportSubAgentGraph } from '../subagent-graph.js'

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
}

const ROUTE_CLAIMED = Symbol('agent-kernel-route-claimed')
const MAX_ARTIFACT_CONTENT_BYTES = 1024 * 1024

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
  sessionLogPath?: string
  sessionLogPaths?: readonly string[] | string
  workspaceRoot?: string
  runId?: string
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
}

export function attachJsonRoutes(
  server: HttpServer,
  payloads: {
    models: readonly ModelInfo[] | (() => readonly ModelInfo[])
    defaultModel: string | (() => string)
    settings?: ServerSettingsPayload | (() => ServerSettingsPayload)
    addManualModel?: (input: ClientAddManualModel) => ServerSettingsPayload
    deleteManualModel?: (input: ClientDeleteManualModel) => ServerSettingsPayload
    artifactRootDir?: string | false
    sessions?: SessionStore
  },
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    // Strip query string / fragment before matching, so `/models?ts= - `
    // (cache-buster) still hits.
    const path = url.split('?')[0]!.split('#')[0]
    if (path === '/settings/models' && req.method === 'POST' && payloads.addManualModel) {
      claimRoute(req)
      void readJson(req)
        .then((body) => sendJson(req, res, payloads.addManualModel!(body as ClientAddManualModel)))
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/models' && req.method === 'DELETE' && payloads.deleteManualModel) {
      claimRoute(req)
      const parsed = new URL(url, 'http://x')
      try {
        sendJson(
          req,
          res,
          payloads.deleteManualModel({
            providerId: parsed.searchParams.get('providerId') ?? '',
            id: parsed.searchParams.get('id') ?? '',
          }),
        )
      } catch (err: unknown) {
        sendError(res, 400, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (path === '/eval/swebench/plan' && req.method === 'POST') {
      claimRoute(req)
      void readJson(req)
        .then((body) => createSweBenchPlan(body as CreateSweBenchPlanRequest, payloads.artifactRootDir))
        .then((result) => sendJson(req, res, result))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/enhancement/action' && req.method === 'POST') {
      claimRoute(req)
      void readJson(req)
        .then((body) => runEnhancementAction(body as EnhancementActionRequest, payloads))
        .then((result) => sendJson(req, res, result))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return
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
  })
}

async function runEnhancementAction(
  body: EnhancementActionRequest,
  payloads: { artifactRootDir?: string | false; sessions?: SessionStore },
): Promise<unknown> {
  const action = requiredString(body.action, 'action')
  if (action === 'swebench-grade-command') {
    const maxWorkers = positiveInteger(body.maxWorkers, 'maxWorkers')
    const instanceIds = listInput(body.instanceIds)
    const result = await runSweBenchGrade({
      datasetName: requiredString(body.dataset, 'dataset'),
      predictionsPath: requiredString(body.predictionsPath, 'predictionsPath'),
      runId: requiredString(body.runId, 'runId'),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      ...(instanceIds ? { instanceIds } : {}),
      ...(body.modal === true ? { modal: true } : {}),
      ...(cleanString(body.cwd) ? { cwd: cleanString(body.cwd) } : {}),
      execute: false,
    })
    return { action, command: result.command, shellCommand: result.command.map(shellQuote).join(' ') }
  }
  const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
  if (!rootDir) throw new HttpRouteError(400, 'rootDir is required when artifact capture is not configured')
  if (action === 'profile-session') {
    const result = await profileSession({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions), ...(cleanString(body.pricingPath) ? { pricingPath: cleanString(body.pricingPath) } : {}) })
    return { action, profilePath: result.profilePath, profile: result.profile }
  }
  if (action === 'reliability-audit-session') {
    const result = await auditSessionReliability({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions) })
    return { action, auditPath: result.auditPath, audit: result.audit }
  }
  if (action === 'reliability-chaos-replay') {
    const result = await replayReliabilityChaos({ rootDir, sessionLogPaths: sessionLogPaths(body) })
    return { action, reportPath: result.reportPath, report: result.report }
  }
  if (action === 'memory-index') {
    const result = await buildMemoryIndex({ rootDir, ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}), ...(body.includeGlobal === true ? { includeGlobal: true } : {}) })
    return { action, indexPath: result.indexPath, entries: result.index.entries.length, warnings: result.index.warnings }
  }
  if (action === 'subagents-graph') {
    const result = await exportSubAgentGraph({ rootDir, sessionsDir: cleanString(body.sessionsDir) ?? payloads.sessions?.dir ?? requiredString(body.sessionsDir, 'sessionsDir') })
    return { action, graphPath: result.graphPath, nodes: result.graph.nodes.length, edges: result.graph.edges.length, warnings: result.graph.warnings }
  }
  if (action === 'trace-export-session') {
    const result = await exportSessionTraceArtifacts({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions), ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}), ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, sessionId: result.sessionId, traceArtifact: result.traceArtifact, llmArtifacts: result.llmArtifacts }
  }
  if (action === 'rollout-export-segments') {
    const result = await exportRolloutSegments({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions), ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}), ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, sessionId: result.sessionId, artifact: result.artifact, segmentCount: result.segments.segments.length }
  }
  if (action === 'rollout-export-session') {
    const result = await exportRolloutSidecar({
      rootDir,
      sessionLogPath: await sessionLogPath(body, payloads.sessions),
      taskId: requiredString(body.taskId, 'taskId'),
      frameworkTarget: frameworkTarget(requiredString(body.frameworkTarget ?? body.framework, 'frameworkTarget')),
      ...(cleanString(body.runId) ? { runId: cleanString(body.runId) } : {}),
      ...(cleanString(body.evalInstanceId) ? { evalInstanceId: cleanString(body.evalInstanceId) } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
      ...(cleanString(body.model) ? { model: cleanString(body.model) } : {}),
      ...(cleanString(body.weightVersion) ? { weightVersion: cleanString(body.weightVersion) } : {}),
      ...(cleanString(body.rewardPath) ? { rewardPath: cleanString(body.rewardPath) } : {}),
      ...(cleanString(body.tokenSegmentsPath) ? { tokenSegmentsPath: cleanString(body.tokenSegmentsPath) } : {}),
    })
    return { action, rolloutId: result.sidecar.rollout_id, sidecarPath: result.sidecarPath, traceArtifact: result.traceArtifact }
  }
  if (action === 'rollout-export-adapter') {
    const framework = cleanString(body.frameworkTarget ?? body.framework)
    const result = await exportRolloutFrameworkAdapter({ rootDir, sidecarPath: requiredString(body.sidecarPath, 'sidecarPath'), ...(framework ? { frameworkTarget: frameworkTarget(framework) } : {}) })
    return { action, adapterPath: result.adapterPath, status: result.adapter.status, frameworkTarget: result.adapter.frameworkTarget }
  }
  if (action === 'eval-score-session') {
    const result = await scoreSession({ rootDir, sessionLogPath: await sessionLogPath(body, payloads.sessions), ...(cleanString(body.instanceId) ? { instanceId: cleanString(body.instanceId) } : {}), ...(cleanString(body.patchPath) ? { patchPath: cleanString(body.patchPath) } : {}), ...(body.requireDone === true ? { requireDone: true } : {}), ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}) })
    return { action, scoresPath: result.scoresPath, summary: result.summary }
  }
  if (action === 'eval-judge-score') {
    const threshold = positiveNumber(body.threshold, 'threshold')
    const result = await judgeScore({
      rootDir,
      promptPath: requiredString(body.promptPath, 'promptPath'),
      responsePath: requiredString(body.responsePath, 'responsePath'),
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
    const result = await compareEvalRuns({ rootDir, baselineSummaryPath: requiredString(body.baselineSummaryPath, 'baselineSummaryPath'), candidateSummaryPath: requiredString(body.candidateSummaryPath, 'candidateSummaryPath') })
    return { action, comparisonPath: result.comparisonPath, comparison: result.comparison }
  }
  if (action === 'swebench-infer-patches') {
    const instanceIds = listInput(body.instanceIds)
    const limit = positiveInteger(body.limit, 'limit')
    const result = await inferSweBenchPatchRun({
      rootDir,
      runId: requiredString(body.runId, 'runId'),
      dataset: requiredString(body.dataset, 'dataset'),
      ...(cleanString(body.split) ? { split: cleanString(body.split) } : {}),
      model: requiredString(body.model, 'model'),
      instancesJsonl: requiredString(body.instancesJsonl, 'instancesJsonl'),
      patchesDir: requiredString(body.patchesDir, 'patchesDir'),
      ...(instanceIds ? { instanceIds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
    })
    return { action, runId: result.layout.runId, predictionsPath: result.layout.predictionsPath, experimentPath: result.layout.experimentPath, summaryPath: result.layout.summaryPath, trialCount: result.trials.length }
  }
  if (action === 'swebench-export-session') {
    const modelPatch = await readFile(requiredString(body.modelPatchPath ?? body.patchPath, 'modelPatchPath'), 'utf8')
    const result = await exportSessionForSweBench({
      rootDir,
      runId: requiredString(body.runId, 'runId'),
      dataset: requiredString(body.dataset, 'dataset'),
      ...(cleanString(body.split) ? { split: cleanString(body.split) } : {}),
      model: requiredString(body.model, 'model'),
      instanceId: requiredString(body.instanceId, 'instanceId'),
      sessionLogPath: await sessionLogPath(body, payloads.sessions),
      modelPatch,
      ...(cleanString(body.workspaceRoot) ? { workspaceRoot: cleanString(body.workspaceRoot) } : {}),
    })
    return { action, runId: result.layout.runId, predictionsPath: result.layout.predictionsPath, experimentPath: result.layout.experimentPath, traceArtifact: result.traceArtifact }
  }
  if (action === 'swebench-ingest-results') {
    const result = await ingestSweBenchResults({ rootDir, runId: requiredString(body.runId, 'runId'), resultsDir: requiredString(body.resultsDir, 'resultsDir') })
    return { action, runId: result.layout.runId, resultsPath: result.resultsPath, summaryPath: result.summaryPath, trialCount: result.trials.length, resolved: result.trials.filter((trial) => trial.resolved).length }
  }
  throw new HttpRouteError(400, `unsupported enhancement action: ${action}`)
}

async function sessionLogPath(body: EnhancementActionRequest, sessions: SessionStore | undefined): Promise<string> {
  const explicit = cleanString(body.sessionLogPath)
  if (explicit) return explicit
  const sessionId = requiredString(body.sessionId, 'sessionId')
  if (!sessions) throw new HttpRouteError(400, 'sessionId lookup is unavailable')
  const cached = sessions.get(sessionId)
  if (cached) return cached.logPath
  return (await sessions.load(sessionId)).logPath
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

function claimRoute(req: IncomingMessage): void {
  ;(req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] = true
}

function routeClaimed(req: IncomingMessage): boolean {
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
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  })
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
  // Vite emits `assets/*.<hash>.<ext>`  -  safe to cache forever. Everything
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
