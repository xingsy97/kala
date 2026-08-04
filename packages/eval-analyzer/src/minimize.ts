export type MinimizationResult<T> = {
  originalSize: number
  minimized: readonly T[]
  attempts: number
  repetitions: number
  requiredPreservations: number
  oneMinimalVerified: true
}
export type MinimizationOptions = { repetitions?: number; requiredPreservations?: number }

/** Deterministic ddmin with repeated acceptance and a final deletion-by-deletion 1-minimal proof. */
export async function minimizeFailure<T>(items: readonly T[], preservesFailure: (candidate: readonly T[]) => Promise<boolean>, options: MinimizationOptions = {}): Promise<MinimizationResult<T>> {
  if (items.length === 0) throw new Error('cannot minimize an empty reproduction')
  const repetitions = options.repetitions ?? 1
  const requiredPreservations = options.requiredPreservations ?? repetitions
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(requiredPreservations) || requiredPreservations < 1 || requiredPreservations > repetitions) throw new Error('invalid minimization repetition threshold')
  let attempts = 0
  const preserves = async (candidate: readonly T[]): Promise<boolean> => {
    let preserved = 0
    for (let run = 0; run < repetitions; run += 1) {
      attempts += 1
      if (await preservesFailure(candidate)) preserved += 1
      if (preserved >= requiredPreservations) return true
      if (preserved + repetitions - run - 1 < requiredPreservations) return false
    }
    return false
  }
  if (!await preserves(items)) throw new Error('original reproduction does not preserve the target failure')
  let current = [...items]
  let granularity = 2
  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / granularity)
    let reduced = false
    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = current.slice(0, start).concat(current.slice(start + chunkSize))
      if (candidate.length === 0) continue
      if (await preserves(candidate)) { current = candidate; granularity = Math.max(2, granularity - 1); reduced = true; break }
    }
    if (reduced) continue
    if (granularity >= current.length) break
    granularity = Math.min(current.length, granularity * 2)
  }
  for (let index = 0; index < current.length;) {
    const candidate = current.slice(0, index).concat(current.slice(index + 1))
    if (candidate.length > 0 && await preserves(candidate)) { current = candidate; index = 0 } else index += 1
  }
  return { originalSize: items.length, minimized: current, attempts, repetitions, requiredPreservations, oneMinimalVerified: true }
}
