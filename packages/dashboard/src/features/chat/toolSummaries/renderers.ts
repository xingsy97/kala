import type { GroupedToolRenderer, SummaryDelta } from './renderer.js'
import { countLines, firstLine, genericRenderer, truncate } from './renderer.js'

const asString = (v: unknown): string =>
  typeof v === 'string' ? v : v == null ? '' : String(v)

export const bashRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const cmd = asString(c.input.command ?? c.input.cmd)
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

export const readFilesRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const files = Array.isArray(c.input.files) ? c.input.files : []
    const first = files.find((file): file is Record<string, unknown> => !!file && typeof file === 'object')
    const firstPath = asString(first?.path)
    const r = results.get(c.callId)
    return {
      callId: c.callId,
      primary: firstPath ? truncate(firstPath, 96) : `${files.length} files`,
      ...(r ? { secondary: r.ok ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'failed' } : {}),
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
    const mutation = r?.ok ? mutationStats(r.content) : null
    return {
      callId: c.callId,
      primary: path || c.callId,
      ...(mutation
        ? { secondary: mutation }
        : lines > 0
          ? { secondary: `${lines} lines${r && !r.ok ? ' · failed' : ''}` }
          : r
            ? { secondary: r.ok ? 'ok' : 'failed' }
            : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const replaceRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.file_path ?? c.input.path)
    const r = results.get(c.callId)
    const mutation = r?.ok ? mutationStats(r.content) : null
    return {
      callId: c.callId,
      primary: path || c.callId,
      ...(r
        ? { secondary: r.ok ? (mutation ?? 'edited') : 'failed' }
        : {}),
      ok: r ? r.ok : true,
    }
  })
}

export const multiReplaceRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.file_path ?? c.input.path)
    const edits = Array.isArray(c.input.edits) ? c.input.edits.length : 0
    const r = results.get(c.callId)
    const mutation = r?.ok ? mutationStats(r.content) : null
    return {
      callId: c.callId,
      primary: path || c.callId,
      secondary: r
        ? (r.ok ? (mutation ?? `${edits} edit${edits === 1 ? '' : 's'}`) : 'failed')
        : `${edits} edit${edits === 1 ? '' : 's'}`,
      ok: r ? r.ok : true,
    }
  })
}

export const patchRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const patch = asString(c.input.patch)
    const target = patch.split('\n').map((line) => /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)?.[1]).find(Boolean)
    const r = results.get(c.callId)
    const mutation = r?.ok ? mutationStats(r.content) : null
    return {
      callId: c.callId,
      primary: truncate(target ?? 'patch', 96),
      ...(r ? { secondary: r.ok ? (mutation ?? 'applied') : 'failed' } : {}),
      ok: r ? r.ok : true,
    }
  })
}

function mutationStats(content: string): SummaryDelta | null {
  try {
    const value = JSON.parse(content) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const files = (value as Record<string, unknown>).files
    if (!Array.isArray(files) || files.length === 0) return null
    let additions = 0
    let deletions = 0
    let sawStats = false
    for (const file of files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) continue
      const record = file as Record<string, unknown>
      if (typeof record.additions === 'number' && Number.isFinite(record.additions)) {
        additions += record.additions
        sawStats = true
      }
      if (typeof record.deletions === 'number' && Number.isFinite(record.deletions)) {
        deletions += record.deletions
        sawStats = true
      }
    }
    return sawStats ? { kind: 'delta', additions, deletions } : null
  } catch {
    return null
  }
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

export const multiEditRenderer: GroupedToolRenderer = ({ calls, results }) => {
  return calls.map((c) => {
    const path = asString(c.input.file_path ?? c.input.path)
    const edits = Array.isArray(c.input.edits) ? c.input.edits.length : 0
    const r = results.get(c.callId)
    return {
      callId: c.callId,
      primary: path || c.callId,
      secondary: r ? (r.ok ? `${edits} edit${edits === 1 ? '' : 's'}` : 'failed') : `${edits} edit${edits === 1 ? '' : 's'}`,
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

export const todoGraphRenderer: GroupedToolRenderer = ({ calls, results }) => calls.map((call) => {
  const result = results.get(call.callId)
  let primary = 'Update task graph'
  let secondary: string | undefined
  if (result?.ok) {
    try {
      const snapshot = JSON.parse(result.content) as { summary?: { total?: number; completed?: number; active?: number; ready?: number; blocked?: number } }
      const summary = snapshot.summary
      if (summary) {
        primary = `${summary.total ?? 0} tasks · ${summary.active ?? 0} active`
        secondary = `${summary.completed ?? 0} done · ${summary.ready ?? 0} ready · ${summary.blocked ?? 0} blocked`
      }
    } catch { /* malformed results use the generic label */ }
  }
  return { callId: call.callId, primary, ...(secondary ? { secondary } : {}), ok: result ? result.ok : true }
})

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
  read_file: readRenderer,
  read_files: readFilesRenderer,
  write: writeRenderer,
  write_file: writeRenderer,
  edit: editRenderer,
  replace_in_file: replaceRenderer,
  replace_many_in_file: multiReplaceRenderer,
  apply_file_patch: patchRenderer,
  grep: grepRenderer,
  glob: globRenderer,
  ls: lsRenderer,
  todowrite: todowriteRenderer,
  todo_graph: todoGraphRenderer,
}

export function pickRenderer(toolName: string): GroupedToolRenderer {
  return RENDERERS[toolName] ?? genericRenderer
}
