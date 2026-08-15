import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

export type StandaloneSlot = 'blue' | 'green'

export type StandaloneRouteState = {
  schemaVersion: 1
  generation: number
  activeSlot: StandaloneSlot
  slots: Record<StandaloneSlot, { origin: string; releaseId: string }>
  updatedAt: string
}

export function otherSlot(slot: StandaloneSlot): StandaloneSlot { return slot === 'blue' ? 'green' : 'blue' }

export function parseStandaloneRouteState(value: unknown): StandaloneRouteState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('route state must be an object')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1 || (input.activeSlot !== 'blue' && input.activeSlot !== 'green') || typeof input.updatedAt !== 'string') throw new Error('invalid route state')
  const slots = input.slots as Record<string, unknown> | undefined
  const parseSlot = (name: StandaloneSlot): { origin: string; releaseId: string } => {
    const slot = slots?.[name]
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw new Error(`missing ${name} slot`)
    const record = slot as Record<string, unknown>
    if (typeof record.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(record.origin) || typeof record.releaseId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(record.releaseId)) throw new Error(`invalid ${name} slot`)
    return { origin: record.origin, releaseId: record.releaseId }
  }
  return { schemaVersion: 1, generation: Number(input.generation), activeSlot: input.activeSlot, slots: { blue: parseSlot('blue'), green: parseSlot('green') }, updatedAt: input.updatedAt }
}

export async function readStandaloneRouteState(path: string): Promise<StandaloneRouteState> {
  return parseStandaloneRouteState(JSON.parse(await readFile(path, 'utf8')))
}

export async function writeStandaloneRouteState(path: string, state: StandaloneRouteState): Promise<void> {
  const valid = parseStandaloneRouteState(state)
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  const temporary = `${path}.next-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, path)
  await chmod(path, 0o644)
}

export function advanceStandaloneRoute(current: StandaloneRouteState, input: { slot: StandaloneSlot; releaseId: string }): StandaloneRouteState {
  return parseStandaloneRouteState({ ...current, generation: current.generation + 1, activeSlot: input.slot, slots: { ...current.slots, [input.slot]: { ...current.slots[input.slot], releaseId: input.releaseId } }, updatedAt: new Date().toISOString() })
}
