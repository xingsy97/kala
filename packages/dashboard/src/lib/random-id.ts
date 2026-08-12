let sequence = 0

/** UUID-shaped identifier that also works on non-secure HTTP origins. */
export function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    const now = Date.now()
    sequence = (sequence + 1) >>> 0
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (now >>> ((i % 6) * 8)) ^ (sequence >>> ((i % 4) * 8)) ^ (i * 31)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
