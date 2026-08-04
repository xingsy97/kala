import { ReferencedSignatureSchema, type ReferencedSignature } from '@agent-kernel/eval-protocol'

export interface ReferencedHashSigner {
  readonly keyReference: string
  validate(): Promise<void>
  signSha256(hash: string): Promise<ReferencedSignature>
}

/** Imports fresh PKCS#8 material for every signature to support atomic key rotation. */
export class RotatingEd25519Signer implements ReferencedHashSigner {
  constructor(readonly keyReference: string, private readonly readPrivateKey: () => string | Uint8Array | Promise<string | Uint8Array>) {
    if (!keyReference.trim()) throw new Error('signing keyReference is required')
  }

  async validate(): Promise<void> { await this.loadKey() }

  async signSha256(hash: string): Promise<ReferencedSignature> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('signed value must be a SHA-256 hex digest')
    const key = await this.loadKey()
    const signature = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key, arrayBuffer(hexBytes(hash)))
    return ReferencedSignatureSchema.parse({ algorithm: 'ed25519', keyReference: this.keyReference, valueBase64: encodeBase64(new Uint8Array(signature)) })
  }

  private async loadKey(): Promise<CryptoKey> {
    const material = await this.readPrivateKey()
    const bytes = typeof material === 'string' ? decodePkcs8Pem(material) : new Uint8Array(material)
    if (bytes.byteLength === 0) throw new Error('Ed25519 private key file is empty')
    try { return await globalThis.crypto.subtle.importKey('pkcs8', arrayBuffer(bytes), { name: 'Ed25519' }, false, ['sign']) }
    catch { throw new Error('signing private key must be a valid Ed25519 PKCS#8 key') }
  }
}

function decodePkcs8Pem(value: string): Uint8Array {
  const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/u.exec(value)
  if (!match) throw new Error('signing private key must be PKCS#8 PEM')
  try { const binary = globalThis.atob(match[1]!.replace(/\s/gu, '')); return Uint8Array.from(binary, (character) => character.charCodeAt(0)) }
  catch { throw new Error('signing private key PEM is invalid') }
}
function hexBytes(value: string): Uint8Array { return Uint8Array.from(value.match(/.{2}/gu)!, (byte) => Number.parseInt(byte, 16)) }
function encodeBase64(value: Uint8Array): string { let binary = ''; for (const byte of value) binary += String.fromCharCode(byte); return globalThis.btoa(binary) }
function arrayBuffer(value: Uint8Array): ArrayBuffer { const output = new Uint8Array(value.byteLength); output.set(value); return output.buffer }
