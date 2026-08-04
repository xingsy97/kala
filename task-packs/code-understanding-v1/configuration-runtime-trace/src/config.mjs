import { readFile } from 'node:fs/promises'

export async function loadConfig(path = new URL('../config/defaults.json', import.meta.url)) {
  return JSON.parse(await readFile(path, 'utf8'))
}
