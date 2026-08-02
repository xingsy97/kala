import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoStore } from './memo-store.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('MemoStore', () => {
  it('persists independent owner documents across store restart', async () => {
    const dir=mkdtempSync(join(tmpdir(),'memo-'));dirs.push(dir);const store=new MemoStore(dir)
    expect(await store.read('alice')).toMatchObject({content:'',revision:0})
    expect(await store.write('alice',{content:'<p>one</p>',expectedRevision:0})).toMatchObject({revision:1})
    await store.write('bob',{content:'private',expectedRevision:0})
    const restarted=new MemoStore(dir)
    expect(await restarted.read('alice')).toMatchObject({content:'<p>one</p>',revision:1})
    expect(await restarted.read('bob')).toMatchObject({content:'private',revision:1})
  })
  it('rejects stale concurrent saves instead of losing edits', async () => {
    const dir=mkdtempSync(join(tmpdir(),'memo-'));dirs.push(dir);const store=new MemoStore(dir)
    await store.write('alice',{content:'one',expectedRevision:0})
    await expect(store.write('alice',{content:'stale',expectedRevision:0})).rejects.toThrow('memo_revision_conflict')
    expect(await store.read('alice')).toMatchObject({content:'one',revision:1})
  })
})
