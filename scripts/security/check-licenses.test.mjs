import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { reviewedUnknownLicense } from './check-licenses.mjs'

test('reviews the CLI only as an upstream SDK npm dependency', () => {
  for (const name of [
    '@github/copilot@1.0.80',
    '@github/copilot-linux-arm64@1.0.80',
    '@github/copilot-linux-x64@1.0.80',
  ]) {
    assert.equal(reviewedUnknownLicense(name)?.classification, 'LicenseRef-GitHub-Copilot-CLI')
    assert.equal(reviewedUnknownLicense(name)?.licenseFile, 'LICENSE.md')
  }

  const source = readFileSync(new URL('./check-licenses.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /COPILOT_CLI_LICENSE|release builder ships/i)
})
