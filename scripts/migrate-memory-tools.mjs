#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sessionsDir = process.argv[2] ?? join(homedir(), '.agent-kernel', 'sessions')

const memorySchema = {
  name: 'memory',
  description:
    'Read, list, write, or delete the agent\'s persistent notepad. Use operation=`list` to list keys, `read` to fetch one entry, `write` to upsert, and `delete` to remove. Scopes: `session` (in AgentState, forkable), `workspace` (on disk in this workspace), `global` (on disk for this machine).',
  inputSchema: {
    type: 'object',
    required: ['operation', 'scope'],
    properties: {
      operation: { type: 'string', enum: ['list', 'read', 'write', 'delete'] },
      scope: { type: 'string', enum: ['session', 'workspace', 'global'] },
      key: {
        type: 'string',
        description: 'Required for read/write/delete. Pattern: ^[a-zA-Z0-9_-]{1,64}$.',
      },
      content: {
        type: 'string',
        description: 'Required for write. Text/markdown content, capped at 128 KB per entry.',
      },
      updatedAt: {
        type: 'string',
        description:
          'ISO-8601 timestamp for session-scope writes. The kernel uses this when lifting memory into AgentState.',
      },
    },
  },
  requiresApproval: false,
}

const oldNames = new Set(['memory_read', 'memory_write', 'memory_delete'])

function normalizeToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools
  let changed = false
  let sawOld = false
  let sawMemory = false
  const next = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      next.push(tool)
      continue
    }
    if (tool.name === 'memory') {
      sawMemory = true
      next.push(tool)
      continue
    }
    if (oldNames.has(tool.name)) {
      sawOld = true
      changed = true
      continue
    }
    next.push(tool)
  }
  if (sawOld && !sawMemory) next.push(memorySchema)
  return changed ? next : tools
}

function normalizeInput(name, input) {
  const base = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {}
  if (name === 'memory_read') {
    return { ...base, operation: typeof base.key === 'string' ? 'read' : 'list' }
  }
  if (name === 'memory_write') return { ...base, operation: 'write' }
  if (name === 'memory_delete') return { ...base, operation: 'delete' }
  return input
}

function normalizeNode(value) {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const normalized = normalizeNode(item)
      if (normalized !== item) changed = true
      return normalized
    })
    return changed ? next : value
  }
  if (!value || typeof value !== 'object') return value

  let changed = false
  const next = { ...value }

  if ('tools' in next) {
    const tools = normalizeToolSchemas(next.tools)
    if (tools !== next.tools) {
      next.tools = tools
      changed = true
    }
  }

  if (typeof next.name === 'string' && oldNames.has(next.name)) {
    next.input = normalizeInput(next.name, next.input)
    next.name = 'memory'
    changed = true
  }

  if (typeof next.toolName === 'string' && oldNames.has(next.toolName)) {
    next.input = normalizeInput(next.toolName, next.input)
    next.toolName = 'memory'
    changed = true
  }

  for (const [key, child] of Object.entries(next)) {
    const normalized = normalizeNode(child)
    if (normalized !== child) {
      next[key] = normalized
      changed = true
    }
  }

  return changed ? next : value
}

if (!existsSync(sessionsDir)) {
  console.log(`sessions dir not found: ${sessionsDir}`)
  process.exit(0)
}

let filesChanged = 0
for (const file of readdirSync(sessionsDir)) {
  if (!file.endsWith('.jsonl')) continue
  const path = join(sessionsDir, file)
  const raw = readFileSync(path, 'utf8')
  if (!raw.includes('memory_read') && !raw.includes('memory_write') && !raw.includes('memory_delete')) {
    continue
  }
  const lines = raw.split('\n')
  const normalized = []
  let changed = false
  for (const line of lines) {
    if (line.trim().length === 0) {
      normalized.push(line)
      continue
    }
    const parsed = JSON.parse(line)
    const next = normalizeNode(parsed)
    normalized.push(JSON.stringify(next))
    if (next !== parsed) changed = true
  }
  if (!changed) continue
  const backup = `${path}.bak-memory-tools`
  if (!existsSync(backup)) writeFileSync(backup, raw, 'utf8')
  writeFileSync(path, normalized.join('\n'), 'utf8')
  filesChanged++
  console.log(`migrated ${path}`)
}

console.log(`memory tool migration complete: ${filesChanged} file(s) changed`)
