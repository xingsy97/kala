import type { ToolExecutionResult } from '../agent-modules/execution.js'
import { decideNetworkPolicy, type NetworkPolicy } from '@agent-kernel/shared'
import type { AuditLogger } from '../audit-log.js'
import { ulid } from 'ulid'

const SERPER_SEARCH_URL = 'https://google.serper.dev/search'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const SNIPPET_MAX_CHARS = 500

export interface WebSearchCredentialStore {
  get(provider: 'serper'): Promise<string | undefined> | string | undefined
}

export type WebSearchOptions = {
  credentials: WebSearchCredentialStore
  fetchImpl?: typeof fetch
  timeoutMs?: number
  sessionId?: string
  callId?: string
  audit?: AuditLogger
  networkPolicy?: NetworkPolicy
}

type SearchResult = { title: string; url: string; snippet: string }

export async function runWebSearch(
  input: Record<string, unknown>,
  options: WebSearchOptions,
): Promise<ToolExecutionResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) return failure('EINVAL', 'query must be a non-empty string', 'input', 'model', false)

  const requestedLimit = input.limit === undefined ? DEFAULT_LIMIT : input.limit
  if (!Number.isInteger(requestedLimit) || (requestedLimit as number) <= 0) {
    return failure('EINVAL', 'limit must be a positive integer', 'input', 'model', false)
  }
  const limit = Math.min(requestedLimit as number, MAX_LIMIT)
  const apiKey = await options.credentials.get('serper')
  if (!apiKey) {
    return failure('ESEARCH_CREDENTIAL', 'web search credential is not configured', 'precondition', 'user', false)
  }

  const policy = options.networkPolicy ?? { version: 1 as const, policyId: 'host-default', revision: '1', defaultAction: 'allow' as const, rules: [] }
  const decision = decideNetworkPolicy(policy, { toolName: 'websearch', executionLocation: 'host', url: SERPER_SEARCH_URL })
  const decisionId = ulid()
  options.audit?.log({ action: 'network.policy_decision', actor: { kind: 'system' }, target: { sessionId: options.sessionId, callId: options.callId, toolName: 'websearch', target: decision.target }, outcome: decision.action === 'allow' ? 'ok' : 'denied', refs: { decisionId, policyId: policy.policyId, policyRevision: policy.revision }, metadata: { evidenceLevel: 'declared', enforcementMode: 'application', matchedRuleId: decision.matchedRuleId } })
  if (decision.action !== 'allow') return failure('ENETWORKPOLICY', `network target ${decision.action} by policy`, 'precondition', 'user', false)
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    options.audit?.log({ action: 'network.request_observed', actor: { kind: 'system' }, target: { sessionId: options.sessionId, callId: options.callId, toolName: 'websearch', target: decision.target }, outcome: 'ok', refs: { decisionId }, metadata: { evidenceLevel: 'application_observed', enforcementMode: 'application', phase: 'started' } })
    const response = await (options.fetchImpl ?? fetch)(SERPER_SEARCH_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: query, num: limit }),
      signal: controller.signal,
    })
    options.audit?.log({ action: 'network.request_observed', actor: { kind: 'system' }, target: { sessionId: options.sessionId, callId: options.callId, toolName: 'websearch', target: decision.target }, outcome: response.ok ? 'ok' : 'error', refs: { decisionId }, metadata: { evidenceLevel: 'application_observed', enforcementMode: 'application', phase: 'response', statusCode: response.status } })
    if (!response.ok) {
      return failure('EHTTP', `Serper returned HTTP ${response.status}`, 'infrastructure', 'provider', response.status >= 500)
    }
    const body = await response.json() as {
      organic?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }>
    }
    const results = (body.organic ?? [])
      .map((item): SearchResult => ({
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.link === 'string' ? item.link : '',
        snippet: truncate(typeof item.snippet === 'string' ? item.snippet : ''),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, limit)
    return { ok: true, content: formatResults(query, results) }
  } catch (error) {
    if (controller.signal.aborted) {
      return failure('ETIMEDOUT', `search timed out after ${timeoutMs}ms`, 'infrastructure', 'provider', true, 'timeout')
    }
    const message = error instanceof Error ? error.message : String(error)
    return failure('ENETWORK', `search failed: ${message}`, 'infrastructure', 'provider', true)
  } finally {
    clearTimeout(timer)
  }
}

function truncate(value: string): string {
  return value.length > SNIPPET_MAX_CHARS ? `${value.slice(0, SNIPPET_MAX_CHARS - 3)}...` : value
}

function formatResults(query: string, results: readonly SearchResult[]): string {
  if (results.length === 0) return `No results for: ${query}`
  const body = results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`]
    if (result.snippet) lines.push(`   ${result.snippet}`)
    return lines.join('\n')
  }).join('\n\n')
  return `Web search results for: ${query}\n\n${body}`
}

function failure(
  code: string,
  content: string,
  category: 'input' | 'precondition' | 'infrastructure',
  responsibility: 'model' | 'provider' | 'user',
  retryable: boolean,
  outcome: 'blocked' | 'failed' | 'timeout' = category === 'precondition' ? 'blocked' : 'failed',
): ToolExecutionResult {
  return { ok: false, content, failure: { code, category, outcome, retryable, responsibility } }
}
