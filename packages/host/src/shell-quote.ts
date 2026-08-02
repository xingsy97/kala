export function shellQuoteLocal(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

export function powershellQuoteLocal(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

export function firstForwardedHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(',')[0]
  return first?.trim() || undefined
}
