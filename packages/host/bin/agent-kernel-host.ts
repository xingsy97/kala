#!/usr/bin/env node
/**
 * `agent-kernel-host` CLI.
 *
 * Reads:
 *   LLM_PROVIDER        -  "anthropic" (default) or "openai"
 *   HOST_PORT           -  default 3000
 *   SESSIONS_DIR        -  default ~/.agent-kernel/sessions
 *   HOST_AUTH_TOKEN     -  optional; when set, clients must supply it in auth
 *   HOST_MODEL          -  model id; defaults to a provider-appropriate value
 *
 * Anthropic provider:
 *   ANTHROPIC_API_KEY   -  required
 *
 * OpenAI-compatible provider (works with self-hosted gateways too):
 *   OPENAI_API_KEY      -  required
 *   OPENAI_BASE_URL     -  default https://api.openai.com/v1
 *
 * Runs until SIGINT/SIGTERM.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { builtinTools } from '../src/builtin-tools.js'
import { startHostServer } from '../src/server.js'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

async function main(): Promise<void> {
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
  const llm = buildAdapter(provider)

  const port = Number(process.env.HOST_PORT ?? 3000)
  const sessionsDir =
    process.env.SESSIONS_DIR ?? join(homedir(), '.agent-kernel', 'sessions')

  const server = await startHostServer({
    port,
    sessionsDir,
    llm,
    defaultConfig: {
      tools: [...builtinTools],
      systemPrompt: 'You are a coding agent running via agent-kernel.',
    },
    ...(process.env.HOST_AUTH_TOKEN
      ? { authToken: process.env.HOST_AUTH_TOKEN }
      : {}),
  })

  console.log(`agent-kernel-host listening on port ${server.port}`)
  console.log(`sessions dir: ${sessionsDir}`)
  console.log(`llm: ${llm.name}`)

  const shutdown = async (): Promise<void> => {
    console.log('shutting down...')
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function buildAdapter(provider: string): LLMAdapter {
  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) fail('ANTHROPIC_API_KEY is required for LLM_PROVIDER=anthropic')
    return anthropicAdapter({
      apiKey,
      model: process.env.HOST_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    })
  }
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) fail('OPENAI_API_KEY is required for LLM_PROVIDER=openai')
    return openaiAdapter({
      apiKey,
      model: process.env.HOST_MODEL ?? DEFAULT_OPENAI_MODEL,
      ...(process.env.OPENAI_BASE_URL
        ? { baseUrl: process.env.OPENAI_BASE_URL }
        : {}),
    })
  }
  fail(`Unknown LLM_PROVIDER: ${provider} (expected "anthropic" or "openai")`)
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
