import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { maybeOverflow } from './overflow.js'

describe('tool output overflow', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-overflow-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves small outputs inline', async () => {
    const res = await maybeOverflow('small output', {
      sessionId: 'sess-1',
      callId: 'call-1',
      config: { inlineBytes: 1024, previewLines: 4, overflowDir: dir },
    })

    expect(res).toMatchObject({ content: 'small output', overflowed: false })
    expect(res.filePath).toBeUndefined()
  })

  it('spills large outputs and keeps head plus tail in the inline preview', async () => {
    const full = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n')

    const res = await maybeOverflow(full, {
      sessionId: 'sess-1',
      callId: 'call-1',
      config: { inlineBytes: 82, previewLines: 6, overflowDir: dir },
    })

    expect(res.overflowed).toBe(true)
    expect(res.filePath).toBe(join(dir, 'sess-1', 'call-1.txt'))
    expect(readFileSync(res.filePath!, 'utf8')).toBe(full)
    expect(res.content).toContain('line-1')
    expect(res.content).toContain('line-12')
    expect(res.content).toContain('[...')
    expect(res.content).toContain('overflow://call-1')
  })
})
