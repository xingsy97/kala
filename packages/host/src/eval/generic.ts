import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { fold } from '@agent-kernel/kernel'
import {
  createArtifactStore,
  createSessionProfile,
  summarizeEvalScores,
  type ArtifactRef,
  type EvalScoreResult,
  type EvalScoreSummary,
  type PricingTable,
  type SessionProfile,
} from '@agent-kernel/shared'

import { readSessionLog } from '../store/log.js'

export type ScoreSessionInput = {
  rootDir: string
  sessionLogPath: string
  instanceId?: string
  patchPath?: string
  requireDone?: boolean
  workspaceRoot?: string
}

export async function scoreSession(
  input: ScoreSessionInput,
): Promise<{ summary: EvalScoreSummary; scoresPath: string; artifacts: readonly ArtifactRef[] }> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const artifacts: ArtifactRef[] = []
  let patch = ''
  if (input.patchPath) {
    patch = await readFile(input.patchPath, 'utf8')
    artifacts.push(await store.writeText('diff', `artifacts/${basename(input.patchPath)}`, patch))
  }
  const results: EvalScoreResult[] = []
  if (input.patchPath) {
    const passed = patch.trim().length > 0
    results.push({
      scorer: 'patch.non_empty',
      passed,
      ...(passed ? {} : { label: 'empty_patch' }),
      score: passed ? 1 : 0,
      metrics: { patchBytes: Buffer.byteLength(patch, 'utf8') },
      artifactRefs: artifacts,
      explanation: passed ? 'Patch contains changes.' : 'Patch file is empty.',
    })
  }
  const agentError = parsed.events.find((entry) => entry.event.kind === 'llm_error')
  results.push({
    scorer: 'agent.no_llm_error',
    passed: !agentError,
    ...(!agentError ? {} : { label: 'agent_error' as const }),
    score: agentError ? 0 : 1,
    metrics: { llmErrors: agentError ? 1 : 0 },
    artifactRefs: [],
    explanation: agentError ? 'Session contains an llm_error event.' : 'No llm_error event was recorded.',
  })
  const toolErrors = parsed.events.filter((entry) => entry.event.kind === 'tool_result' && entry.event.ok === false).length
  results.push({
    scorer: 'tools.no_failed_results',
    passed: toolErrors === 0,
    ...(toolErrors === 0 ? {} : { label: 'agent_error' as const }),
    score: toolErrors === 0 ? 1 : 0,
    metrics: { toolErrors },
    artifactRefs: [],
  })
  if (input.requireDone) {
    const finalState = fold(parsed.header.initialState, parsed.events.map((entry) => entry.event), parsed.header.config)
    const passed = finalState.status === 'done'
    results.push({
      scorer: 'session.final_status_done',
      passed,
      ...(passed ? {} : { label: 'agent_error' as const }),
      score: passed ? 1 : 0,
      metrics: { finalStatus: finalState.status },
      artifactRefs: [],
    })
  }
  const summary = summarizeEvalScores(results, input.instanceId)
  const scoresPath = join(input.rootDir, 'scores.json')
  await writeFile(scoresPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { summary, scoresPath, artifacts }
}

export type ProfileSessionInput = {
  rootDir: string
  sessionLogPath: string
  pricingPath?: string
}

export async function profileSession(
  input: ProfileSessionInput,
): Promise<{ profile: SessionProfile; profilePath: string }> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const pricing = input.pricingPath
    ? JSON.parse(await readFile(input.pricingPath, 'utf8')) as PricingTable
    : undefined
  const profile = createSessionProfile({
    header: parsed.header,
    events: parsed.events,
    ...(pricing ? { pricing } : {}),
  })
  const profilePath = join(input.rootDir, 'profile.json')
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return { profile, profilePath }
}
