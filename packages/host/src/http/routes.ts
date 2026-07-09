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
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'

import type {
  AttachedExecutor,
  ClientAddManualModel,
  ClientDeleteManualModel,
  ModelInfo,
  ServerModelsPayload,
  ServerSettingsPayload,
} from '@agent-kernel/shared'

import { buildArtifactManifest, pruneArtifacts } from '../artifact-manifest.js'
import {
  exportRolloutFrameworkAdapter,
  exportRolloutSegments,
  exportRolloutSidecar,
} from '../rl-export.js'
import { verifyReward } from '../rl-reward.js'
import { exportSessionTraceArtifacts } from '../session-export.js'
import { exportTraceOtlp, loadHeadersFile } from '../trace-otlp-export.js'
import { compareEvalRuns, judgeScore, profileSession, scoreSession } from '../eval/generic.js'
import { evaluateRegressionGate, type RegressionThresholdPolicy } from '../eval/regression-gate.js'
import { aggregateProfiles } from '../eval/cost-aggregate.js'
import { evaluateProfileBudget, type ProfileBudgetPolicy } from '../eval/profile-budget.js'
import {
  exportSessionForSweBench,
  inferSweBenchPatchRun,
  ingestSweBenchResults,
  planSweBenchWorkerRun,
  runSweBenchAgentPatchRun,
  runSweBenchGrade,
  sweBenchRunLayout,
} from '../eval/swebench.js'
import {
  importTerminalBenchResults,
  resolveTerminalBenchTasks,
  runTerminalBenchRun,
  terminalBenchRunLayout,
} from '../eval/terminal-bench.js'
import { mineBadCases } from '../eval/badcase-mining.js'
import { readSweBenchRunRegistry } from '../eval/run-registry.js'
import { exportForRL, exportForSFT } from '../eval/badcase-export.js'
import { exportRollouts } from '../eval/rollout-export.js'
import { annotateBadCase, readBadCaseAnnotations, BAD_CASE_LABELS, type BadCaseLabel } from '../eval/badcase-annotations.js'
import {
  InstancesSourceError,
  resolveSweBenchInstances,
  type InstancesSource,
} from '../eval/swebench-instances-source.js'
import {
  PatchesSourceError,
  resolveSweBenchPatches,
} from '../eval/swebench-patches-source.js'
import {
  ResultsSourceError,
  resolveSweBenchResults,
} from '../eval/swebench-results-source.js'
import { buildMemoryIndex } from '../memory-index.js'
import { retrieveMemory } from '../memory-retrieval.js'
import { auditSessionReliability, replayReliabilityChaos } from '../reliability.js'
import { evaluateReliabilityGate, type ReliabilityGatePolicy } from '../reliability-gate.js'
import { classifyReliability } from '../reliability-classify.js'
import { diffToolCatalogs } from '../tool-catalog-diff.js'
import { writeExecutorCapabilitySnapshot } from '../executor-capabilities.js'
import type { SessionStore } from '../store/session.js'
import { exportSubAgentGraph } from '../subagent-graph.js'
import { ContentInputError, resolveContentToPath } from './content-inputs.js'

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

function defaultSweBenchAgentCommand(): string {
  // Smoke-test recipe: produces an empty patch inside the workspace so the
  // whole Plan → Infer → Grade → Ingest wizard can complete end-to-end
  // without a real agent. Real users must supply their own agentCommand
  // (e.g. Claude Code CLI, aider, or a custom shell script) via the wizard's
  // "Custom shell command" recipe. This intentionally does NOT invoke
  // agent-kernel-executor — that binary is a socket.io daemon, not a
  // standalone agent runner.
  return 'true'
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
  skipCompleted?: boolean
  tasksJsonl?: string
  tasksContent?: string
  taskIds?: readonly string[] | string
  label?: string
  note?: string
  format?: string
  target?: string
  includeStatuses?: readonly string[] | string
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
    routerHealth?: () => unknown
    executorsSnapshot?: () => readonly AttachedExecutor[]
  },
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    // Strip query string / fragment before matching, so `/models?ts=…`
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
    if (path === '/docs/index') {
      claimRoute(req)
      void listDocsIndex()
        .then((result) => sendJson(req, res, result))
        .catch((err: unknown) => sendError(res, err instanceof HttpRouteError ? err.status : 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/docs/content') {
      claimRoute(req)
      void readDocContent(url)
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

async function runEnhancementAction(
  body: EnhancementActionRequest,
  payloads: {
    artifactRootDir?: string | false
    sessions?: SessionStore
    executorsSnapshot?: () => readonly AttachedExecutor[]
  },
): Promise<unknown> {
  const action = requiredString(body.action, 'action')
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
    const result = await runSweBenchAgentPatchRun({
      rootDir,
      runId,
      dataset: requiredString(body.dataset, 'dataset'),
      ...(cleanString(body.split) ? { split: cleanString(body.split) } : {}),
      model: requiredString(body.model, 'model'),
      instancesJsonl: cleanString(body.instancesJsonl) ?? layout.instancesPath,
      agentCommand: cleanString(body.agentCommand) ?? defaultSweBenchAgentCommand(),
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
  if (action === 'badcase-list') {
    const runId = requiredString(body.runId, 'runId')
    const rootDir = cleanString(body.rootDir) ?? (payloads.artifactRootDir || undefined)
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
    runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return { action, runs }
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

type DocsIndexEntry = {
  path: string
  title: string
  size: number
  updatedAt: string
}

async function listDocsIndex(): Promise<{ root: 'docs'; docs: DocsIndexEntry[] }> {
  const root = docsRoot()
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

async function readDocContent(url: string): Promise<{ path: string; title: string; body: string; updatedAt: string }> {
  const parsed = new URL(url, 'http://x')
  const requested = parsed.searchParams.get('path') ?? ''
  if (!requested || requested.includes('\0')) throw new HttpRouteError(400, 'missing doc path')
  if (extname(requested).toLowerCase() !== '.md') throw new HttpRouteError(400, 'doc path must be a markdown file')
  const root = docsRoot()
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

function docsRoot(): string {
  let cursor = resolvePath(process.cwd())
  for (let i = 0; i < 8; i++) {
    const candidate = join(cursor, 'docs')
    if (existsSync(candidate)) return candidate
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
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
