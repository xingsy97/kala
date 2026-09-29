import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { MemoDocument } from '../memo-store.js'

const KEY_BYTES = 32
const NONCE_BYTES = 12

type CredentialRow = {
  metadata: string
  nonce: Uint8Array
  ciphertext: Uint8Array
  auth_tag: Uint8Array
  updated_at: string
}

export type StoredCredential = {
  secret: string
  metadata: Record<string, unknown>
  updatedAt: string
}

export class KalaStateStore {
  private database?: DatabaseSync
  private rootKey?: Buffer

  constructor(
    readonly stateRoot: string,
    private readonly options: {
      keyPath?: string
      legacyMemoDirectory?: string
      legacyCredentialDirectory?: string
    } = {},
  ) {}

  readMemo(owner: string): MemoDocument {
    const db = this.open()
    const row = db.prepare('SELECT content, revision, updated_at FROM memos WHERE owner = ?').get(owner) as
      | { content: string; revision: number; updated_at: string }
      | undefined
    if (row) return { content: row.content, revision: row.revision, updatedAt: row.updated_at }
    const imported = this.importLegacyMemo(owner)
    return imported ?? { content: '', revision: 0, updatedAt: new Date(0).toISOString() }
  }

  writeMemo(owner: string, input: { content: string; expectedRevision?: number }): MemoDocument {
    if (Buffer.byteLength(input.content, 'utf8') > 10 * 1024 * 1024) throw new Error('memo_too_large')
    const db = this.open()
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.readMemo(owner)
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new Error('memo_revision_conflict')
      const next = { content: input.content, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      db.prepare(`
        INSERT INTO memos (owner, content, revision, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET content = excluded.content, revision = excluded.revision, updated_at = excluded.updated_at
      `).run(owner, next.content, next.revision, next.updatedAt)
      db.exec('COMMIT')
      return next
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  getCredential(provider: string): StoredCredential | undefined {
    this.importLegacyCredential(provider)
    const row = this.open().prepare(`
      SELECT metadata, nonce, ciphertext, auth_tag, updated_at
      FROM credentials WHERE scope = 'unit' AND provider = ?
    `).get(provider) as CredentialRow | undefined
    if (!row) return undefined
    const key = this.loadRootKey(false)
    if (!key) throw new Error('credential master key is missing')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce))
    decipher.setAAD(credentialAad(provider))
    decipher.setAuthTag(Buffer.from(row.auth_tag))
    const secret = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8')
    return { secret, metadata: parseMetadata(row.metadata), updatedAt: row.updated_at }
  }

  setCredential(provider: string, secret: string, metadata: Record<string, unknown>, updatedAt = new Date().toISOString()): void {
    const key = this.loadRootKey(true)
    if (!key) throw new Error('failed to create credential master key')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(credentialAad(provider))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    this.open().prepare(`
      INSERT INTO credentials (scope, provider, metadata, nonce, ciphertext, auth_tag, updated_at)
      VALUES ('unit', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, provider) DO UPDATE SET
        metadata = excluded.metadata,
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(provider, JSON.stringify(metadata), nonce, ciphertext, cipher.getAuthTag(), updatedAt)
  }

  deleteCredential(provider: string): void {
    this.open().prepare("DELETE FROM credentials WHERE scope = 'unit' AND provider = ?").run(provider)
  }

  close(): void {
    this.database?.close()
    this.database = undefined
    this.rootKey = undefined
  }

  private open(): DatabaseSync {
    if (this.database) return this.database
    mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.stateRoot, 0o700)
    const path = join(this.stateRoot, 'state.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS memos (
        owner TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        scope TEXT NOT NULL,
        provider TEXT NOT NULL,
        metadata TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, provider)
      );
      PRAGMA user_version = 1;
    `)
    chmodSync(path, 0o600)
    this.database = database
    return database
  }

  private loadRootKey(create: boolean): Buffer | undefined {
    if (this.rootKey) return this.rootKey
    const path = this.options.keyPath ?? process.env.KALA_STATE_MASTER_KEY_PATH ?? join(this.stateRoot, 'state-store.key')
    if (existsSync(path)) {
      const key = readFileSync(path)
      if (key.length !== KEY_BYTES) throw new Error('invalid credential master key length')
      this.rootKey = key
      return key
    }
    if (!create) return undefined
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const key = randomBytes(KEY_BYTES)
    writeFileSync(path, key, { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
    this.rootKey = key
    return key
  }

  private importLegacyMemo(owner: string): MemoDocument | undefined {
    const directory = this.options.legacyMemoDirectory ?? join(this.stateRoot, 'memos')
    const path = join(directory, `${createHash('sha256').update(owner).digest('hex')}.json`)
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoDocument>
    if (typeof parsed.content !== 'string' || !Number.isInteger(parsed.revision) || (parsed.revision ?? -1) < 0 || typeof parsed.updatedAt !== 'string') {
      throw new Error(`invalid legacy memo: ${path}`)
    }
    const memo = parsed as MemoDocument
    this.open().prepare('INSERT OR IGNORE INTO memos (owner, content, revision, updated_at) VALUES (?, ?, ?, ?)')
      .run(owner, memo.content, memo.revision, memo.updatedAt)
    return memo
  }

  private importLegacyCredential(provider: string): void {
    const exists = this.open().prepare("SELECT 1 AS present FROM credentials WHERE scope = 'unit' AND provider = ?").get(provider)
    if (exists) return
    const directory = this.options.legacyCredentialDirectory ?? join(this.stateRoot, 'credentials')
    if (provider === 'serper') this.importLegacyEncryptedRecord({
      provider,
      recordPath: join(directory, 'web-search.json'),
      keyPath: join(directory, 'master.key'),
      legacyAad: Buffer.from('agent-runlab:web-search-credential:v1:serper', 'utf8'),
      metadata(record) {
        return { version: 1, provider: 'serper', updatedAt: requiredString(record.updatedAt, 'updatedAt') }
      },
    })
    if (provider === 'azure_speech') this.importLegacyEncryptedRecord({
      provider,
      recordPath: join(directory, 'azure-speech.json'),
      keyPath: join(directory, 'speech-master.key'),
      legacyAad: Buffer.from('agent-runlab:azure-speech-credential:v1', 'utf8'),
      metadata(record) {
        return {
          version: 1,
          provider: 'azure',
          endpoint: requiredString(record.endpoint, 'endpoint'),
          region: requiredString(record.region, 'region'),
          enabled: record.enabled === true,
          mode: record.mode === 'after_recording' ? 'after_recording' : 'realtime',
          updatedAt: requiredString(record.updatedAt, 'updatedAt'),
        }
      },
    })
  }

  private importLegacyEncryptedRecord(input: {
    provider: string
    recordPath: string
    keyPath: string
    legacyAad: Buffer
    metadata(record: Record<string, unknown>): Record<string, unknown>
  }): void {
    if (!existsSync(input.recordPath)) return
    if (!existsSync(input.keyPath)) throw new Error(`legacy credential key is missing: ${input.keyPath}`)
    const key = readFileSync(input.keyPath)
    if (key.length !== KEY_BYTES) throw new Error('invalid legacy credential key length')
    const record = JSON.parse(readFileSync(input.recordPath, 'utf8')) as Record<string, unknown>
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(requiredString(record.iv, 'iv'), 'base64'))
    decipher.setAAD(input.legacyAad)
    decipher.setAuthTag(Buffer.from(requiredString(record.tag, 'tag'), 'base64'))
    const secret = Buffer.concat([
      decipher.update(Buffer.from(requiredString(record.ciphertext, 'ciphertext'), 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const metadata = input.metadata(record)
    this.setCredential(input.provider, secret, metadata, requiredString(record.updatedAt, 'updatedAt'))
  }
}

function credentialAad(provider: string): Buffer {
  return Buffer.from(`kala:credential-vault:v1:unit:${provider}`, 'utf8')
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid legacy credential ${name}`)
  return value
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid credential metadata')
  return parsed as Record<string, unknown>
}
