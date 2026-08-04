import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('fixture remains tabular and answer is not embedded', async () => {
  const source = await readFile(new URL('../fixture/release-ledger.tsv', import.meta.url), 'utf8')
  assert.equal(source.trim().split('\n').length, 6)
  assert.equal(source.includes('answer=117'), false)
})
