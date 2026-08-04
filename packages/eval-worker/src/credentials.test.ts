import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EnvironmentCredentialResolver } from './credentials.js'

const reference = { referenceId: 'local-model-api-key', provider: 'openai', scope: ['model-inference'] }

describe('EnvironmentCredentialResolver', () => {
  it('resolves an allowlisted helper without putting the credential in process arguments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-credentials-'))
    const path = join(directory, 'settings.json')
    await writeFile(path, JSON.stringify({ apiKeyHelper: "printf '%s\\n' 'fixture-helper-secret'" }))
    const resolver = new EnvironmentCredentialResolver({ AGENT_EVAL_CREDENTIAL_HELPER_SETTINGS: path, AGENT_EVAL_CREDENTIAL_HELPER_REFERENCE_IDS: reference.referenceId })
    await expect(resolver.available(reference)).resolves.toBe(true)
    await expect(resolver.resolve([reference])).resolves.toEqual({ [reference.referenceId]: 'fixture-helper-secret' })
  })

  it('cancels a running helper and never includes helper stderr in the failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-credentials-'))
    const path = join(directory, 'settings.json')
    const seededSecret = 'seeded-helper-stderr-secret'
    await writeFile(path, JSON.stringify({ apiKeyHelper: `printf '%s\\n' '${seededSecret}' >&2; sleep 30` }))
    const resolver = new EnvironmentCredentialResolver({ AGENT_EVAL_CREDENTIAL_HELPER_SETTINGS: path, AGENT_EVAL_CREDENTIAL_HELPER_REFERENCE_IDS: reference.referenceId })
    const controller = new AbortController()
    const resolving = resolver.resolve([reference], controller.signal)
    setTimeout(() => controller.abort(new Error('fixture cancellation')), 20)
    await expect(resolving).rejects.toThrow('fixture cancellation')

    await writeFile(path, JSON.stringify({ apiKeyHelper: `printf '%s\\n' '${seededSecret}' >&2; exit 7` }))
    const failure = await resolver.resolve([reference]).catch((error: unknown) => error as Error)
    expect(failure.message).toContain('exit code 7')
    expect(failure.message).not.toContain(seededSecret)
  })

  it('does not execute a helper for an undeclared reference id', async () => {
    const resolver = new EnvironmentCredentialResolver({})
    await expect(resolver.available(reference)).resolves.toBe(false)
    await expect(resolver.resolve([reference])).rejects.toThrow('credential reference is unavailable')
  })
})
