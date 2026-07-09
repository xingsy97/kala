#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))

if (!existsSync(args.workspace)) {
  fail(`workspace not found: ${args.workspace}`)
}
await mkdir(dirname(args.output), { recursive: true })

const tarArgs = [
  '--create',
  '--gzip',
  '--file', args.output,
  '--directory', args.workspace,
  '--exclude=.git',
  '--exclude=.agent-kernel',
  '--exclude=.claude',
  '--exclude=.codex',
  '--exclude=node_modules',
  '--exclude=__pycache__',
  '--exclude=.pytest_cache',
  '--exclude=.mypy_cache',
  '--exclude=.ruff_cache',
  '--exclude=.cache',
  '--exclude=executable',
  '--exclude=agent-runlab-session.jsonl',
  '--exclude=claude-agent-sdk.messages.jsonl',
  '--exclude=claude-agent-sdk.debug.log',
  '.',
]

const result = spawnSync('tar', tarArgs, { stdio: 'inherit' })
if (result.error) fail(result.error.message)
if (result.status !== 0) fail(`tar exited with ${result.status}`)

console.log(JSON.stringify({ workspace: args.workspace, output: args.output }, null, 2))

function parseArgs(argv) {
  const workspace = value(argv, '--workspace')
  const output = value(argv, '--output')
  if (!workspace) fail('missing --workspace')
  if (!output) fail('missing --output')
  return { workspace: resolve(workspace), output: resolve(output) }
}

function value(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
