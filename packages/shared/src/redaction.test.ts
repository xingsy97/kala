import { describe, expect, it } from 'vitest'

import { redactForPersistence } from './redaction.js'

describe('redactForPersistence', () => {
  it('redacts bearer tokens, API keys, workspace paths, and signed URL fields', () => {
    const result = redactForPersistence({
      authorization: 'Bearer secret-token',
      description: 'OPENAI_API_KEY=not-a-real-test-fixture in /workspace/private/file.txt',
      bundleUrl: 'https://storage.example/bundle.zip?X-Amz-Signature=secret',
      nested: { 'x-api-key': 'plain-secret' },
    }, { workspaceRoot: '/workspace/private' })

    expect(result.value).toEqual({
      authorization: '[redacted]',
      description: 'OPENAI_API_KEY=[redacted] in <workspace>/file.txt',
      bundleUrl: '<https://redacted>/bundle.zip?<query-redacted>',
      nested: { 'x-api-key': '[redacted]' },
    })
    expect(result.summary).toMatchObject({ redacted: true, truncated: false })
    expect(result.summary.rules).toEqual(['path.workspace_root', 'secret.env', 'secret.key', 'url.base'])
  })

  it('truncates oversized strings after redaction', () => {
    const result = redactForPersistence({ message: `Bearer token ${'x'.repeat(20)}` }, { maxStringLength: 10 })

    expect(result.value).toEqual({ message: '****** xxx\n[truncated] 17 chars omitted' })
    expect(result.summary.rules).toEqual(['secret.bearer', 'truncate.large_string'])
  })
})
