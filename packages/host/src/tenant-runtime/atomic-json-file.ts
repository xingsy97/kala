import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function writeJsonFile(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeAtomicFile(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

export async function writeAtomicFile(path: string, value: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const file = await open(temp, 'wx', mode)
    try {
      await file.writeFile(value)
      await file.chmod(mode)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  finally { await rm(temp, { force: true }).catch(() => {}) }
}
