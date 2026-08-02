export function parseSandboxRootsEnv(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (!value) return []
  const separator = platform === 'win32' ? ';' : ':'
  return value.split(separator).map((root) => root.trim()).filter(Boolean)
}
