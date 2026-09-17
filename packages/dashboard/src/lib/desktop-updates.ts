import { useCallback, useEffect, useRef, useState } from 'react'
import { useDesktopBridge } from './desktop-bridge.js'
import { loadDesktopUpdateMetadata, type DesktopRelease } from './desktop-download.js'

function parseVersion(value: string): { core: bigint[]; pre: string[] } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[~-]([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  return match ? { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre: match[4]?.split('.') ?? [] } : null
}

/** Compare the native SemVer and Debian ~prerelease forms without lexical rc10/rc2 errors. */
export function compareDesktopVersions(left: string, right: string): number | null {
  const a = parseVersion(left), b = parseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (BigInt(x) === BigInt(y)) continue
      return BigInt(x) > BigInt(y) ? 1 : -1
    }
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

type UpdateState = { checking: boolean; release: DesktopRelease | null; error: string | null }
const metadataCache = new Map<string, { expires: number; promise: Promise<DesktopRelease> }>()

export function useDesktopUpdate() {
  const native = useDesktopBridge()
  const [state, setState] = useState<UpdateState>({ checking: false, release: null, error: null })
  const generation = useRef(0)
  const version = native.info?.version
  const check = useCallback(async (force = false) => {
    if (!version) return
    const operation = ++generation.current
    setState((current) => ({ ...current, checking: true, error: null }))
    try {
      if (compareDesktopVersions(version, version) === null) throw new Error('Invalid installed desktop version')
      const key = window.location.origin
      let cached = metadataCache.get(key)
      if (force || !cached || cached.expires <= Date.now()) {
        cached = { expires: Date.now() + 60_000, promise: loadDesktopUpdateMetadata() }
        metadataCache.set(key, cached)
      }
      const release = await cached.promise
      if (compareDesktopVersions(release.version, version) === null) throw new Error('Invalid published desktop version')
      if (operation === generation.current) setState({ checking: false, release, error: null })
    } catch (reason) {
      if (operation === generation.current) setState({ checking: false, release: null, error: reason instanceof Error ? reason.message : 'Desktop update check failed' })
    }
  }, [version])
  useEffect(() => { void check(); return () => { generation.current++ } }, [check])
  return { ...native, ...state, error: state.error ?? native.error, installedVersion: version, newer: Boolean(version && state.release && compareDesktopVersions(state.release.version, version) === 1), check: () => check(true) }
}
