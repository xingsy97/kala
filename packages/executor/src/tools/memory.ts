/**
 * Memory tools — a three-tier scratchpad the agent maintains for itself.
 *
 * Scope hierarchy (broadest → narrowest):
 *   - global    → ~/.agent-kernel/memory/<key>.md
 *                 shared across every workspace on this machine.
 *   - workspace → <firstSandboxRoot>/.agent-kernel/memory/<key>.md
 *                 shared across every session in this workspace.
 *                 (falls back to process.cwd()/.agent-kernel/memory when
 *                 no sandbox roots are configured — same rule the executor
 *                 uses for its own working directory)
 *   - session   → NOT on disk; the kernel intercepts the tool_result and
 *                 lifts the (key, content) into state.memory. Session
 *                 memory dies with the session (unless forked).
 *
 * The executor never touches state.memory itself — it just validates input
 * and returns an ack for scope='session'. Real state lift happens in the
 * kernel reducer (see kernel/src/core.ts, applyMemoryOp).
 *
 * Keys are constrained to /^[a-zA-Z0-9_-]{1,64}$/ to prevent path traversal
 * (no slashes, no dots) and to keep listings sortable/greppable.
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Tool, ToolContext } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { requireString } from './schema.js'

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_CONTENT_BYTES = 128 * 1024 // 128 KB per entry — memory is notes, not files
const VALID_SCOPES = new Set(['session', 'workspace', 'global'])

type Scope = 'session' | 'workspace' | 'global'

function requireScope(input: Record<string, unknown>): Scope {
  const scope = input['scope']
  if (typeof scope !== 'string' || !VALID_SCOPES.has(scope)) {
    throw new ToolError(
      'EINVAL',
      `field "scope" must be one of: session, workspace, global`,
    )
  }
  return scope as Scope
}

function requireKey(input: Record<string, unknown>): string {
  const key = requireString(input, 'key')
  if (!KEY_PATTERN.test(key)) {
    throw new ToolError(
      'EINVAL',
      `field "key" must match /^[a-zA-Z0-9_-]{1,64}$/ (got "${key}")`,
    )
  }
  return key
}

function memoryDirFor(scope: Exclude<Scope, 'session'>, ctx: ToolContext): string {
  if (scope === 'global') {
    return join(homedir(), '.agent-kernel', 'memory')
  }
  // workspace
  const roots = ctx.sandbox.roots
  const base = roots.length > 0 ? roots[0]! : process.cwd()
  return join(base, '.agent-kernel', 'memory')
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

// ----------------------------------------------------------------------------
// memory_read
// ----------------------------------------------------------------------------

export const memoryReadTool: Tool = {
  name: 'memory_read',
  async run(input, ctx) {
    const scope = requireScope(input)
    const keyRaw = input['key']
    // key optional: undefined means "list all keys in this scope"
    if (keyRaw === undefined) {
      return listKeys(scope, ctx)
    }
    const key = requireKey(input)

    if (scope === 'session') {
      // Session memory lives in kernel state, not on disk. The LLM can already
      // see state.memory inlined into messages; this branch exists so the tool
      // surface is symmetric across scopes. Just tell the LLM to look at state.
      return `Session-scope memory lives in state.memory (visible in the transcript). Key "${key}" is not on disk; ask the state view.`
    }

    const dir = memoryDirFor(scope, ctx)
    const file = join(dir, `${key}.md`)
    if (!existsSync(file)) {
      throw new ToolError('ENOENT', `no memory entry: scope=${scope} key=${key}`)
    }
    const content = await readFile(file, 'utf8')
    const s = await stat(file)
    return `--- scope=${scope} key=${key} updated=${s.mtime.toISOString()} ---\n${content}`
  },
}

async function listKeys(scope: Scope, ctx: ToolContext): Promise<string> {
  if (scope === 'session') {
    return `Session-scope memory lives in state.memory. Look at the state view for current entries.`
  }
  const dir = memoryDirFor(scope, ctx)
  if (!existsSync(dir)) {
    return `(empty — no memory entries at scope=${scope})`
  }
  const entries = await readdir(dir)
  const md = entries
    .filter((e) => e.endsWith('.md'))
    .map((e) => e.replace(/\.md$/, ''))
    .sort()
  if (md.length === 0) {
    return `(empty — no memory entries at scope=${scope})`
  }
  return `scope=${scope} keys:\n${md.map((k) => `  - ${k}`).join('\n')}`
}

// ----------------------------------------------------------------------------
// memory_write
// ----------------------------------------------------------------------------

export const memoryWriteTool: Tool = {
  name: 'memory_write',
  async run(input, ctx) {
    const scope = requireScope(input)
    const key = requireKey(input)
    const content = requireString(input, 'content')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_CONTENT_BYTES) {
      throw new ToolError(
        'E2BIG',
        `content exceeds memory entry cap (${bytes} bytes > ${MAX_CONTENT_BYTES})`,
      )
    }

    if (scope === 'session') {
      // Nothing to do on disk — the kernel reducer lifts (key, content) into
      // state.memory when this tool_result lands with ok=true. Just ack.
      return `session memory upserted: key="${key}" (${bytes} bytes)`
    }

    throwIfAborted(ctx)
    const dir = memoryDirFor(scope, ctx)
    await ensureDir(dir)
    throwIfAborted(ctx)
    const file = join(dir, `${key}.md`)
    const existed = existsSync(file)
    await writeFile(file, content, 'utf8')
    return existed
      ? `updated scope=${scope} key=${key} (${bytes} bytes)`
      : `created scope=${scope} key=${key} (${bytes} bytes)`
  },
}

// ----------------------------------------------------------------------------
// memory_delete
// ----------------------------------------------------------------------------

export const memoryDeleteTool: Tool = {
  name: 'memory_delete',
  async run(input, ctx) {
    const scope = requireScope(input)
    const key = requireKey(input)

    if (scope === 'session') {
      // Kernel reducer removes the entry from state.memory. Ack only.
      return `session memory removed: key="${key}"`
    }

    throwIfAborted(ctx)
    const dir = memoryDirFor(scope, ctx)
    const file = join(dir, `${key}.md`)
    if (!existsSync(file)) {
      // Idempotent delete — treat missing as success. LLMs sometimes retry.
      return `no-op: scope=${scope} key=${key} did not exist`
    }
    await unlink(file)
    return `deleted scope=${scope} key=${key}`
  },
}
