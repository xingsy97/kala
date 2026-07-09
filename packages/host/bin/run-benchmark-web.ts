#!/usr/bin/env tsx
import process from 'node:process'

import { allTools, createSandbox } from '@agent-kernel/executor'
import type { Tool } from '@agent-kernel/executor'

type Args = {
  command: 'search' | 'fetch'
  query?: string
  url?: string
  limit?: number
  maxChars?: number
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const controller = new AbortController()
  const sandbox = createSandbox({ roots: [process.cwd()] })
  const ctx = {
    sessionId: `benchmark-web-${Date.now()}`,
    sandbox,
    signal: controller.signal,
    cwd: process.cwd(),
    env: process.env,
  }
  const websearchTool = requireTool('websearch')
  const webfetchTool = requireTool('webfetch')
  const result = args.command === 'search'
    ? await websearchTool.run({ query: args.query, limit: args.limit }, ctx)
    : await webfetchTool.run({ url: args.url, maxChars: args.maxChars }, ctx)
  process.stdout.write(`${result}\n`)
}

function requireTool(name: string): Tool {
  const tool = allTools.find((item) => item.name === name)
  if (!tool) throw new Error(`missing executor tool: ${name}`)
  return tool
}

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0]
  if (command !== 'search' && command !== 'fetch') {
    throw new Error('usage: benchmark-web search --query <query> [--limit <n>] | benchmark-web fetch --url <url> [--max-chars <n>]')
  }
  if (command === 'search') {
    const query = value(argv, '--query')
    if (!query) throw new Error('missing --query')
    return { command, query, limit: numberValue(argv, '--limit') }
  }
  const url = value(argv, '--url')
  if (!url) throw new Error('missing --url')
  return { command, url, maxChars: numberValue(argv, '--max-chars') }
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function numberValue(argv: readonly string[], name: string): number | undefined {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
