import { readFile } from 'node:fs/promises'

import { writeAtomicFile } from './atomic-json-file.js'

export type DedicatedSlot = 'blue' | 'green'

export type DedicatedRouteState = {
  schemaVersion: 1
  generation: number
  activeSlot: DedicatedSlot
  slots: Record<DedicatedSlot, { origin: string; releaseId: string }>
  updatedAt: string
}

export function otherSlot(slot: DedicatedSlot): DedicatedSlot { return slot === 'blue' ? 'green' : 'blue' }

export function parseDedicatedRouteState(value: unknown): DedicatedRouteState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('route state must be an object')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1 || (input.activeSlot !== 'blue' && input.activeSlot !== 'green') || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error('invalid route state')
  if (Object.keys(input).some((key) => !['schemaVersion', 'generation', 'activeSlot', 'slots', 'updatedAt'].includes(key))) throw new Error('unknown route state field')
  const slots = input.slots as Record<string, unknown> | undefined
  if (!slots || Object.keys(slots).length !== 2 || !Object.hasOwn(slots, 'blue') || !Object.hasOwn(slots, 'green')) throw new Error('invalid route slots')
  const parseSlot = (name: DedicatedSlot): { origin: string; releaseId: string } => {
    const slot = slots?.[name]
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw new Error(`missing ${name} slot`)
    const record = slot as Record<string, unknown>
    if (Object.keys(record).some((key) => !['origin', 'releaseId'].includes(key)) || typeof record.origin !== 'string' || !loopbackOrigin(record.origin) || typeof record.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.releaseId)) throw new Error(`invalid ${name} slot`)
    return { origin: record.origin, releaseId: record.releaseId }
  }
  return { schemaVersion: 1, generation: Number(input.generation), activeSlot: input.activeSlot, slots: { blue: parseSlot('blue'), green: parseSlot('green') }, updatedAt: input.updatedAt }
}

export async function readDedicatedRouteState(path: string): Promise<DedicatedRouteState> {
  return parseDedicatedRouteState(JSON.parse(await readFile(path, 'utf8')))
}

export async function writeDedicatedRouteState(path: string, state: DedicatedRouteState): Promise<void> {
  const valid = parseDedicatedRouteState(state)
  // Route generation is the public commit fence. Persist file contents before
  // rename and fsync the parent directory so a host crash cannot acknowledge a
  // route generation that disappears after reboot.
  await writeAtomicFile(path, `${JSON.stringify(valid, null, 2)}\n`, 0o644)
}

export function advanceDedicatedRoute(current: DedicatedRouteState, input: { slot: DedicatedSlot; releaseId: string }): DedicatedRouteState {
  return parseDedicatedRouteState({ ...current, generation: current.generation + 1, activeSlot: input.slot, slots: { ...current.slots, [input.slot]: { ...current.slots[input.slot], releaseId: input.releaseId } }, updatedAt: new Date().toISOString() })
}

function loopbackOrigin(value: string): boolean {
  try {
    const origin = new URL(value)
    const port = Number(origin.port)
    return origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number.isSafeInteger(port) && port > 0 && port <= 65_535
      && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password
  } catch { return false }
}
