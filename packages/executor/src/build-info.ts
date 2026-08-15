import packageJson from '../package.json' with { type: 'json' }

export type ExecutorBuildInfo = {
  releaseTag: string
  gitCommit: string
  builtAt: string
  artifactKind: string
}

export function executorBuildInfo(): ExecutorBuildInfo {
  const globalValue = (globalThis as typeof globalThis & { __AGENT_KERNEL_BUILD_INFO__?: unknown }).__AGENT_KERNEL_BUILD_INFO__
  if (!isRecord(globalValue)) {
    return { releaseTag: process.env.AGENT_KERNEL_RELEASE_TAG ?? packageJson.version, gitCommit: process.env.AGENT_KERNEL_GIT_COMMIT ?? 'unknown', builtAt: 'unknown', artifactKind: 'source' }
  }
  return {
    releaseTag: typeof globalValue.releaseTag === 'string' ? globalValue.releaseTag : packageJson.version,
    gitCommit: typeof globalValue.gitCommit === 'string' ? globalValue.gitCommit : 'unknown',
    builtAt: typeof globalValue.builtAt === 'string' ? globalValue.builtAt : 'unknown',
    artifactKind: typeof globalValue.artifactKind === 'string' ? globalValue.artifactKind : 'unknown',
  }
}

export function executorReleaseVersion(): string {
  const candidate = executorBuildInfo().releaseTag.trim().replace(/^v/u, '')
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(candidate) ? candidate : packageJson.version
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
