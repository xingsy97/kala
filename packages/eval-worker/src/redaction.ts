const GENERIC_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|sk-ant|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/giu,
  /((?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[=:]\s*)[^\s,;]+/giu,
]

export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret.length < 4) continue
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix: string | undefined) => prefix ? prefix + '[REDACTED]' : '[REDACTED]')
  }
  return redacted
}

export function sanitizeDiagnostic(value: string, secrets: readonly string[] = []): string {
  return redactText(value, secrets)
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:"'<>|]+[\\/])+[^\s:"'<>|]*/gu, '[PRIVATE_PATH]')
    .slice(0, 2_048)
}

export function redactJsonLine(value: unknown, secrets: readonly string[]): string {
  return redactText(JSON.stringify(value), secrets)
}
