import type { GroupedToolRenderer } from './renderer.js'
import { countLines, firstLine, genericRenderer, truncate } from './renderer.js'

const asString = (v: unknown): string =>
  typeof v === 'string' ? v : v == null ? '' : String(v)

export const bashRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const cmd = asString(c.input.command)
    const r = results.get(c.callId)
    return {
      callId: c.callId,
      primary: truncate(firstLine(cmd), 96),
      ...(r ? { secondary: r.ok ? 'ok' : 'failed' } : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const readRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.file_path ?? c.input.path)
    const r = results.get(c.callId)
    const lines = r?.ok ? countLines(r.content) : 0
    return {
      callId: c.callId,
      primary: path || c.callId,
      ...(r ? { secondary: r.ok ? `${lines} lines` : 'failed' } : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const writeRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.file_path ?? c.input.path)
    const content = asString(c.input.content)
    const lines = content.length ? countLines(content) : 0
    const r = results.get(c.callId)
    return {
      callId: c.callId,
      primary: path || c.callId,
      ...(lines > 0
        ? { secondary: `${lines} lines${r && !r.ok ? ' · failed' : ''}` }
        : r
          ? { secondary: r.ok ? 'ok' : 'failed' }
          : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const editRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.file_path ?? c.input.path)
    const r = results.get(c.callId)
    return {
      callId: c.callId,
      primary: path || c.callId,
      ...(r ? { secondary: r.ok ? 'edited' : 'failed' } : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const grepRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const pattern = asString(c.input.pattern)
    const path = asString(c.input.path)
    const r = results.get(c.callId)
    let hits = 0
    if (r?.ok) {
      const filler = r.content.trim()
      if (filler.length > 0 && !filler.startsWith('...')) {
        hits = filler.split('\n').filter((l) => !l.startsWith('...')).length
      }
    }
    const secondary = r
      ? r.ok
        ? `${hits} hit${hits === 1 ? '' : 's'}${path ? ` in ${truncate(path, 40)}` : ''}`
        : 'failed'
      : undefined
    return {
      callId: c.callId,
      primary: `/${truncate(pattern, 80)}/`,
      ...(secondary !== undefined ? { secondary } : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const globRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const pattern = asString(c.input.pattern ?? c.input.glob)
    const r = results.get(c.callId)
    const matches = r?.ok
      ? r.content.trim().length === 0
        ? 0
        : r.content.trim().split('\n').filter((l) => !l.startsWith('...')).length
      : 0
    return {
      callId: c.callId,
      primary: truncate(pattern, 96),
      ...(r
        ? { secondary: r.ok ? `${matches} match${matches === 1 ? '' : 'es'}` : 'failed' }
        : {}),
      ok: r ? r.ok : true,
    }
  })
}

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

const isTodoItem = (v: unknown): v is TodoItem =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Record<string, unknown>).content === 'string' &&
  typeof (v as Record<string, unknown>).status === 'string'

export const todowriteRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const todos = Array.isArray(c.input.todos)
      ? (c.input.todos as unknown[]).filter(isTodoItem)
      : []
    const inProgress = todos.find((t) => t.status === 'in_progress')
    const completed = todos.filter((t) => t.status === 'completed').length
    const total = todos.length
    const label = total === 0
      ? 'empty todo list'
      : inProgress
        ? truncate(firstLine(inProgress.content), 96)
        : `${total} item${total === 1 ? '' : 's'}`
    const r = results.get(c.callId)
    const secondary = total === 0
      ? undefined
      : `${completed}/${total} done`
    return {
      callId: c.callId,
      primary: label,
      ...(secondary !== undefined ? { secondary } : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const lsRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.path ?? '.')
    const r = results.get(c.callId)
    const entries = r?.ok
      ? r.content.trim().length === 0
        ? 0
        : r.content.trim().split('\n').length
      : 0
    return {
      callId: c.callId,
      primary: path,
      ...(r ? { secondary: r.ok ? `${entries} entries` : 'failed' } : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const RENDERERS: Record<string, GroupedToolRenderer> = {
  bash: bashRenderer,
  read: readRenderer,
  write: writeRenderer,
  edit: editRenderer,
  grep: grepRenderer,
  glob: globRenderer,
  ls: lsRenderer,
  todowrite: todowriteRenderer,
}

export function pickRenderer(toolName: string): GroupedToolRenderer {
  return RENDERERS[toolName] ?? genericRenderer
}
