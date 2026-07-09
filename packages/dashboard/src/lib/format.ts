export type TokenFormatOptions = {
  thousands?: 'fixed-1' | 'compact'
  millionSuffix?: 'M' | 'm'
}

export function formatTokens(
  tokens: number,
  options: TokenFormatOptions = {},
): string {
  const { thousands = 'fixed-1', millionSuffix = 'M' } = options
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}${millionSuffix}`
  if (tokens >= 1_000) {
    const value = tokens / 1_000
    return `${thousands === 'compact' && tokens >= 10_000 ? value.toFixed(0) : value.toFixed(1)}k`
  }
  return String(tokens)
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}
