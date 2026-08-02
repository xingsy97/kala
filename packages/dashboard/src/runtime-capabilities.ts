import type { RuntimeCapabilities, RuntimeCapabilitiesPayload } from '@agent-kernel/shared'
import { useEffect, useState } from 'react'
import { resolveHostEndpoint } from './host-endpoint.js'

const SAFE_CAPABILITIES: RuntimeCapabilities = { agent: true, workspace: true, benchmarks: false, evaluations: false }
export type RuntimeDeploymentState = { capabilities: RuntimeCapabilities; mode: RuntimeCapabilitiesPayload['mode'] | null; loaded: boolean; unauthorized?: boolean; error?: string }

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return ['agent', 'workspace', 'benchmarks', 'evaluations'].every((key) => typeof candidate[key] === 'boolean')
}

function isPayload(value: unknown): value is RuntimeCapabilitiesPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (candidate.mode === 'standalone' || candidate.mode === 'saas') && isCapabilities(candidate.capabilities)
}

export async function loadRuntimeDeployment(
  host: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<RuntimeDeploymentState> {
  try {
    const response = await fetcher(`${host}/runtime/capabilities`, { cache: 'no-store', signal })
    if (response.status === 401) return { capabilities: SAFE_CAPABILITIES, mode: 'saas', loaded: true, unauthorized: true }
    if (!response.ok) return { capabilities: SAFE_CAPABILITIES, mode: null, loaded: true, error: `Runtime capabilities request failed (${response.status})` }
    const payload: unknown = await response.json()
    return isPayload(payload)
      ? { capabilities: payload.capabilities, mode: payload.mode, loaded: true }
      : { capabilities: SAFE_CAPABILITIES, mode: null, loaded: true }
  } catch (error) {
    if (signal?.aborted) return { capabilities: SAFE_CAPABILITIES, mode: null, loaded: false }
    return { capabilities: SAFE_CAPABILITIES, mode: null, loaded: true, error: error instanceof Error ? error.message : 'Runtime capabilities request failed' }
  }
}

export function useRuntimeDeployment(): RuntimeDeploymentState {
  const [host] = useState(() => resolveHostEndpoint().url)
  const [deployment, setDeployment] = useState<RuntimeDeploymentState>({ capabilities: SAFE_CAPABILITIES, mode: null, loaded: false })
  useEffect(() => {
    const controller = new AbortController()
    void loadRuntimeDeployment(host, controller.signal).then(setDeployment)
    return () => controller.abort()
  }, [host])
  return deployment
}

export function useRuntimeCapabilities(): RuntimeCapabilities {
  return useRuntimeDeployment().capabilities
}
