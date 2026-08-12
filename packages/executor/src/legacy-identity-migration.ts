import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export type ExecutorInstallationSource =
  | 'package-manager'
  | 'dashboard-native'
  | 'legacy-cjs'
  | 'container'

export type MigrationConflict = {
  kind: 'active-executor' | 'target-exists'
  path: string
  profile: string
  pid?: number
}

export type LegacyIdentity = {
  profile: string
  profileDir: string
  workspaceId: string
  workspaceIdPath: string
  token: { present: boolean; path: string }
  installationSource: ExecutorInstallationSource
}

export type MigrationPlan = {
  version: 1
  targetDir: string
  identity?: LegacyIdentity
  conflicts: readonly MigrationConflict[]
  canApply: boolean
  operations: readonly ({ kind: 'copy'; file: 'workspace-id' | 'executor-token'; mode: '0600' })[]
}

export type DiscoverLegacyIdentityOptions = {
  legacyRoot?: string
  profile?: string
  targetDir: string
  installationSourceHint?: ExecutorInstallationSource
}

const WORKSPACE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
const INSTALLATION_SOURCES = new Set<ExecutorInstallationSource>([
  'package-manager',
  'dashboard-native',
  'legacy-cjs',
  'container',
])

function normalizedProfile(profile: string | undefined): string {
  const value = profile?.trim()
  if (!value || value === 'default') return 'default'
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error(`Invalid executor profile ${JSON.stringify(profile)}`)
  }
  return value
}

function profileDir(root: string, profile: string): string {
  return profile === 'default' ? root : join(root, 'profiles', profile)
}

function assertRegularFile(path: string): void {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Refusing unsafe legacy identity file: ${path}`)
  }
}

function readRegularFile(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Refusing unsafe legacy identity file: ${path}`)
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Legacy identity file changed while opening: ${path}`)
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function discoverInstallationSource(
  dir: string,
  hint: ExecutorInstallationSource | undefined,
): ExecutorInstallationSource {
  if (hint) return hint
  for (const name of ['install-source', '.install-source']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const value = readRegularFile(path).trim() as ExecutorInstallationSource
    if (!INSTALLATION_SOURCES.has(value)) {
      throw new Error(`Invalid executor installation source at ${path}`)
    }
    return value
  }
  return 'legacy-cjs'
}

function readPotentialPid(lockPath: string): number | undefined {
  try {
    const value = Number.parseInt(readRegularFile(lockPath).split('\n')[0]?.trim() ?? '', 10)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function activeConflict(dir: string, profile: string): MigrationConflict | undefined {
  const lockPath = join(dir, 'executor.lock')
  const properLockPath = `${lockPath}.lock`
  if (!existsSync(properLockPath)) return undefined
  const pid = readPotentialPid(lockPath)
  return {
    kind: 'active-executor',
    path: properLockPath,
    profile,
    ...(pid !== undefined ? { pid } : {}),
  }
}

/**
 * Discovers one legacy default/named profile without writing files or reading
 * the executor token. The returned plan contains token presence and path only.
 */
export function discoverLegacyIdentityMigration(
  options: DiscoverLegacyIdentityOptions,
): MigrationPlan {
  const root = options.legacyRoot ?? join(homedir(), '.agent-kernel')
  const profile = normalizedProfile(options.profile)
  const dir = profileDir(root, profile)
  const workspaceIdPath = join(dir, 'workspace-id')
  const tokenPath = join(dir, 'executor-token')
  const conflicts: MigrationConflict[] = []

  const running = activeConflict(dir, profile)
  if (running) conflicts.push(running)
  if (existsSync(options.targetDir)) {
    conflicts.push({ kind: 'target-exists', path: options.targetDir, profile })
  }

  let identity: LegacyIdentity | undefined
  if (existsSync(workspaceIdPath)) {
    const workspaceId = readRegularFile(workspaceIdPath).trim()
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new Error(`Invalid legacy workspace id at ${workspaceIdPath}`)
    }
    if (existsSync(tokenPath)) assertRegularFile(tokenPath)
    identity = {
      profile,
      profileDir: dir,
      workspaceId,
      workspaceIdPath,
      token: { present: existsSync(tokenPath), path: tokenPath },
      installationSource: discoverInstallationSource(dir, options.installationSourceHint),
    }
  }

  const operations: MigrationPlan['operations'] = identity
    ? [
        { kind: 'copy', file: 'workspace-id', mode: '0600' },
        ...(identity.token.present
          ? [{ kind: 'copy' as const, file: 'executor-token' as const, mode: '0600' as const }]
          : []),
      ]
    : []

  return {
    version: 1,
    targetDir: options.targetDir,
    ...(identity ? { identity } : {}),
    conflicts,
    canApply: identity !== undefined && conflicts.length === 0,
    operations,
  }
}

function writePrivateFile(path: string, contents: string): void {
  const temporaryPath = `${path}.tmp-${randomBytes(8).toString('hex')}`
  const fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(fd, contents, { encoding: 'utf8' })
  } finally {
    closeSync(fd)
  }
  renameSync(temporaryPath, path)
}

/**
 * Applies an explicitly supplied, conflict-free plan. Files are staged in a
 * private sibling directory and published with one atomic directory rename.
 */
export function applyLegacyIdentityMigration(plan: MigrationPlan): void {
  if (plan.version !== 1 || !plan.identity || !plan.canApply || plan.conflicts.length > 0) {
    throw new Error('Migration plan is not safe to apply')
  }
  if (existsSync(plan.targetDir)) throw new Error(`Migration target already exists: ${plan.targetDir}`)
  if (process.platform === 'win32') {
    throw new Error('Migration requires enforceable 0700/0600 filesystem permissions')
  }

  // Reserve the same directory used by proper-lockfile. This proves no legacy
  // executor holds the profile lock and prevents one from starting mid-copy.
  const legacyLockDir = join(plan.identity.profileDir, 'executor.lock.lock')
  try {
    mkdirSync(legacyLockDir)
  } catch {
    throw new Error(`Legacy executor may still be active: ${legacyLockDir}`)
  }

  try {
    const workspaceId = readRegularFile(plan.identity.workspaceIdPath).trim()
    if (workspaceId !== plan.identity.workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new Error('Legacy workspace identity changed after discovery')
    }

    let token: string | undefined
    if (plan.identity.token.present) {
      if (!existsSync(plan.identity.token.path)) throw new Error('Legacy executor token disappeared after discovery')
      token = readRegularFile(plan.identity.token.path).trim()
      if (!token) throw new Error('Legacy executor token is empty')
    } else if (existsSync(plan.identity.token.path)) {
      throw new Error('Legacy executor token appeared after discovery')
    }

    const parent = dirname(plan.targetDir)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    // Atomic no-replace reservation: mkdir fails if any target appeared after
    // discovery. Individual files are written privately and rename-published.
    mkdirSync(plan.targetDir, { mode: 0o700 })
    try {
      writePrivateFile(join(plan.targetDir, 'workspace-id'), `${workspaceId}\n`)
      if (token !== undefined) writePrivateFile(join(plan.targetDir, 'executor-token'), `${token}\n`)
    } catch (error) {
      rmSync(plan.targetDir, { recursive: true, force: true })
      throw error
    }
  } finally {
    rmSync(legacyLockDir, { recursive: true, force: true })
  }

  if ((statSync(plan.targetDir).mode & 0o777) !== 0o700) {
    throw new Error(`Migration target permissions are not private: ${plan.targetDir}`)
  }
}

/** Enumerates profiles which currently contain a workspace identity. */
export function discoverLegacyExecutorProfiles(legacyRoot = join(homedir(), '.agent-kernel')): string[] {
  const profiles: string[] = []
  if (existsSync(join(legacyRoot, 'workspace-id'))) profiles.push('default')
  const namedRoot = join(legacyRoot, 'profiles')
  if (!existsSync(namedRoot)) return profiles
  for (const entry of readdirSync(namedRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && existsSync(join(namedRoot, entry.name, 'workspace-id'))) {
      profiles.push(entry.name)
    }
  }
  return profiles.sort((left, right) => left.localeCompare(right))
}
