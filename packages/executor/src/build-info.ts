import packageJson from '../package.json' with { type: 'json' }

export type ExecutorBuildInfo = {
  releaseTag: string
  productVersion?: string
  gitCommit: string
  builtAt: string
  artifactKind: string
}

export function executorBuildInfo(): ExecutorBuildInfo {
  const globalValue = (globalThis as typeof globalThis & { __AGENT_KERNEL_BUILD_INFO__?: unknown }).__AGENT_KERNEL_BUILD_INFO__
  if (!isRecord(globalValue)) {
    return { releaseTag: process.env.AGENT_KERNEL_RELEASE_TAG ?? packageJson.version, productVersion: packageJson.version, gitCommit: process.env.AGENT_KERNEL_GIT_COMMIT ?? 'unknown', builtAt: 'unknown', artifactKind: 'source' }
  }
  return {
    releaseTag: typeof globalValue.releaseTag === 'string' ? globalValue.releaseTag : packageJson.version,
    productVersion: typeof globalValue.productVersion === 'string' ? globalValue.productVersion : packageJson.version,
    gitCommit: typeof globalValue.gitCommit === 'string' ? globalValue.gitCommit : 'unknown',
    builtAt: typeof globalValue.builtAt === 'string' ? globalValue.builtAt : 'unknown',
    artifactKind: typeof globalValue.artifactKind === 'string' ? globalValue.artifactKind : 'unknown',
  }
}

export function executorReleaseVersion(): string {
  const candidate = executorBuildInfo().releaseTag.trim().replace(/^v/u, '')
  return semanticReleaseVersion(candidate, executorBuildInfo().productVersion ?? packageJson.version)
}

/**
 * Release channels such as `latest` are delivery coordinates, not versions.
 * Older bundled Executors accidentally fell back to the package version that
 * esbuild discovered inside a dependency package (often 0.0.0). Keep the
 * display tag in BuildMetadata, but derive the wire/update version only from a
 * valid semantic release or the explicitly injected product package version.
 */
export function semanticReleaseVersion(releaseTag: string, productVersion: string): string {
  const normalizedTag = releaseTag.trim().replace(/^v/u, '')
  if (isSemanticVersion(normalizedTag)) return normalizedTag
  const normalizedProduct = productVersion.trim().replace(/^v/u, '')
  if (isSemanticVersion(normalizedProduct)) return normalizedProduct
  throw new Error('Executor product version is not semantic')
}

function isSemanticVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
