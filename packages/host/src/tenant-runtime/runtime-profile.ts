import {
  FULL_RUNTIME_CAPABILITIES,
  AGENT_RUNTIME_CAPABILITIES,
  type RuntimeCapabilities,
} from '@agent-kernel/shared'

export type RuntimeProfileName = 'full' | 'agent'
export type RuntimeModuleId =
  | 'agent'
  | 'workspace'
  | 'artifacts'
  | 'notifications'
  | 'benchmark'
  | 'evaluation'

export type RuntimeModule = {
  readonly id: RuntimeModuleId
  readonly capabilities: Partial<RuntimeCapabilities>
  start?(): Promise<void>
  drain?(): Promise<void>
  close?(): Promise<void>
}

export type RuntimeModuleContext = {
  readonly profile: RuntimeProfileName
  readonly installed: ReadonlyMap<RuntimeModuleId, RuntimeModule>
}

export type RuntimeModuleFactory = {
  readonly id: RuntimeModuleId
  readonly requires?: readonly RuntimeModuleId[]
  create(context: RuntimeModuleContext): RuntimeModule | Promise<RuntimeModule>
}

export type RuntimeProfile = {
  readonly name: RuntimeProfileName
  readonly modules: readonly RuntimeModuleId[]
}

const COMMON_MODULES: readonly RuntimeModuleId[] = ['agent', 'workspace', 'artifacts', 'notifications']

export const RUNTIME_PROFILES: Readonly<Record<RuntimeProfileName, RuntimeProfile>> = Object.freeze({
  full: Object.freeze({
    name: 'full',
    modules: Object.freeze<RuntimeModuleId[]>([...COMMON_MODULES, 'benchmark', 'evaluation']),
  }),
  agent: Object.freeze({
    name: 'agent',
    modules: Object.freeze([...COMMON_MODULES]),
  }),
})

export type RuntimeModuleComposition = {
  readonly profile: RuntimeProfileName
  readonly ordered: readonly RuntimeModule[]
  readonly modules: ReadonlyMap<RuntimeModuleId, RuntimeModule>
  readonly capabilities: RuntimeCapabilities
  start(): Promise<void>
  drain(): Promise<void>
  close(): Promise<void>
}

export async function composeRuntimeModules(input: {
  profile: RuntimeProfileName
  factories: readonly RuntimeModuleFactory[]
}): Promise<RuntimeModuleComposition> {
  const profile = RUNTIME_PROFILES[input.profile]
  const byId = new Map(input.factories.map((factory) => [factory.id, factory]))
  const orderedFactories = topologicalFactories(profile, byId)
  const installed = new Map<RuntimeModuleId, RuntimeModule>()
  const ordered: RuntimeModule[] = []
  try {
    for (const factory of orderedFactories) {
      const module = await factory.create({ profile: profile.name, installed })
      if (module.id !== factory.id) throw new Error(`Runtime module factory ${factory.id} returned ${module.id}`)
      installed.set(module.id, module)
      ordered.push(module)
    }
  } catch (error) {
    await closeReverse(ordered)
    throw error
  }
  const capabilities = deriveRuntimeCapabilities(ordered)
  assertProfileCapabilities(profile.name, capabilities)
  let started = false
  return {
    profile: profile.name,
    ordered,
    modules: installed,
    capabilities,
    async start() {
      if (started) return
      const active: RuntimeModule[] = []
      try {
        for (const module of ordered) {
          await module.start?.()
          active.push(module)
        }
        started = true
      } catch (error) {
        await closeReverse(active)
        throw error
      }
    },
    async drain() {
      for (const module of [...ordered].reverse()) await module.drain?.()
    },
    async close() {
      await closeReverse(ordered)
      started = false
    },
  }
}

export function deriveRuntimeCapabilities(modules: readonly RuntimeModule[]): RuntimeCapabilities {
  const capabilities: RuntimeCapabilities = {
    agent: false,
    workspace: false,
    operations: false,
    artifacts: false,
    pipeline: false,
  }
  for (const module of modules) Object.assign(capabilities, module.capabilities)
  return Object.freeze(capabilities)
}

export function assertProfileCapabilities(profile: RuntimeProfileName, actual: RuntimeCapabilities): void {
  const expected = profile === 'full' ? FULL_RUNTIME_CAPABILITIES : AGENT_RUNTIME_CAPABILITIES
  for (const key of Object.keys(expected) as Array<keyof RuntimeCapabilities>) {
    if (actual[key] !== expected[key]) throw new Error(`Runtime profile ${profile} capability ${key} must be ${String(expected[key])}`)
  }
}

function topologicalFactories(
  profile: RuntimeProfile,
  factories: ReadonlyMap<RuntimeModuleId, RuntimeModuleFactory>,
): RuntimeModuleFactory[] {
  const selected = new Set(profile.modules)
  const visiting = new Set<RuntimeModuleId>()
  const visited = new Set<RuntimeModuleId>()
  const ordered: RuntimeModuleFactory[] = []
  const visit = (id: RuntimeModuleId): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Runtime module dependency cycle at ${id}`)
    const factory = factories.get(id)
    if (!factory) throw new Error(`Runtime profile ${profile.name} requires missing module ${id}`)
    visiting.add(id)
    for (const dependency of factory.requires ?? []) {
      if (!selected.has(dependency)) throw new Error(`Runtime module ${id} requires disabled module ${dependency}`)
      visit(dependency)
    }
    visiting.delete(id)
    visited.add(id)
    ordered.push(factory)
  }
  for (const id of profile.modules) visit(id)
  return ordered
}

async function closeReverse(modules: readonly RuntimeModule[]): Promise<void> {
  for (const module of [...modules].reverse()) await module.close?.()
}
