import { describe, expect, it } from 'vitest'
import type { ToolCallContent, ToolResultContent } from '@agent-kernel/kernel'

import { pickRenderer } from './renderers.js'

function call(name: string, input: Record<string, unknown>, callId = `call-${name}`): ToolCallContent {
  return { type: 'tool_call', callId, name, input }
}

function result(callId: string, ok = true, content = 'ok'): ToolResultContent {
  return { type: 'tool_result', callId, ok, content }
}

describe('tool summary renderers', () => {
  it('summarizes read_file like a single file read', () => {
    const rows = pickRenderer('read_file')({
      calls: [call('read_file', { path: 'src/app.ts' }, 'c1')],
      results: new Map([['c1', result('c1', true, 'one\ntwo')]]),
    })

    expect(rows).toEqual([{ callId: 'c1', primary: 'src/app.ts', secondary: '2 lines', ok: true }])
  })

  it('summarizes read_files by first path and file count', () => {
    const rows = pickRenderer('read_files')({
      calls: [call('read_files', { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, 'c1')],
      results: new Map([['c1', result('c1')]]),
    })

    expect(rows).toEqual([{ callId: 'c1', primary: 'src/a.ts', secondary: '2 files', ok: true }])
  })

  it('summarizes write_file using the written path and content lines', () => {
    const rows = pickRenderer('write_file')({
      calls: [call('write_file', { path: 'src/app.ts', content: 'a\nb\nc' }, 'c1')],
      results: new Map(),
    })

    expect(rows).toEqual([{ callId: 'c1', primary: 'src/app.ts', secondary: '3 lines', ok: true }])
  })

  it('summarizes replace_in_file and replace_many_in_file as file mutations', () => {
    const mutationResult = JSON.stringify({
      ok: true,
      summary: 'Applied 1 replacement(s) in src/app.ts',
      files: [{ path: 'src/app.ts', operation: 'modified', additions: 2, deletions: 1 }],
    })
    const replaceRows = pickRenderer('replace_in_file')({
      calls: [call('replace_in_file', { path: 'src/app.ts' }, 'c1')],
      results: new Map([['c1', result('c1', true, mutationResult)]]),
    })
    const multiRows = pickRenderer('replace_many_in_file')({
      calls: [call('replace_many_in_file', { path: 'src/app.ts', edits: [{ old_string: 'a', new_string: 'b' }] }, 'c2')],
      results: new Map(),
    })

    expect(replaceRows).toEqual([{ callId: 'c1', primary: 'src/app.ts', secondary: { kind: 'delta', additions: 2, deletions: 1 }, ok: true }])
    expect(multiRows).toEqual([{ callId: 'c2', primary: 'src/app.ts', secondary: '1 edit', ok: true }])
  })

  it('summarizes apply_file_patch by its first patch target', () => {
    const rows = pickRenderer('apply_file_patch')({
      calls: [call('apply_file_patch', { patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch' }, 'c1')],
      results: new Map([['c1', result('c1')]]),
    })

    expect(rows).toEqual([{ callId: 'c1', primary: 'src/app.ts', secondary: 'applied', ok: true }])
  })
})
