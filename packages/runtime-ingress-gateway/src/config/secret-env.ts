import { readFile } from 'node:fs/promises'

export async function readRequiredSecretEnv(name: string): Promise<string> {
  const direct = process.env[name]?.trim()
  const file = process.env[`${name}_FILE`]?.trim()
  if (direct && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`)
  if (direct) return direct
  if (file) {
    const value = (await readFile(file, 'utf8')).trim()
    if (value) return value
  }
  throw new Error(`${name} or ${name}_FILE is required`)
}
