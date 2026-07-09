#!/usr/bin/env tsx
import { execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { createRuntimeLogger } from '../src/logger.js'
import { defaultBenchmarkEnvPath, loadAnthropicCliDefaults, loadEnvFile, requireAnthropicBaseUrl } from '../src/runtime-config.js'

type AgentName = 'agent-runlab' | 'claude-code'

type Args = {
  portfolioDir: string
  casesPath: string
  answerKeyPath: string
  agents: readonly AgentName[]
  model: string
  baseUrl: string
  baseUrlSource: 'cli' | 'env' | 'env-file' | 'claude-settings'
  smallFastModel: string
  judgeProvider: 'anthropic' | 'openai'
  judgeModel: string
  judgeBaseUrl?: string
  limit?: number
  offset: number
  caseIds: readonly string[]
  timeoutMs: number
  maxTurns: number
  maxWebToolCalls: number
  maxAgentRuns?: number
  stopAfterErrors?: number
  stopAfterUnresolved?: number
  stopAfterTurnLimits?: number
  updateLatest: boolean
  runId: string
  dryRun: boolean
}

type BrowseCompCase = {
  benchmark: 'browsecomp'
  instance_id: string
  source_row_index: number
  question: string
}

type AnswerKey = {
  benchmark: 'browsecomp'
  instance_id: string
  source_row_index: number
  answer: string
}

type InstanceResult = {
  benchmark: 'browsecomp'
  instance_id: string
  agent: AgentName
  model: string
  status: 'resolved' | 'unresolved' | 'error' | 'not_run'
  score: number
  official: boolean
  scorer: string
  judge_model: string
  error_type: string | null
  artifact_refs: string[]
}

type AgentRunMetadata = {
  turnLimitHit: boolean
  finalizedAfterTurnLimit?: boolean
  transcriptPath?: string
}

const logger = createRuntimeLogger('browsecomp-portfolio')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const QUERY_TEMPLATE = `
{Question}

Use web search when needed, but keep the investigation bounded.

Search discipline:
- First identify 4-8 distinctive clue facets from the question, including date ranges, roles, places, relationship clues, and exact phrases.
- Before the first search, write down the expected answer type, such as person birth name, year, date, place, organization, title, or family name. Every candidate and query must be judged against that answer type.
- Treat multi-hop questions as a clue chain before searching. Write a numbered hop plan where each hop has: the entity to identify, required evidence, answer type if that hop resolves, and a fallback reverse-search query. Do not spend more than two searches on one upstream hop without either recording a candidate or pivoting to the next/downstream clue.
- Treat the run as having a strict search budget. Before every tool call, state whether it is: candidate discovery, candidate verification, contradiction testing, or final evidence extraction. If a proposed search is only a wording variant of an earlier failed search, do not run it.
- Use at most 12 total web/search/fetch/bash evidence-gathering calls before choosing a best-supported answer. After 8 evidence-gathering calls, stop opening new clue families; spend remaining calls only verifying or falsifying the strongest candidate.
- Start with one high-specificity query that combines the rarest facets. Avoid broad nationality/celebrity sweeps unless a source supports that geography.
- Keep at most two live candidate identities. For each candidate, verify the required facets against web sources before switching. Do not open a third candidate until one live candidate has a recorded contradiction or has failed an answer-type-specific verification query.
- Maintain a compact candidate evidence ledger in your reasoning: candidate, supporting facets, contradicted facets, strongest source URL/title, and next verification action. Do not pursue a candidate unless it can satisfy at least two independent clue facets.
- When the answer type is a person birth name, stage name, real name, alias, spouse, child count, or similar biography field, stop broad searching once a plausible person appears and verify with targeted biographical queries using terms like birth name, born as, real name, pseudonym, spouse, children, discography, and first album.
- Every 4 assistant turns, checkpoint the ledger and decide one of three actions: verify the best candidate, replace a contradicted candidate, or finalize. Do not continue broad search after a checkpoint without naming the missing facet you are testing.
- At each checkpoint, either eliminate at least one candidate with a specific contradicted facet or run one answer-type-specific verification query for the strongest candidate. Do not merely add broader candidates at a checkpoint.
- At each checkpoint for a multi-hop question, update the hop plan: mark each hop as solved, blocked, or bypassed. If an upstream hop is blocked, try one reverse query from the downstream clue instead of continuing to search variants of the same upstream description.
- Treat pages that mainly mirror the question wording, look like SEO/job/crossword/scraper pages, or return only age gates / "Loading" text as non-evidence. Do not fetch more pages from the same suspicious domain after one such result.
- Use a source-centric workflow: once a plausible book, archive record, catalog page, or primary text appears, stop broadening and inspect that source deeply.
- Prefer institutional repositories, university pages, CVs, official association member announcements, thesis catalog records, PubMed/PMC, Google Books/Archive.org text, and official encyclopedia/biography pages over generic scraped result pages.
- For Archive.org results, do not treat the item landing page as the book text. Extract the item identifier from the URL and fetch likely OCR/metadata endpoints before doing more broad search, such as:
  - https://archive.org/metadata/{identifier}
  - https://archive.org/stream/{identifier}/{identifier}_djvu.txt
  - https://archive.org/download/{identifier}/{identifier}_djvu.txt
- If an OCR/full-text fetch is available, search within that text mentally for names, dates, discharge/service terms, hospital transfer, and the last-letter clues before issuing another broad web search.
- If a candidate title and author are known, switch to focused verification queries using that title/author plus the requested property, for example discharge date, service record, hospital, or surgeon general.
- If a candidate disease and year are known but no person is known, pivot to source records rather than more broad keyword soup: search for exact disease phrase plus thesis/dissertation and year, then search the candidate thesis title with advisor/director/supervisor.
- If a data table, CSV, catalog, or search result produces many possible entities, immediately add one answer-type-specific filter from the question before fetching unrelated entity pages. Do not jump to a different semantic domain unless the ledger names the bridge facet that connects it.
- If no candidate has at least two supporting facets by assistant turn 8, pick the least contradicted candidate or answer Unknown with a concrete reason. Do not continue with exploratory searches past that point.
- After 6 assistant turns, stop broadening unless no plausible primary source has appeared. After 10 assistant turns, either verify the strongest candidate or produce a low-confidence final answer. After 14 assistant turns, stop opening new web branches and finalize from the evidence ledger. Do not spend the last turns opening new broad search branches.
- Do not repeatedly search near-duplicate queries. If two searches fail, change the evidence strategy: fetch a promising source, query an exact phrase from the source, or test one named candidate.
- Never finish with a plan, a search strategy, or a promise to continue. If evidence is incomplete, output the best-supported exact answer from the ledger with low confidence and explain the missing facet.

If the evidence is incomplete near the end of your allowed turns, stop searching and give the best-supported answer you can. Do not end with a plan to keep searching; always provide a final answer in the requested format.

Use web sources for the investigation. Do not inspect the local repository, home directory, previous benchmark runs, or other local files; they are not part of this task.

Your response should be in the following format:
Explanation: {your explanation for your final answer}
Exact Answer: {your succinct, final answer}
Confidence: {your confidence score between 0% and 100% for your answer}
`.trim()

const GRADER_TEMPLATE = `
Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.

[question]: {question}

[response]: {response}

Your judgement must be in the format and criteria specified below:

extracted_final_answer: The final exact answer extracted from the [response]. Put the extracted answer as 'None' if there is no exact, final answer to extract from the response.

[correct_answer]: {correct_answer}

reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], focusing only on if there are meaningful differences between [correct_answer] and the extracted_final_answer. Do not comment on any background to the problem, do not attempt to solve the problem, do not argue for any answer different than [correct_answer], focus only on whether the answers match.

correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given below, or is within a small margin of error for numerical problems. Answer 'no' otherwise, i.e. if there if there is any inconsistency, ambiguity, non-equivalency, or if the extracted answer is incorrect.

confidence: The extracted confidence score between 0% and 100% from [response]. Put 100 if there is no confidence score available.
`.trim()

const FINALIZER_TEMPLATE = `
You are finalizing a BrowseComp benchmark response after the agent reached its configured turn budget.

Use only the original question, the original agent output, and the archived transcript excerpt below. Do not request tools, do not propose more searching, and do not mention that you would continue investigating. If the evidence is incomplete, choose the best-supported answer from the transcript and lower the confidence. Return Unknown only when the transcript contains no defensible candidate answer. If the transcript contains a plausible exact date, name, title, location, or other requested final answer tied to a candidate source, output that candidate with low confidence rather than Unknown.

[question]
{question}

[original_agent_output]
{response}

[transcript_excerpt]
{transcript}

Return exactly this format:
Explanation: {brief evidence-based explanation}
Exact Answer: {succinct final answer, or Unknown if there is no defensible answer}
Confidence: {confidence score between 0% and 100%}
`.trim()

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cases = selectCases(await readJsonl<BrowseCompCase>(args.casesPath), args)
  const answerById = new Map((await readJsonl<AnswerKey>(args.answerKeyPath)).map((row) => [row.instance_id, row]))
  const root = join(args.portfolioDir, 'artifacts', 'browsecomp')
  const runRoot = join(root, args.runId)
  await mkdir(runRoot, { recursive: true })
  const instanceResults: InstanceResult[] = []
  let stopReason: string | null = null

  const judge = args.dryRun ? undefined : buildJudge(args)
  const finalizer = args.dryRun ? undefined : buildFinalizer(args)
  caseLoop:
  for (const item of cases) {
    const answer = answerById.get(item.instance_id)
    if (!answer) throw new Error(`missing answer key for ${item.instance_id}`)
    for (const agent of args.agents) {
      if (stopReason) break caseLoop
      const caseRoot = join(runRoot, agent, item.instance_id)
      await mkdir(caseRoot, { recursive: true })
      const promptPath = join(caseRoot, 'prompt.txt')
      const responsePath = join(caseRoot, 'response.txt')
      const judgePromptPath = join(caseRoot, 'judge-prompt.txt')
      const judgeResponsePath = join(caseRoot, 'judge-response.txt')
      const resultPath = join(caseRoot, 'result.json')
      const workspaceRoot = join(caseRoot, 'workspace')
      await mkdir(workspaceRoot, { recursive: true })
      const prompt = QUERY_TEMPLATE.replace('{Question}', item.question)
      await writeFile(promptPath, prompt, 'utf8')
      if (args.dryRun) await writeFile(responsePath, '', 'utf8')

      const artifactRefs = [relativeToPortfolio(args.portfolioDir, promptPath), relativeToPortfolio(args.portfolioDir, responsePath)]
      let status: InstanceResult['status'] = 'not_run'
      let score = 0
      let errorType: string | null = null
      let runMetadata: AgentRunMetadata = { turnLimitHit: false }
      try {
        if (!args.dryRun) {
          runMetadata = await runAgent(agent, args, promptPath, responsePath, caseRoot, workspaceRoot)
          let response = await readFile(responsePath, 'utf8')
          if (runMetadata.turnLimitHit && !hasBrowseCompFinalAnswer(response)) {
            const finalized = await finalizeTurnLimitResponse({
              finalizer: finalizer!,
              question: item.question,
              response,
              transcriptPath: runMetadata.transcriptPath ?? join(caseRoot, 'agent-runlab-session.jsonl'),
              caseRoot,
              responsePath,
            })
            if (finalized) {
              response = finalized.response
              runMetadata = { ...runMetadata, finalizedAfterTurnLimit: true }
              artifactRefs.push(...finalized.artifactRefs.map((path) => relativeToPortfolio(args.portfolioDir, path)))
            }
          }
          const judgePrompt = GRADER_TEMPLATE
            .replace('{question}', item.question)
            .replace('{response}', response)
            .replace('{correct_answer}', answer.answer)
          await writeFile(judgePromptPath, judgePrompt, 'utf8')
          artifactRefs.push(relativeToPortfolio(args.portfolioDir, judgePromptPath), relativeToPortfolio(args.portfolioDir, judgeResponsePath))
          const judgeResponse = await judge!.call({
            messages: [{ role: 'user', content: [{ type: 'text', text: judgePrompt }] }],
            tools: [],
            model: args.judgeModel,
          })
          const judgeText = judgeResponse.message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
          await writeFile(judgeResponsePath, judgeText, 'utf8')
          const correct = /correct:\s*yes/i.test(judgeText)
          status = correct ? 'resolved' : 'unresolved'
          score = correct ? 1 : 0
          if (runMetadata.turnLimitHit && status === 'unresolved') {
            errorType = 'turn_limit_best_effort'
          }
        }
      } catch (err: unknown) {
        status = 'error'
        score = 0
        errorType = classifyAgentError(agent, caseRoot, err)
        await writeFile(join(caseRoot, 'error.txt'), `${errorType}\n`, 'utf8')
        artifactRefs.push(relativeToPortfolio(args.portfolioDir, join(caseRoot, 'error.txt')))
      }
      const result: InstanceResult = {
        benchmark: 'browsecomp',
        instance_id: item.instance_id,
        agent,
        model: args.model,
        status,
        score,
        official: true,
        scorer: 'browsecomp.simple-evals.llm-judge',
        judge_model: args.judgeModel,
        error_type: errorType,
        artifact_refs: artifactRefs,
      }
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      instanceResults.push(result)
      stopReason = runStopReason(args, instanceResults)
      if (stopReason) break caseLoop
    }
  }

  await writeOutputs(args, runRoot, cases, instanceResults, stopReason)
}

async function runAgent(
  agent: AgentName,
  args: Args,
  promptPath: string,
  responsePath: string,
  caseRoot: string,
  workspaceRoot: string,
): Promise<AgentRunMetadata> {
  if (agent === 'agent-runlab') {
    const sessionLog = join(caseRoot, 'agent-runlab-session.jsonl')
    const metadataFile = join(caseRoot, 'agent-runlab-metadata.json')
    try {
      const result = await runCommand('pnpm', [
        '--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/run-agent-runlab-prompt.ts',
        '--prompt-file', promptPath,
        '--cwd', workspaceRoot,
        '--response-file', responsePath,
        '--session-log', sessionLog,
        '--metadata-file', metadataFile,
        '--sessions-dir', join(caseRoot, 'sessions'),
        '--artifacts-dir', join(caseRoot, 'artifacts'),
        '--model', args.model,
        '--system-prompt-preset', 'codex',
        '--timeout-ms', String(args.timeoutMs),
        '--max-turns', String(args.maxTurns),
        '--max-web-tool-calls', String(args.maxWebToolCalls),
      ], caseRoot, {
        ANTHROPIC_BASE_URL: args.baseUrl,
        ANTHROPIC_MODEL: args.model,
        ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
        HOST_MODEL: args.model,
        ...(process.env.SERPER_API_KEY ? { SERPER_API_KEY: process.env.SERPER_API_KEY } : {}),
      })
      return parseAgentRunMetadata(metadataFile, result.stdout)
    } catch (err) {
      const metadata = parseAgentRunMetadata(metadataFile, '')
      if (metadata.turnLimitHit) return metadata
      throw err
    }
  }
  const claudeArtifactsDir = join(caseRoot, 'claude-code-artifacts')
  try {
    await runCommand('pnpm', [
    '--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/run-claude-code-prompt.ts',
    '--prompt-file', promptPath,
    '--cwd', workspaceRoot,
    '--response-file', responsePath,
    '--artifacts-dir', claudeArtifactsDir,
    ...explicitBaseUrlArg(args),
    '--model', args.model,
    '--small-fast-model', args.smallFastModel,
    '--shared-web-tools',
    '--timeout-ms', String(args.timeoutMs),
    '--max-turns', String(args.maxTurns),
  ], caseRoot, {
    ANTHROPIC_BASE_URL: args.baseUrl,
    ANTHROPIC_MODEL: args.model,
    ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
  })
    return { turnLimitHit: false, transcriptPath: join(claudeArtifactsDir, 'claude-agent-sdk.messages.jsonl') }
  } catch (err) {
    const sdkResultPath = join(claudeArtifactsDir, 'claude-agent-sdk.result.json')
    if (classifyClaudeSdkResult(sdkResultPath) === 'max_turns') {
      return { turnLimitHit: true, transcriptPath: join(claudeArtifactsDir, 'claude-agent-sdk.messages.jsonl') }
    }
    throw err
  }
}

function classifyAgentError(agent: AgentName, caseRoot: string, err: unknown): string {
  if (agent === 'claude-code') {
    const sdkResultPath = join(caseRoot, 'claude-code-artifacts', 'claude-agent-sdk.result.json')
    const sdkError = classifyClaudeSdkResult(sdkResultPath)
    if (sdkError) return sdkError
  }
  return err instanceof Error ? err.message : String(err)
}

function classifyClaudeSdkResult(resultPath: string): string | null {
  if (!existsSync(resultPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      result?: {
        subtype?: unknown
        terminal_reason?: unknown
        errors?: unknown
      }
    }
    const subtype = typeof parsed.result?.subtype === 'string' ? parsed.result.subtype : ''
    const terminalReason = typeof parsed.result?.terminal_reason === 'string' ? parsed.result.terminal_reason : ''
    const errors = Array.isArray(parsed.result?.errors) ? parsed.result.errors.join('\n') : ''
    if (subtype === 'error_max_turns' || terminalReason === 'max_turns' || /maximum number of turns/i.test(errors)) {
      return 'max_turns'
    }
    if (subtype) return subtype
  } catch {
    return null
  }
  return null
}

function buildJudge(args: Args): LLMAdapter {
  const apiKey = args.judgeProvider === 'anthropic'
    ? resolveAnthropicApiKey()
    : process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error(`missing ${args.judgeProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} for BrowseComp judge`)
  if (args.judgeProvider === 'anthropic') {
    return anthropicAdapter({
      apiKey,
      model: args.judgeModel,
      ...(args.judgeBaseUrl ? { apiUrl: joinPath(args.judgeBaseUrl, '/messages') } : {}),
    })
  }
  return openaiAdapter({
    apiKey,
    model: args.judgeModel,
    ...(args.judgeBaseUrl ? { baseUrl: args.judgeBaseUrl } : {}),
  })
}

function buildFinalizer(args: Args): LLMAdapter {
  if (args.judgeProvider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('missing OPENAI_API_KEY for BrowseComp turn-limit finalizer')
    return openaiAdapter({
      apiKey,
      model: args.model,
      baseUrl: args.baseUrl,
    })
  }
  const apiKey = resolveAnthropicApiKey()
  if (!apiKey) throw new Error('missing ANTHROPIC_API_KEY for BrowseComp turn-limit finalizer')
  return anthropicAdapter({
    apiKey,
    model: args.model,
    apiUrl: joinPath(args.baseUrl, '/messages'),
  })
}

async function finalizeTurnLimitResponse(opts: {
  finalizer: LLMAdapter
  question: string
  response: string
  transcriptPath: string
  caseRoot: string
  responsePath: string
}): Promise<{ response: string; artifactRefs: string[] } | null> {
  const rawResponsePath = join(opts.caseRoot, 'response.raw.txt')
  const finalizerPromptPath = join(opts.caseRoot, 'turn-limit-finalizer-prompt.txt')
  const finalizerResponsePath = join(opts.caseRoot, 'turn-limit-finalizer-response.txt')
  const transcript = extractTranscriptExcerpt(opts.transcriptPath, 24_000)
  if (!transcript.trim()) return null
  await writeFile(rawResponsePath, opts.response, 'utf8')
  const prompt = FINALIZER_TEMPLATE
    .replace('{question}', opts.question)
    .replace('{response}', opts.response || '(empty)')
    .replace('{transcript}', transcript)
  await writeFile(finalizerPromptPath, prompt, 'utf8')
  const result = await opts.finalizer.call({
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
  })
  const finalized = result.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
  await writeFile(finalizerResponsePath, finalized, 'utf8')
  if (!hasBrowseCompFinalAnswer(finalized)) return { response: opts.response, artifactRefs: [rawResponsePath, finalizerPromptPath, finalizerResponsePath] }
  await writeFile(opts.responsePath, finalized, 'utf8')
  return { response: finalized, artifactRefs: [rawResponsePath, finalizerPromptPath, finalizerResponsePath] }
}

function hasBrowseCompFinalAnswer(response: string): boolean {
  return /^Exact Answer:\s*(?!\s*$).+/im.test(response)
}

function extractTranscriptExcerpt(sessionLog: string, maxChars: number): string {
  if (!existsSync(sessionLog)) return ''
  const lines: string[] = []
  for (const line of readFileSync(sessionLog, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const rendered = renderTranscriptLine(parsed)
    if (rendered) lines.push(rendered)
  }
  const full = lines.join('\n\n')
  if (full.length <= maxChars) return full
  return full.slice(full.length - maxChars)
}

function renderTranscriptLine(parsed: unknown): string {
  const entry = parsed as { kind?: unknown; seq?: unknown; event?: Record<string, unknown>; type?: unknown; message?: Record<string, unknown>; subtype?: unknown; content?: unknown }
  if (entry.kind === 'event' && entry.event) return renderAgentRunlabTranscriptLine(entry)
  if (entry.type === 'assistant' && entry.message) {
    const parts = Array.isArray(entry.message.content) ? entry.message.content : []
    const rendered = parts.map(renderMessagePart).filter(Boolean).join('\n')
    return rendered ? `claude assistant:\n${rendered}` : ''
  }
  if (entry.type === 'user' && entry.message) {
    const parts = Array.isArray(entry.message.content) ? entry.message.content : []
    const rendered = parts.map(renderClaudeUserPart).filter(Boolean).join('\n')
    return rendered ? `claude tool_result:\n${rendered}` : ''
  }
  if (entry.type === 'result') {
    return `claude result: ${truncate(JSON.stringify(entry), 1200)}`
  }
  return ''
}

function renderAgentRunlabTranscriptLine(entry: { kind?: unknown; seq?: unknown; event?: Record<string, unknown> }): string {
  if (!entry.event) return ''
  const seq = typeof entry.seq === 'number' ? entry.seq : '?'
  const eventKind = entry.event.kind
  if (eventKind === 'llm_response') {
    const message = entry.event.message as { content?: unknown } | undefined
    const parts = Array.isArray(message?.content) ? message.content : []
    const rendered = parts.map(renderMessagePart).filter(Boolean).join('\n')
    return rendered ? `seq ${seq} assistant:\n${rendered}` : ''
  }
  if (eventKind === 'tool_result') {
    const ok = entry.event.ok === true ? 'ok' : 'error'
    const content = typeof entry.event.content === 'string' ? entry.event.content : ''
    return `seq ${seq} tool_result (${ok}):\n${truncate(content, 1800)}`
  }
  return ''
}

function renderClaudeUserPart(part: unknown): string {
  const block = part as { type?: unknown; content?: unknown; is_error?: unknown }
  if (block.type !== 'tool_result') return ''
  const ok = block.is_error === true ? 'error' : 'ok'
  return `(${ok}) ${truncate(String(block.content ?? ''), 1800)}`
}

function renderMessagePart(part: unknown): string {
  const block = part as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }
  if (block.type === 'text' && typeof block.text === 'string') return truncate(block.text, 1200)
  if (block.type === 'tool_call' || block.type === 'tool_use') {
    const input = typeof block.input === 'object' && block.input ? JSON.stringify(block.input) : ''
    return `tool_call ${String(block.name ?? '')} ${truncate(input, 500)}`
  }
  return ''
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated]`
}

async function writeOutputs(
  args: Args,
  runRoot: string,
  cases: readonly BrowseCompCase[],
  results: readonly InstanceResult[],
  stopReason: string | null,
): Promise<void> {
  const gradingDir = join(args.portfolioDir, 'artifacts', 'browsecomp', 'grading')
  await mkdir(gradingDir, { recursive: true })
  const instanceResults = results.map((row) => JSON.stringify(row)).join('\n') + (results.length ? '\n' : '')
  await writeFile(join(runRoot, 'instance-results.jsonl'), instanceResults, 'utf8')
  const byAgent = new Map<AgentName, InstanceResult[]>()
  for (const result of results) {
    byAgent.set(result.agent, [...(byAgent.get(result.agent) ?? []), result])
  }
  const completedRequestedRun = !args.dryRun && results.length === cases.length * args.agents.length
  const summary = {
    schema_version: 1,
    benchmark: 'browsecomp',
    run_id: args.runId,
    status: args.dryRun ? 'dry_run' : completedRequestedRun ? 'completed' : stopReason ? 'partial_stopped' : 'completed',
    stop_reason: stopReason,
    selected_cases: cases.length,
    completed_agent_runs: args.dryRun ? 0 : results.length,
    planned_agent_runs: args.dryRun ? results.length : undefined,
    requested_agent_runs: cases.length * args.agents.length,
    model: args.model,
    judge_model: args.judgeModel,
    scorer: 'browsecomp.simple-evals.llm-judge',
    agents: Object.fromEntries([...byAgent.entries()].map(([agent, rows]) => [agent, {
      attempted: rows.length,
      resolved: rows.filter((row) => row.status === 'resolved').length,
      unresolved: rows.filter((row) => row.status === 'unresolved').length,
      errors: rows.filter((row) => row.status === 'error').length,
      average_score: rows.length ? rows.reduce((sum, row) => sum + row.score, 0) / rows.length : 0,
    }])),
    run_root: relativeToPortfolio(args.portfolioDir, runRoot),
  }
  await writeFile(join(runRoot, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  const shouldUpdateLatest = args.updateLatest && !args.dryRun && completedRequestedRun && hasBenchmarkLevelComparableRows(results)
  if (shouldUpdateLatest) {
    await writeFile(join(gradingDir, 'instance-results.jsonl'), instanceResults, 'utf8')
    await writeFile(join(gradingDir, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    await mkdir(join(args.portfolioDir, 'reports', 'browsecomp'), { recursive: true })
    await writeFile(join(args.portfolioDir, 'reports', 'browsecomp', 'latest-run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
  await writePairwise(args, runRoot, results, shouldUpdateLatest)
}

function hasBenchmarkLevelComparableRows(results: readonly InstanceResult[]): boolean {
  const byKey = new Map(results.map((row) => [`${row.instance_id}:${row.agent}`, row]))
  const ids = [...new Set(results.map((row) => row.instance_id))]
  if (ids.length === 0) return false
  return ids.every((id) => {
    const agent = byKey.get(`${id}:agent-runlab`)
    const claude = byKey.get(`${id}:claude-code`)
    return isJudgeable(agent) && isJudgeable(claude)
  })
}

function isJudgeable(row: InstanceResult | undefined): boolean {
  return row?.status === 'resolved' || row?.status === 'unresolved'
}

async function writePairwise(args: Args, runRoot: string, results: readonly InstanceResult[], updateBenchmarkLevel: boolean): Promise<void> {
  const root = join(args.portfolioDir, 'artifacts', 'browsecomp')
  const byKey = new Map(results.map((row) => [`${row.instance_id}:${row.agent}`, row]))
  const ids = [...new Set(results.map((row) => row.instance_id))].sort()
  const rows = ids.map((id) => {
    const agent = byKey.get(`${id}:agent-runlab`)
    const claude = byKey.get(`${id}:claude-code`)
    const winner = winnerFor(agent, claude)
    return {
      benchmark: 'browsecomp',
      instance_id: id,
      task_type: 'web_research_exact_answer',
      model: args.model,
      agent_runlab_status: agent?.status ?? 'not_run',
      claude_code_status: claude?.status ?? 'not_run',
      agent_runlab_score: String(agent?.score ?? 0),
      claude_code_score: String(claude?.score ?? 0),
      winner,
      agent_artifact: agent?.artifact_refs.join(';') ?? '',
      claude_artifact: claude?.artifact_refs.join(';') ?? '',
      grader_report: 'artifacts/browsecomp/grading/instance-results.jsonl',
      failure_category: args.dryRun ? '' : pairwiseFailureCategory(agent, claude),
      notes: args.dryRun ? 'dry run only; no agent or judge call executed' : pairwiseNotes(agent, claude),
    }
  })
  const header = Object.keys(rows[0] ?? {
    benchmark: '', instance_id: '', task_type: '', model: '', agent_runlab_status: '', claude_code_status: '',
    agent_runlab_score: '', claude_code_score: '', winner: '', agent_artifact: '', claude_artifact: '', grader_report: '', failure_category: '', notes: '',
  })
  const csv = [header.join(','), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof typeof row]))).join(','))].join('\n') + '\n'
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  if (updateBenchmarkLevel) {
    const reportRoot = join(args.portfolioDir, 'reports', 'browsecomp')
    await mkdir(reportRoot, { recursive: true })
    await writeFile(join(reportRoot, 'pairwise-comparison.csv'), csv, 'utf8')
    await writeFile(join(reportRoot, 'pairwise-comparison.jsonl'), jsonl, 'utf8')
  }
  await writeFile(join(runRoot, 'pairwise-comparison.csv'), csv, 'utf8')
  await writeFile(join(runRoot, 'pairwise-comparison.jsonl'), jsonl, 'utf8')
}

function winnerFor(agent: InstanceResult | undefined, claude: InstanceResult | undefined): string {
  if (!agent || !claude) return 'not_comparable'
  if (agent.status === 'not_run' || claude.status === 'not_run') return 'not_comparable'
  if (agent.score > claude.score) return 'agent-runlab'
  if (claude.score > agent.score) return 'claude-code'
  if (agent.status === 'resolved' && claude.status === 'resolved') return 'tie_resolved'
  if (agent.status === 'unresolved' && claude.status === 'unresolved') return 'tie_unresolved'
  if (agent.status === 'error' && claude.status === 'error') return 'tie_error'
  return 'tie_score_mixed_status'
}

function runStopReason(args: Args, results: readonly InstanceResult[]): string | null {
  if (args.dryRun) return null
  if (args.maxAgentRuns !== undefined && results.length >= args.maxAgentRuns) {
    return `max_agent_runs:${args.maxAgentRuns}`
  }
  const errors = results.filter((row) => row.status === 'error').length
  if (args.stopAfterErrors !== undefined && errors >= args.stopAfterErrors) {
    return `stop_after_errors:${args.stopAfterErrors}`
  }
  const unresolved = results.filter((row) => row.status === 'unresolved').length
  if (args.stopAfterUnresolved !== undefined && unresolved >= args.stopAfterUnresolved) {
    return `stop_after_unresolved:${args.stopAfterUnresolved}`
  }
  const turnLimits = results.filter((row) => isTurnLimitResult(row)).length
  if (args.stopAfterTurnLimits !== undefined && turnLimits >= args.stopAfterTurnLimits) {
    return `stop_after_turn_limits:${args.stopAfterTurnLimits}`
  }
  return null
}

function isTurnLimitResult(row: InstanceResult): boolean {
  return row.error_type === 'turn_limit_best_effort'
    || row.error_type?.includes('max_turns') === true
    || row.error_type?.includes('maximum number of turns') === true
}

function pairwiseFailureCategory(agent: InstanceResult | undefined, claude: InstanceResult | undefined): string {
  const rows = [agent, claude].filter((row): row is InstanceResult => row !== undefined)
  if (!rows.length || rows.some((row) => row.status === 'not_run')) return 'not_comparable'
  if (rows.some(isTurnLimitResult)) return 'incomplete_execution'
  if (rows.some((row) => row.status === 'error')) return 'runner_infrastructure_error'
  if (rows.some((row) => row.status === 'unresolved')) return 'retrieval_or_answer_failure'
  return ''
}

function pairwiseNotes(agent: InstanceResult | undefined, claude: InstanceResult | undefined): string {
  if (!agent || !claude) return 'missing one side of pairwise comparison'
  if (agent.status === 'resolved' && claude.status === 'resolved') return 'both agents judged correct'
  if (agent.status === 'error' || claude.status === 'error') return 'one or both agent runs failed before judgeable output'
  if (isTurnLimitResult(agent) || isTurnLimitResult(claude)) return 'one or both agents hit the configured turn limit before a correct final answer'
  if (agent.status === 'unresolved' || claude.status === 'unresolved') return 'one or both agents produced a judgeable but incorrect answer'
  return ''
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  await mkdir(cwd, { recursive: true })
  const logPath = join(cwd, `${basename(args[4] ?? cmd)}-${createHash('sha1').update(args.join('\0')).digest('hex').slice(0, 8)}.log`)
  await writeFile(logPath, `$ ${cmd} ${args.join(' ')}\n`, 'utf8')
  let stdout = ''
  let stderr = ''
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      void append(logPath, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      void append(logPath, chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} exited with ${code}; see ${logPath}`))
    })
  })
  return { stdout, stderr }
}

function parseAgentRunMetadata(metadataFile: string, stdout: string): AgentRunMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataFile, 'utf8')) as { turnLimitHit?: unknown }
    return { turnLimitHit: parsed.turnLimitHit === true }
  } catch {
    for (const line of stdout.trim().split('\n').reverse()) {
      if (!line.trim().startsWith('{')) continue
      try {
        const parsed = JSON.parse(line) as { turnLimitHit?: unknown }
        return { turnLimitHit: parsed.turnLimitHit === true }
      } catch {
        continue
      }
    }
  }
  return { turnLimitHit: false }
}

function selectCases(allCases: readonly BrowseCompCase[], args: Args): BrowseCompCase[] {
  let selected = [...allCases]
  if (args.caseIds.length) {
    const byId = new Map(selected.map((item) => [item.instance_id, item]))
    selected = args.caseIds.map((id) => {
      const item = byId.get(id)
      if (!item) throw new Error(`case id not found in ${args.casesPath}: ${id}`)
      return item
    })
  } else {
    selected = selected.slice(args.offset)
  }
  if (args.limit !== undefined) selected = selected.slice(0, args.limit)
  return selected
}

async function append(path: string, chunk: Buffer): Promise<void> {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, chunk)
}

function joinPath(base: string, tail: string): string {
  const trimmed = base.replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function relativeToPortfolio(portfolioDir: string, path: string): string {
  return normalizeRelative(resolve(portfolioDir), resolve(path))
}

function normalizeRelative(from: string, to: string): string {
  let rel = to.startsWith(from) ? to.slice(from.length).replace(/^\/+/, '') : to
  rel = rel.replaceAll('\\', '/')
  return rel
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const portfolioDir = resolve(REPO_ROOT, value(argv, '--portfolio-dir') ?? 'experiments/evals/2026-07-agent-benchmark-comparison')
  const anthropicDefaults = loadAnthropicCliDefaults()
  const baseUrl = requireAnthropicBaseUrl({ explicit: value(argv, '--base-url'), defaults: anthropicDefaults })
  const model = value(argv, '--model') ?? anthropicDefaults.model ?? 'claude-sonnet-4-6'
  const agents = (value(argv, '--agents') ?? 'agent-runlab,claude-code')
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean) as AgentName[]
  for (const agent of agents) {
    if (agent !== 'agent-runlab' && agent !== 'claude-code') throw new Error(`unknown agent: ${agent}`)
  }
  const casesPath = resolve(value(argv, '--cases') ?? join(portfolioDir, 'planning/browsecomp/selected-cases.jsonl'))
  const answerKeyPath = resolve(value(argv, '--answer-key') ?? join(portfolioDir, 'artifacts/browsecomp/grading/answer-key.jsonl'))
  if (!existsSync(casesPath)) throw new Error(`cases file not found: ${casesPath}`)
  if (!existsSync(answerKeyPath)) throw new Error(`answer key not found: ${answerKeyPath}`)
  return {
    portfolioDir,
    casesPath,
    answerKeyPath,
    agents,
    model,
    baseUrl: baseUrl.baseUrl,
    baseUrlSource: baseUrl.source,
    smallFastModel: value(argv, '--small-fast-model') ?? anthropicDefaults.smallFastModel ?? 'claude-haiku-4-5',
    judgeProvider: value(argv, '--judge-provider') === 'openai' ? 'openai' : 'anthropic',
    judgeModel: value(argv, '--judge-model') ?? process.env.BROWSECOMP_JUDGE_MODEL ?? model,
    judgeBaseUrl: value(argv, '--judge-base-url') ?? process.env.BROWSECOMP_JUDGE_BASE_URL ?? baseUrl.baseUrl,
    limit: numberValue(argv, '--limit'),
    offset: numberValue(argv, '--offset', { allowZero: true }) ?? 0,
    caseIds: values(argv, '--case-id'),
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 30 * 60_000,
    maxTurns: numberValue(argv, '--max-turns') ?? 40,
    maxWebToolCalls: numberValue(argv, '--max-web-tool-calls') ?? 12,
    maxAgentRuns: numberValue(argv, '--max-agent-runs'),
    stopAfterErrors: numberValue(argv, '--stop-after-errors'),
    stopAfterUnresolved: numberValue(argv, '--stop-after-unresolved'),
    stopAfterTurnLimits: numberValue(argv, '--stop-after-turn-limits'),
    updateLatest: !hasFlag(argv, '--no-update-latest'),
    runId: value(argv, '--run-id') ?? `browsecomp-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    dryRun: hasFlag(argv, '--dry-run'),
  }
}

function explicitBaseUrlArg(args: Pick<Args, 'baseUrl' | 'baseUrlSource'>): string[] {
  return args.baseUrlSource === 'cli' ? ['--base-url', args.baseUrl] : []
}

function resolveAnthropicApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const settingsPath = join(process.env.HOME ?? '', '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return undefined
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { apiKeyHelper?: string; env?: { ANTHROPIC_API_KEY?: string; ANTHROPIC_AUTH_TOKEN?: string } }
  if (settings.env?.ANTHROPIC_API_KEY) return settings.env.ANTHROPIC_API_KEY
  if (settings.env?.ANTHROPIC_AUTH_TOKEN) return settings.env.ANTHROPIC_AUTH_TOKEN
  if (!settings.apiKeyHelper) return undefined
  return execSync(settings.apiKeyHelper, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function values(argv: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name && argv[i + 1]) out.push(argv[i + 1]!)
    else if (arg.startsWith(`${name}=`)) out.push(arg.slice(name.length + 1))
  }
  return out.flatMap((raw) => raw.split(',').map((item) => item.trim()).filter(Boolean))
}

function numberValue(argv: readonly string[], name: string, opts: { allowZero?: boolean } = {}): number | undefined {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  const min = opts.allowZero ? 0 : 1
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be ${opts.allowZero ? 'a non-negative' : 'a positive'} number`)
  return n
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
