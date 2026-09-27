import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { reviewedUnknownLicense } from './check-licenses.mjs'

test('does not special-case the MIT-licensed Copilot SDK runtime packages', () => {
  assert.equal(reviewedUnknownLicense('@github/copilot-sdk-linux-x64@1.0.14'), undefined)
  const source = readFileSync(new URL('./check-licenses.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /COPILOT_CLI_LICENSE|release builder ships/i)
})
