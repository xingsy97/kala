import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_AZURE_SPEECH_ENDPOINT = 'https://japaneast.api.cognitive.microsoft.com/'
export type SpeechTranscriptionMode = 'realtime' | 'after_recording'

const MASTER_KEY_BYTES = 32
const IV_BYTES = 12
const AAD = Buffer.from('agent-runlab:azure-speech-credential:v1', 'utf8')

export type AzureSpeechCredential = {
  apiKey: string
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
}

export type AzureSpeechCredentialStatus = {
  configured: boolean
  provider: 'azure'
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
  updatedAt?: string
}

type EncryptedCredential = {
  version: 1
  provider: 'azure'
  endpoint: string
  region: string
  enabled: boolean
  mode?: SpeechTranscriptionMode
  iv: string
  ciphertext: string
  tag: string
  updatedAt: string
}

export interface AzureSpeechCredentialStore {
  get(): Promise<AzureSpeechCredential | undefined> | AzureSpeechCredential | undefined
  status(): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  set(input: { endpoint: string; apiKey?: string; enabled: boolean; mode: SpeechTranscriptionMode }): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  delete(): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
}

export function normalizeAzureSpeechEndpoint(raw: string): { endpoint: string; region: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('endpoint must be a valid HTTPS Azure Speech regional endpoint')
  }
  const match = /^([a-z0-9-]+)\.api\.cognitive\.microsoft\.com$/u.exec(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('endpoint must match https://<region>.api.cognitive.microsoft.com/')
  }
  return { endpoint: `https://${url.hostname.toLowerCase()}/`, region: match[1]! }
}

export class LocalAzureSpeechCredentialStore implements AzureSpeechCredentialStore {
  private readonly masterKeyPath: string
  private readonly credentialPath: string

  constructor(private readonly directory: string) {
    this.masterKeyPath = join(directory, 'speech-master.key')
    this.credentialPath = join(directory, 'azure-speech.json')
  }

  async status(): Promise<AzureSpeechCredentialStatus> {
    try {
      const record = await this.readRecord()
      return {
        configured: true,
        provider: 'azure',
        endpoint: record.endpoint,
        region: record.region,
        enabled: record.enabled,
        mode: record.mode ?? 'realtime',
        updatedAt: record.updatedAt,
      }
    } catch (error) {
      if (isMissing(error)) return unconfiguredStatus()
      throw error
    }
  }

  async get(): Promise<AzureSpeechCredential | undefined> {
    try {
      const [masterKey, record] = await Promise.all([this.loadMasterKey(false), this.readRecord()])
      if (!masterKey) return undefined
      const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(record.iv, 'base64'))
      decipher.setAAD(AAD)
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
      const apiKey = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      return {
        apiKey,
        endpoint: record.endpoint,
        region: record.region,
        enabled: record.enabled,
        mode: record.mode ?? 'realtime',
      }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async set(input: { endpoint: string; apiKey?: string; enabled: boolean; mode: SpeechTranscriptionMode }): Promise<AzureSpeechCredentialStatus> {
    const { endpoint, region } = normalizeAzureSpeechEndpoint(input.endpoint)
    const existing = await this.get()
    const apiKey = input.apiKey ?? existing?.apiKey
    if (!apiKey) throw new Error('an Azure Speech key is required')
    await this.ensureDirectory()
    const masterKey = await this.loadMasterKey(true)
    if (!masterKey) throw new Error('failed to create Azure Speech master key')
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
    const record: EncryptedCredential = {
      version: 1,
      provider: 'azure',
      endpoint,
      region,
      enabled: input.enabled,
      mode: input.mode,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    await this.atomicWrite(this.credentialPath, `${JSON.stringify(record)}\n`)
    return {
      configured: true,
      provider: 'azure',
      endpoint,
      region,
      enabled: input.enabled,
      mode: input.mode,
      updatedAt: record.updatedAt,
    }
  }

  async delete(): Promise<AzureSpeechCredentialStatus> {
    await unlink(this.credentialPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
    return unconfiguredStatus()
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  private async loadMasterKey(create: boolean): Promise<Buffer | undefined> {
    try {
      const key = await readFile(this.masterKeyPath)
      if (key.length !== MASTER_KEY_BYTES) throw new Error('invalid Azure Speech master key length')
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
      if (key.length !== MASTER_KEY_BYTES) throw new Error('invalid Azure Speech master key length')
      await chmod(this.masterKeyPath, 0o600)
      return key
    }
  }

  private async readRecord(): Promise<EncryptedCredential> {
    const raw = JSON.parse(await readFile(this.credentialPath, 'utf8')) as Partial<EncryptedCredential>
    if (
      raw.version !== 1 ||
      raw.provider !== 'azure' ||
      typeof raw.endpoint !== 'string' ||
      typeof raw.region !== 'string' ||
      typeof raw.enabled !== 'boolean' ||
      typeof raw.iv !== 'string' ||
      typeof raw.ciphertext !== 'string' ||
      typeof raw.tag !== 'string' ||
      typeof raw.updatedAt !== 'string'
    ) {
      throw new Error('invalid encrypted Azure Speech credential')
    }
    const normalized = normalizeAzureSpeechEndpoint(raw.endpoint)
    if (normalized.endpoint !== raw.endpoint || normalized.region !== raw.region) {
      throw new Error('invalid Azure Speech endpoint metadata')
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

function unconfiguredStatus(): AzureSpeechCredentialStatus {
  const { endpoint, region } = normalizeAzureSpeechEndpoint(DEFAULT_AZURE_SPEECH_ENDPOINT)
  return { configured: false, provider: 'azure', endpoint, region, enabled: false, mode: 'realtime' }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
