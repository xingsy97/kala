import type { WindowsCommandRunner } from './windows-service.js'
import { spawnWindowsCommand } from './windows-service.js'

export interface CredentialProtector {
  protect(plaintext: Uint8Array): Promise<Uint8Array>
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>
}

export interface DpapiCredentialProtectorOptions {
  runner?: WindowsCommandRunner
  platform?: NodeJS.Platform
  scope?: 'CurrentUser' | 'LocalMachine'
  powershellPath?: string
}

const DPAPI_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$inputText = [Console]::In.ReadToEnd()',
  '$request = $inputText | ConvertFrom-Json',
  '$bytes = [Convert]::FromBase64String([string]$request.data)',
  '$scope = [Enum]::Parse([Security.Cryptography.DataProtectionScope], [string]$request.scope)',
  'if ($request.operation -eq "protect") {',
  '  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
  '} elseif ($request.operation -eq "unprotect") {',
  '  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
  '} else { throw "Unsupported DPAPI operation" }',
  '[Console]::Out.Write([Convert]::ToBase64String($result))',
].join('; ')

export class DpapiCredentialProtector implements CredentialProtector {
  readonly #runner: WindowsCommandRunner
  readonly #platform: NodeJS.Platform
  readonly #scope: 'CurrentUser' | 'LocalMachine'
  readonly #powershellPath: string

  constructor(options: DpapiCredentialProtectorOptions = {}) {
    this.#runner = options.runner ?? spawnWindowsCommand
    this.#platform = options.platform ?? process.platform
    this.#scope = options.scope ?? 'LocalMachine'
    this.#powershellPath = options.powershellPath ?? 'powershell.exe'
  }

  protect(plaintext: Uint8Array): Promise<Uint8Array> {
    return this.#invoke('protect', plaintext)
  }

  unprotect(ciphertext: Uint8Array): Promise<Uint8Array> {
    return this.#invoke('unprotect', ciphertext)
  }

  async #invoke(operation: 'protect' | 'unprotect', value: Uint8Array): Promise<Uint8Array> {
    if (this.#platform !== 'win32') throw new Error('DPAPI is unavailable on this platform')
    const input = JSON.stringify({ operation, scope: this.#scope, data: Buffer.from(value).toString('base64') })
    const result = await this.#runner(
      this.#powershellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DPAPI_SCRIPT],
      { input },
    )
    if (result.exitCode !== 0) {
      throw new Error(`DPAPI ${operation} failed (${result.exitCode}): ${result.stderr.trim() || 'unknown error'}`)
    }
    const encoded = result.stdout.trim()
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error(`DPAPI ${operation} returned invalid data`)
    }
    return Buffer.from(encoded, 'base64')
  }
}
