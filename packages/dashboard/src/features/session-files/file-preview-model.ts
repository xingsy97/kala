export type PreviewKind = 'csv' | 'json' | 'jsonl' | 'yaml' | 'toml' | 'xml' | 'log' | 'diff' | 'markdown' | 'text'

export type PreviewModel =
  | { kind: 'table'; format: 'CSV' | 'TSV'; headers: string[]; rows: string[][]; omittedRows: number; omittedColumns: number; warnings: string[] }
  | { kind: 'records'; format: 'JSON' | 'JSONL'; rows: Array<{ path: string; value: string }>; omittedNodes: number; error?: string }
  | { kind: 'outline'; format: 'YAML' | 'TOML' | 'XML'; rows: Array<{ depth: number; key: string; value?: string }>; omittedNodes: number; error?: string }
  | { kind: 'log'; rows: Array<{ level: LogLevel; text: string }>; omittedRows: number }
  | { kind: 'diff'; rows: Array<{ type: 'meta' | 'hunk' | 'add' | 'delete' | 'context'; text: string }>; omittedRows: number }
  | { kind: 'source'; format: 'Markdown' | 'Text' }

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'other'

const MAX_ROWS = 1_000
const MAX_COLUMNS = 100
const MAX_NODES = 2_000
const MAX_CELL_CHARS = 10_000

export function detectPreviewKind(path: string, content: string): PreviewKind {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv') return 'csv'
  if (ext === 'tsv' || ext === 'tab') return 'csv'
  if (ext === 'json') return 'json'
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl'
  if (ext === 'yaml' || ext === 'yml') return 'yaml'
  if (ext === 'toml') return 'toml'
  if (ext === 'xml' || ext === 'svg') return 'xml'
  if (ext === 'log' || ext === 'out' || ext === 'trace') return 'log'
  if (ext === 'diff' || ext === 'patch') return 'diff'
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  const head = content.slice(0, 2_048).trimStart()
  if (/^(?:diff --git |--- .+\n\+\+\+ |@@ )/u.test(head)) return 'diff'
  if ((head.startsWith('{') || head.startsWith('[')) && safeJson(content)) return 'json'
  return 'text'
}

export function buildPreviewModel(path: string, contentInput: string): PreviewModel {
  const content = contentInput.replace(/^\uFEFF/u, '')
  const kind = detectPreviewKind(path, content)
  if (kind === 'csv') return parseDelimited(content, path.toLowerCase().endsWith('.tsv') || path.toLowerCase().endsWith('.tab') ? '\t' : ',')
  if (kind === 'json') return parseJson(content)
  if (kind === 'jsonl') return parseJsonLines(content)
  if (kind === 'yaml') return parseYamlOutline(content)
  if (kind === 'toml') return parseTomlOutline(content)
  if (kind === 'xml') return parseXmlOutline(content)
  if (kind === 'log') return parseLog(content)
  if (kind === 'diff') return parseDiff(content)
  return { kind: 'source', format: kind === 'markdown' ? 'Markdown' : 'Text' }
}

function parseDelimited(content: string, delimiter: ',' | '\t'): PreviewModel {
  const parsed: string[][] = []
  const warnings: string[] = []
  let row: string[] = [], cell = '', quoted = false, omittedRows = 0
  const pushCell = (): void => { row.push(limitCell(cell)); cell = '' }
  const pushRow = (): void => { pushCell(); parsed.push(row); row = [] }
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { cell += '"'; index += 1 }
      else if (char === '"') quoted = false
      else cell += char
      continue
    }
    if (char === '"' && cell.length === 0) { quoted = true; continue }
    if (char === delimiter) { pushCell(); continue }
    if (char === '\n') {
      if (parsed.length <= MAX_ROWS) pushRow()
      else { omittedRows += 1; row = []; cell = '' }
      continue
    }
    if (char === '\r' && content[index + 1] === '\n') continue
    cell += char
  }
  if (quoted) warnings.push('Unclosed quoted field; showing parsed content safely.')
  if (row.length > 0 || cell.length > 0) {
    if (parsed.length <= MAX_ROWS) pushRow()
    else omittedRows += 1
  }
  const totalRows = parsed.length
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...parsed.map((item) => item.length)))
  const headers = (parsed.shift() ?? []).slice(0, width).map((value, index) => value || `Column ${index + 1}`)
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`)
  const rows = parsed.slice(0, MAX_ROWS).map((item) => item.slice(0, width))
  return { kind: 'table', format: delimiter === '\t' ? 'TSV' : 'CSV', headers, rows, omittedRows: omittedRows + Math.max(0, totalRows - 1 - rows.length), omittedColumns: Math.max(0, Math.max(0, ...parsed.map((item) => item.length)) - width), warnings }
}

function parseJson(content: string): PreviewModel {
  try { return flattenJson(JSON.parse(content), 'JSON') }
  catch (error) { return { kind: 'records', format: 'JSON', rows: [], omittedNodes: 0, error: errorMessage(error) } }
}
function parseJsonLines(content: string): PreviewModel {
  const values: unknown[] = [], errors: string[] = []
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue
    if (values.length >= MAX_ROWS) break
    try { values.push(JSON.parse(line)) } catch { errors.push(`Line ${index + 1}`) }
  }
  const model = flattenJson(values, 'JSONL')
  return { ...model, ...(errors.length ? { error: `Invalid JSON on ${errors.slice(0, 5).join(', ')}${errors.length > 5 ? '…' : ''}` } : {}) }
}
function flattenJson(value: unknown, format: 'JSON' | 'JSONL'): Extract<PreviewModel, { kind: 'records' }> {
  const rows: Array<{ path: string; value: string }> = []
  let seen = 0
  const visit = (input: unknown, path: string, depth: number): void => {
    seen += 1
    if (rows.length >= MAX_NODES) return
    if (depth > 20) { rows.push({ path, value: '[depth limit]' }); return }
    if (input === null || typeof input !== 'object') { rows.push({ path, value: limitCell(typeof input === 'string' ? input : JSON.stringify(input)) }); return }
    const entries = Array.isArray(input) ? input.map((item, index) => [String(index), item] as const) : Object.entries(input)
    if (entries.length === 0) rows.push({ path, value: Array.isArray(input) ? '[]' : '{}' })
    for (const [key, child] of entries) visit(child, path ? `${path}.${key}` : key, depth + 1)
  }
  visit(value, '$', 0)
  return { kind: 'records', format, rows, omittedNodes: Math.max(0, seen - rows.length) }
}

function parseYamlOutline(content: string): PreviewModel {
  const rows = content.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim() || /^\s*#/u.test(line)) return []
    const match = /^(\s*)(?:-\s*)?([^:#][^:]*):(?:\s*(.*))?$/u.exec(line)
    return match ? [{ depth: Math.floor(match[1]!.replaceAll('\t', '  ').length / 2), key: match[2]!.trim(), value: limitCell(stripComment(match[3] ?? '')) || undefined }] : []
  })
  return boundedOutline('YAML', rows)
}
function parseTomlOutline(content: string): PreviewModel {
  const rows: Array<{ depth: number; key: string; value?: string }> = []
  let depth = 0
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const section = /^\[\[?([^\]]+)\]\]?$/u.exec(trimmed)
    if (section) { depth = section[1]!.split('.').length - 1; rows.push({ depth, key: section[1]! }); continue }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(trimmed)
    if (pair) rows.push({ depth: depth + 1, key: pair[1]!, value: limitCell(stripComment(pair[2]!)) })
  }
  return boundedOutline('TOML', rows)
}
function parseXmlOutline(content: string): PreviewModel {
  if (/<!DOCTYPE|<!ENTITY/iu.test(content)) return { kind: 'outline', format: 'XML', rows: [], omittedNodes: 0, error: 'DOCTYPE and ENTITY declarations are disabled for safe preview.' }
  const rows: Array<{ depth: number; key: string; value?: string }> = []
  let depth = 0
  for (const match of content.matchAll(/<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>|([^<>]+)/gu)) {
    const token = match[0]
    if (token.startsWith('</')) { depth = Math.max(0, depth - 1); continue }
    if (token.startsWith('<')) {
      rows.push({ depth, key: match[1]! })
      if (!token.endsWith('/>')) depth += 1
    } else {
      const text = (match[2] ?? '').trim()
      if (text && rows.length) rows[rows.length - 1]!.value = limitCell(text)
    }
  }
  return boundedOutline('XML', rows)
}
function boundedOutline(format: 'YAML' | 'TOML' | 'XML', rows: Array<{ depth: number; key: string; value?: string }>): Extract<PreviewModel, { kind: 'outline' }> {
  return { kind: 'outline', format, rows: rows.slice(0, MAX_NODES), omittedNodes: Math.max(0, rows.length - MAX_NODES) }
}

function parseLog(content: string): PreviewModel {
  const all = content.split(/\r?\n/u)
  const visible = all.slice(-MAX_ROWS).map((raw) => {
    const text = stripAnsi(raw)
    const level: LogLevel = /\b(?:fatal|error|err)\b/iu.test(text) ? 'error' : /\bwarn(?:ing)?\b/iu.test(text) ? 'warn' : /\binfo\b/iu.test(text) ? 'info' : /\b(?:debug|trace)\b/iu.test(text) ? 'debug' : 'other'
    return { level, text: limitCell(text) }
  })
  return { kind: 'log', rows: visible, omittedRows: Math.max(0, all.length - visible.length) }
}
function parseDiff(content: string): PreviewModel {
  const all = content.split(/\r?\n/u)
  const rows = all.slice(0, MAX_ROWS).map((text) => ({ type: text.startsWith('@@') ? 'hunk' : text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ') ? 'meta' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'delete' : 'context', text: limitCell(text) } as const))
  return { kind: 'diff', rows, omittedRows: Math.max(0, all.length - rows.length) }
}

export function safeExternalHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const normalized = href.trim().replace(/[\u0000-\u0020]+/gu, '').toLowerCase()
  return /^(?:https?:|mailto:)/u.test(normalized) ? href : undefined
}
function stripAnsi(value: string): string { return value.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, '') }
function stripComment(value: string): string { return value.replace(/\s+#.*$/u, '').trim() }
function limitCell(value: string): string { return value.length <= MAX_CELL_CHARS ? value : `${value.slice(0, MAX_CELL_CHARS)}…` }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function safeJson(value: string): boolean { try { JSON.parse(value); return true } catch { return false } }
