import type { CredentialReference } from '@agent-kernel/eval-protocol'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export interface CredentialResolver {
  resolve(references: readonly CredentialReference[], signal?: AbortSignal): Promise<Readonly<Record<string, string>>>
  available(reference: CredentialReference): Promise<boolean>
}

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(references: readonly CredentialReference[], signal?: AbortSignal): Promise<Readonly<Record<string, string>>> {
    const resolved: Record<string, string> = {}
    for (const reference of references) {
      signal?.throwIfAborted()
      const name = credentialEnvironmentName(reference.referenceId)
      const value = this.environment[name] ?? await this.helperCredential(reference.referenceId, signal)
      if (!value) throw new Error('credential reference is unavailable: ' + reference.referenceId)
      resolved[reference.referenceId] = value
    }
    return resolved
  }

  async available(reference: CredentialReference): Promise<boolean> {
    return Boolean(this.environment[credentialEnvironmentName(reference.referenceId)] ?? await this.helperCredential(reference.referenceId))
  }

  private async helperCredential(referenceId: string, signal?: AbortSignal): Promise<string | undefined> {
    const path = this.environment.AGENT_EVAL_CREDENTIAL_HELPER_SETTINGS
    const allowed = new Set((this.environment.AGENT_EVAL_CREDENTIAL_HELPER_REFERENCE_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
    if (!path || !allowed.has(referenceId)) return undefined
    const settings = JSON.parse(await readFile(path, 'utf8')) as { apiKeyHelper?: unknown }
    if (typeof settings.apiKeyHelper !== 'string' || !settings.apiKeyHelper.trim()) return undefined
    return await runCredentialHelper(settings.apiKeyHelper, signal)
  }
}

export function credentialEnvironmentName(referenceId: string): string {
  return 'AGENT_EVAL_CREDENTIAL_' + referenceId.toUpperCase().replace(/[^A-Z0-9]/gu, '_')
}

async function runCredentialHelper(command: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []; let bytes = 0; let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error); else resolvePromise(value)
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish(signal?.reason instanceof Error ? signal.reason : new Error('credential helper aborted'))
    }
    const timeout = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('credential helper timed out')) }, 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > 64 * 1024) child.kill('SIGKILL'); else stdout.push(chunk)
    })
    // Drain stderr but never retain or reflect it: helpers may print credentials on failure.
    child.stderr.resume()
    child.once('error', (error) => finish(new Error('credential helper could not be started', { cause: error })))
    child.once('close', (code) => {
      if (bytes > 64 * 1024) { finish(new Error('credential helper output exceeded limit')); return }
      if (code !== 0) { finish(new Error('credential helper failed with exit code ' + String(code))); return }
      finish(undefined, Buffer.concat(stdout).toString('utf8').trim() || undefined)
    })
    child.stdin.end(command + '\n')
  })
}
