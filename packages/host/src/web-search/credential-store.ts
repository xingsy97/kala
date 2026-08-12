import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { WebSearchCredentialStore } from './index.js'

const PROVIDER = 'serper' as const
const MASTER_KEY_BYTES = 32
const IV_BYTES = 12
const AAD = Buffer.from('agent-runlab:web-search-credential:v1:serper', 'utf8')

export type WebSearchCredentialStatus = {
  configured: boolean
  provider: typeof PROVIDER
  updatedAt?: string
}

type EncryptedCredential = {
  version: 1
  provider: typeof PROVIDER
  iv: string
  ciphertext: string
  tag: string
  updatedAt: string
}

export class LocalWebSearchCredentialStore implements WebSearchCredentialStore {
  private readonly masterKeyPath: string
  private readonly credentialPath: string

  constructor(private readonly directory: string) {
    this.masterKeyPath = join(directory, 'master.key')
    this.credentialPath = join(directory, 'web-search.json')
  }

  async status(): Promise<WebSearchCredentialStatus> {
    try {
      const record = await this.readRecord()
      return { configured: true, provider: PROVIDER, updatedAt: record.updatedAt }
    } catch (error) {
      if (isMissing(error)) return { configured: false, provider: PROVIDER }
      throw error
    }
  }

  async get(provider: typeof PROVIDER): Promise<string | undefined> {
    if (provider !== PROVIDER) return undefined
    try {
      const [key, record] = await Promise.all([this.loadMasterKey(false), this.readRecord()])
      if (!key) return undefined
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
      decipher.setAAD(AAD)
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async set(provider: typeof PROVIDER, key: string): Promise<WebSearchCredentialStatus> {
    if (provider !== PROVIDER) throw new Error('unsupported web search provider')
    await this.ensureDirectory()
    const masterKey = await this.loadMasterKey(true)
    if (!masterKey) throw new Error('failed to create web search master key')
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()])
    const record: EncryptedCredential = {
      version: 1,
      provider: PROVIDER,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    await this.atomicWrite(this.credentialPath, `${JSON.stringify(record)}\n`)
    return { configured: true, provider: PROVIDER, updatedAt: record.updatedAt }
  }

  async delete(provider: typeof PROVIDER): Promise<WebSearchCredentialStatus> {
    if (provider !== PROVIDER) throw new Error('unsupported web search provider')
    await unlink(this.credentialPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
    return { configured: false, provider: PROVIDER }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  private async loadMasterKey(create: boolean): Promise<Buffer | undefined> {
    try {
      const key = await readFile(this.masterKeyPath)
      if (key.length !== MASTER_KEY_BYTES) throw new Error('invalid web search master key length')
      await chmod(this.masterKeyPath, 0o600)
      return key
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return undefined
    }

    await this.ensureDirectory()
    const generated = randomBytes(MASTER_KEY_BYTES)
    try {
      await writeFile(this.masterKeyPath, generated, { flag: 'wx', mode: 0o600 })
      return generated
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const key = await readFile(this.masterKeyPath)
      if (key.length !== MASTER_KEY_BYTES) throw new Error('invalid web search master key length')
      await chmod(this.masterKeyPath, 0o600)
      return key
    }
  }

  private async readRecord(): Promise<EncryptedCredential> {
    const raw = JSON.parse(await readFile(this.credentialPath, 'utf8')) as Partial<EncryptedCredential>
    if (raw.version !== 1 || raw.provider !== PROVIDER || typeof raw.iv !== 'string' ||
      typeof raw.ciphertext !== 'string' || typeof raw.tag !== 'string' || typeof raw.updatedAt !== 'string') {
      throw new Error('invalid encrypted web search credential')
    }
    return raw as EncryptedCredential
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await this.ensureDirectory()
    const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, path)
      await chmod(path, 0o600)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
