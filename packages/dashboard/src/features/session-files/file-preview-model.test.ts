import { describe, expect, it } from 'vitest'
import { buildPreviewModel, detectPreviewKind, safeExternalHref } from './file-preview-model.js'

describe('file preview model', () => {
  it('parses quoted CSV/TSV safely and preserves formula-like values as inert text', () => {
    const csv = buildPreviewModel('data.csv', '\uFEFFname,note,value\r\nAlice,"hello, world",=SUM(A1:A2)\r\nBob,"line 1\nline 2",2')
    expect(csv).toMatchObject({ kind: 'table', format: 'CSV', headers: ['name', 'note', 'value'] })
    if (csv.kind !== 'table') return
    expect(csv.rows[0]).toEqual(['Alice', 'hello, world', '=SUM(A1:A2)'])
    expect(csv.rows[1]?.[1]).toBe('line 1\nline 2')
    expect(buildPreviewModel('data.tsv', 'a\tb\n1\t2')).toMatchObject({ kind: 'table', format: 'TSV' })
  })

  it('flattens JSON and JSONL while reporting malformed records', () => {
    const json = buildPreviewModel('data.json', '{"user":{"name":"Ada"},"items":[1,2]}')
    expect(json).toMatchObject({ kind: 'records', format: 'JSON' })
    if (json.kind === 'records') expect(json.rows).toContainEqual({ path: '$.user.name', value: 'Ada' })
    const jsonl = buildPreviewModel('events.jsonl', '{"ok":true}\nnot-json\n{"ok":false}')
    expect(jsonl).toMatchObject({ kind: 'records', format: 'JSONL', error: expect.stringContaining('Line 2') })
  })

  it('builds bounded safe outlines and rejects XML entities', () => {
    expect(buildPreviewModel('config.yaml', 'server:\n  port: 3000')).toMatchObject({ kind: 'outline', format: 'YAML', rows: expect.arrayContaining([expect.objectContaining({ key: 'port', value: '3000' })]) })
    expect(buildPreviewModel('config.toml', '[server]\nport = 3000')).toMatchObject({ kind: 'outline', format: 'TOML' })
    expect(buildPreviewModel('safe.xml', '<root><item>text</item></root>')).toMatchObject({ kind: 'outline', format: 'XML' })
    expect(buildPreviewModel('unsafe.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')).toMatchObject({ kind: 'outline', error: expect.stringContaining('disabled') })
  })

  it('strips ANSI from logs, keeps the tail, and classifies diff lines', () => {
    const log = buildPreviewModel('app.log', '\u001b[31mERROR\u001b[0m failed\nINFO ready')
    expect(log).toMatchObject({ kind: 'log', rows: [{ level: 'error', text: 'ERROR failed' }, { level: 'info', text: 'INFO ready' }] })
    const diff = buildPreviewModel('change.patch', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new')
    expect(diff).toMatchObject({ kind: 'diff', rows: expect.arrayContaining([expect.objectContaining({ type: 'delete', text: '-old' }), expect.objectContaining({ type: 'add', text: '+new' })]) })
  })

  it('detects common formats and rejects active link protocols', () => {
    expect(detectPreviewKind('unknown.txt', '{"a":1}')).toBe('json')
    expect(detectPreviewKind('README.md', '# title')).toBe('markdown')
    expect(safeExternalHref('https://example.com')).toBe('https://example.com')
    expect(safeExternalHref('mailto:user@example.com')).toBe('mailto:user@example.com')
    expect(safeExternalHref('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalHref('data:text/html,x')).toBeUndefined()
  })

  it('bounds rows, columns, cells, and nesting', () => {
    const csv = buildPreviewModel('large.csv', `${Array.from({ length: 120 }, (_, i) => `h${i}`).join(',')}\n${Array.from({ length: 120 }, () => 'x').join(',')}`)
    expect(csv).toMatchObject({ kind: 'table', omittedColumns: 20 })
    const deep: Record<string, unknown> = {}; let cursor = deep
    for (let i = 0; i < 30; i += 1) { cursor.next = {}; cursor = cursor.next as Record<string, unknown> }
    const json = buildPreviewModel('deep.json', JSON.stringify(deep))
    if (json.kind === 'records') expect(json.rows.some((row) => row.value === '[depth limit]')).toBe(true)
    const manyRows = buildPreviewModel('many.csv', `name\n${Array.from({ length: 1_050 }, (_, index) => index).join('\n')}`)
    expect(manyRows).toMatchObject({ kind: 'table', omittedRows: 50 })
    const largeJson = `{\"padding\":\"${'x'.repeat(3_000)}\",\"ok\":true}`
    expect(detectPreviewKind('unknown.txt', largeJson)).toBe('json')
  })
})
