import { activatePwaUpdate } from './pwa.js'

const RECOVERY_KEY_PREFIX = 'ak-dashboard-version-recovery:'

export class StaleDashboardAssetError extends Error {
  readonly code = 'STALE_DASHBOARD_ASSET'

  constructor(readonly asset: string, readonly expectedExport?: string, options?: ErrorOptions) {
    super(`Dashboard asset contract mismatch: ${asset}${expectedExport ? `#${expectedExport}` : ''}`, options)
    this.name = 'StaleDashboardAssetError'
  }
}

export function isStaleDashboardAssetError(error: unknown): boolean {
  return error instanceof StaleDashboardAssetError
    || (error instanceof Error && (error.name === 'ChunkLoadError'
      || /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/iu.test(error.message)))
}

export async function loadDashboardExport<
  Module extends object,
  Key extends keyof Module,
>(loader: Promise<Module>, key: Key, asset: string): Promise<{ default: Module[Key] }> {
  let module: Module
  try {
    module = await loader
  } catch (error) {
    throw new StaleDashboardAssetError(asset, String(key), { cause: error })
  }
  const value = module[key]
  if ((typeof value !== 'function' && typeof value !== 'object') || value === null) {
    throw new StaleDashboardAssetError(asset, String(key))
  }
  return { default: value }
}

type DashboardIdentity = { generation?: number; releaseId?: string }
type RecoveryDependencies = {
  fetchStatus?: () => Promise<DashboardIdentity | undefined>
  identity?: DashboardIdentity
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  serviceWorker?: ServiceWorkerContainer
  reload?: () => void
  recoverWhenVersionChanged?: boolean
}

export type DashboardRecoveryResult = 'reloading' | 'not-stale' | 'already-attempted'

export function dashboardBootIdentity(documentValue: Pick<Document, 'querySelector'> = document): DashboardIdentity {
  const releaseId = documentValue.querySelector<HTMLMetaElement>('meta[name=\"agent-runlab-dashboard-release\"]')?.content
  const generationText = documentValue.querySelector<HTMLMetaElement>('meta[name=\"agent-runlab-dashboard-generation\"]')?.content
  const generation = Number(generationText)
  return {
    ...(releaseId ? { releaseId } : {}),
    ...(Number.isSafeInteger(generation) && generation > 0 ? { generation } : {}),
  }
}

/**
 * Recover one stale Dashboard generation without exposing module internals or
 * entering a reload loop. Composer drafts are already persisted per Session
 * in localStorage, so a controlled reload preserves unsent text.
 */
export async function recoverStaleDashboard(
  error: unknown,
  dependencies: RecoveryDependencies = {},
): Promise<DashboardRecoveryResult> {
  const staleAsset = isStaleDashboardAssetError(error)
  if (!staleAsset && !dependencies.recoverWhenVersionChanged) return 'not-stale'
  const identity = dependencies.identity ?? dashboardBootIdentity()
  const storage = dependencies.storage ?? safeSessionStorage()
  const recoveryIdentity = identity.generation ? `generation-${identity.generation}` : identity.releaseId ?? 'unknown'
  const key = `${RECOVERY_KEY_PREFIX}${recoveryIdentity}`
  if (storage?.getItem(key) === '1') return 'already-attempted'

  const fetchStatus = dependencies.fetchStatus ?? fetchDashboardStatus
  const current = await fetchStatus().catch(() => undefined)
  const changed = current !== undefined && (
    (identity.generation !== undefined && current.generation !== identity.generation)
    || (identity.releaseId !== undefined && current.releaseId !== identity.releaseId)
  )
  if (!staleAsset && !changed) return 'not-stale'
  // An explicit lazy-module contract error is itself sufficient evidence of
  // mixed assets. A status failure must not strand the user on a fatal page.
  if (!changed && current && identity.generation === undefined && identity.releaseId === undefined) {
    // Portable builds have no generation metadata; still use the bounded
    // unknown-generation recovery below.
  }
  storage?.setItem(key, '1')

  const serviceWorker = dependencies.serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined)
  const reload = dependencies.reload ?? (() => window.location.reload())
  if (serviceWorker) {
    const registration = await serviceWorker.getRegistration().catch(() => undefined)
    await registration?.update().catch(() => undefined)
    if (registration?.waiting) {
      await activatePwaUpdate({
        sendSkipWaiting: async () => { registration.waiting?.postMessage({ type: 'SKIP_WAITING' }) },
        serviceWorker,
        reload,
      })
      return 'reloading'
    }
  }
  reload()
  return 'reloading'
}

async function fetchDashboardStatus(): Promise<DashboardIdentity | undefined> {
  const response = await fetch('/runtime/dashboard/status', { cache: 'no-store', headers: { accept: 'application/json' } })
  if (!response.ok) return undefined
  const value = await response.json() as { generation?: unknown; releaseId?: unknown }
  return {
    ...(Number.isSafeInteger(value.generation) ? { generation: Number(value.generation) } : {}),
    ...(typeof value.releaseId === 'string' ? { releaseId: value.releaseId } : {}),
  }
}

function safeSessionStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    const probe = `${RECOVERY_KEY_PREFIX}probe`
    sessionStorage.setItem(probe, '1')
    sessionStorage.removeItem(probe)
    return sessionStorage
  } catch {
    if (typeof history === 'undefined') return undefined
    return {
      getItem: (key) => {
        const state = history.state as { agentRunlabRecoveryKeys?: unknown } | null
        return Array.isArray(state?.agentRunlabRecoveryKeys) && state.agentRunlabRecoveryKeys.includes(key) ? '1' : null
      },
      setItem: (key) => {
        const state = history.state && typeof history.state === 'object' ? history.state as Record<string, unknown> : {}
        const existing = Array.isArray(state.agentRunlabRecoveryKeys) ? state.agentRunlabRecoveryKeys.filter((value): value is string => typeof value === 'string') : []
        history.replaceState({ ...state, agentRunlabRecoveryKeys: [...new Set([...existing, key])] }, '')
      },
    }
  }
}
