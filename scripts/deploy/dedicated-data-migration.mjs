import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

// Mutable home configuration that is intentionally outside `.agent-kernel`.
// Keep this list aligned with every homedir-backed path used by the Host; the
// state tree rename alone cannot preserve these settings after HOME changes.
const HOME_CONFIG_FILES = [
  '.claude/settings.json',
  '.codex/config.toml',
  '.codex/auth.json',
  '.config/agent-kernel/models.json',
  '.config/agent-kernel/agent.json',
  '.config/agent-kernel/config.toml',
  '.config/agent-kernel/socket-admin.json',
]

export async function planDedicatedDataMigration(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const dataRoot = resolve(options.dataRoot)
  const sourceState = sourceRoot.endsWith('/.agent-kernel') ? sourceRoot : join(sourceRoot, '.agent-kernel')
  const legacyHome = sourceState.slice(0, -'/.agent-kernel'.length)
  const targetState = join(dataRoot, '.agent-kernel')
  await assertDirectory(sourceState, 'legacy state')
  await assertMissing(targetState, 'target state')
  await mkdir(dataRoot, { recursive: true, mode: 0o711 })
  const [sourceFs, targetFs] = await Promise.all([stat(sourceState), stat(dataRoot)])
  if (sourceFs.dev !== targetFs.dev) throw new Error('legacy and target state must be on the same filesystem for atomic move migration')
  const homeConfigFiles = []
  for (const relative of HOME_CONFIG_FILES) {
    const source = join(legacyHome, relative)
    const target = join(dataRoot, relative)
    const sourceFile = await regularFileOrMissing(source, `legacy home config ${relative}`)
    if (!sourceFile) continue
    await assertMissing(target, `target home config ${relative}`)
    homeConfigFiles.push({ source, target, sha256: sha256(await readFile(source)) })
  }
  return {
    schemaVersion: 1, mode: 'atomic-move', sourceState, targetState, legacyHome,
    legacyOwner: options.legacyOwner ?? `${sourceFs.uid}:${sourceFs.gid}`,
    targetOwner: options.targetOwner ?? 'agent-runlab:agent-runlab',
    filesystemDevice: String(sourceFs.dev), homeConfigFiles,
  }
}

/**
 * Proves that the Finalizer's own mount namespace permits an atomic directory
 * rename between the exact legacy and target parents. Equal st_dev values are
 * insufficient when systemd path sandboxing introduces separate bind mounts.
 */
export async function probeDedicatedAtomicRename(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const dataRoot = resolve(options.dataRoot)
  const sourceState = sourceRoot.endsWith('/.agent-kernel') ? sourceRoot : join(sourceRoot, '.agent-kernel')
  const legacyHome = dirname(sourceState)
  await assertDirectory(sourceState, 'legacy state')
  await mkdir(dataRoot, { recursive: true, mode: 0o711 })
  const identity = randomBytes(12).toString('hex')
  const sourceProbe = join(legacyHome, `.agent-runlab-rename-probe-${identity}`)
  const targetProbe = join(dataRoot, `.agent-runlab-rename-probe-${identity}`)
  await mkdir(sourceProbe, { mode: 0o700 })
  try {
    await rename(sourceProbe, targetProbe)
    await rename(targetProbe, sourceProbe)
  } catch (error) {
    throw new Error(`atomic state migration is unavailable in the Finalizer mount namespace: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(sourceProbe, { recursive: true, force: true })
    await rm(targetProbe, { recursive: true, force: true })
  }
}

export async function executeDedicatedDataMigration(migration, options = {}) {
  validateMigration(migration)
  const run = options.run ?? runCommand
  const location = await migrationLocation(migration)
  if (location === 'source') {
    const [sourceFs, targetFs] = await Promise.all([stat(migration.sourceState), stat(dirname(migration.targetState))])
    if (String(sourceFs.dev) !== migration.filesystemDevice || sourceFs.dev !== targetFs.dev) throw new Error('migration filesystem identity changed before atomic move')
    await rename(migration.sourceState, migration.targetState)
  }
  await assertDirectory(migration.targetState, 'migrated state')
  for (const file of migration.homeConfigFiles) await copyHomeConfigFile(file)
  const roots = await existingHomeConfigRoots(dirname(migration.targetState))
  await run('chown', ['-R', migration.targetOwner, migration.targetState, ...roots])
  return migration
}

export async function moveDedicatedData(options) {
  const migration = await planDedicatedDataMigration(options)
  try { return await executeDedicatedDataMigration(migration, options) }
  catch (error) {
    try { await rollbackDedicatedData(migration, options) }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `data migration failed and rollback failed closed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
    }
    throw error
  }
}

export async function rollbackDedicatedData(migration, options = {}) {
  validateMigration(migration)
  const run = options.run ?? runCommand
  const location = await migrationLocation(migration)
  for (const file of [...migration.homeConfigFiles].reverse()) await removeCopiedHomeConfigFile(file)
  if (location === 'source') {
    await assertDirectory(migration.sourceState, 'restored legacy state')
    return
  }
  await run('chown', ['-R', migration.legacyOwner, migration.targetState])
  await rename(migration.targetState, migration.sourceState)
  await assertDirectory(migration.sourceState, 'restored legacy state')
}

async function copyHomeConfigFile(file) {
  const source = await regularFileOrMissing(file.source, 'legacy home config source')
  if (!source || sha256(await readFile(file.source)) !== file.sha256) throw new Error('legacy home config changed after migration planning')
  const target = await regularFileOrMissing(file.target, 'migrated home config target')
  if (target) {
    if (sha256(await readFile(file.target)) !== file.sha256) throw new Error('migrated home config target has uncertain content')
    return
  }
  await mkdir(dirname(file.target), { recursive: true, mode: 0o700 })
  try { await copyFile(file.source, file.target, constants.COPYFILE_EXCL) }
  catch (error) {
    if (error?.code !== 'EEXIST' || !await regularFileOrMissing(file.target, 'migrated home config target') || sha256(await readFile(file.target)) !== file.sha256) throw error
  }
}

async function removeCopiedHomeConfigFile(file) {
  const target = await regularFileOrMissing(file.target, 'migrated home config target')
  if (!target) return
  if (sha256(await readFile(file.target)) !== file.sha256) throw new Error('refusing to remove migrated home config with uncertain content')
  await rm(file.target)
}

async function migrationLocation(migration) {
  const [source, target] = await Promise.all([directoryState(migration.sourceState), directoryState(migration.targetState)])
  if (source && target) throw new Error('both legacy and migrated state roots exist; ownership is uncertain')
  if (!source && !target) throw new Error('neither legacy nor migrated state root exists; ownership is uncertain')
  return source ? 'source' : 'target'
}

function validateMigration(migration) {
  if (!migration || migration.schemaVersion !== 1 || migration.mode !== 'atomic-move'
    || typeof migration.sourceState !== 'string' || resolve(migration.sourceState) !== migration.sourceState
    || typeof migration.targetState !== 'string' || resolve(migration.targetState) !== migration.targetState
    || typeof migration.legacyOwner !== 'string' || typeof migration.targetOwner !== 'string'
    || typeof migration.filesystemDevice !== 'string' || !Array.isArray(migration.homeConfigFiles)) throw new Error('invalid Dedicated data migration receipt')
  for (const file of migration.homeConfigFiles) {
    if (!file || typeof file.source !== 'string' || resolve(file.source) !== file.source
      || typeof file.target !== 'string' || resolve(file.target) !== file.target
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('invalid Dedicated home config migration receipt')
  }
}

async function existingHomeConfigRoots(dataRoot) {
  const roots = []
  for (const path of [join(dataRoot, '.claude'), join(dataRoot, '.codex'), join(dataRoot, '.config')]) {
    try { if ((await lstat(path)).isDirectory()) roots.push(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return roots
}
async function regularFileOrMissing(path, label) {
  try { const value = await lstat(path); if (!value.isFile() || value.isSymbolicLink()) throw new Error(`${label} must be a regular file`); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}
async function directoryState(path) {
  try { const value = await lstat(path); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`${path} must be a real directory`); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}
async function assertDirectory(path, label) { if (!await directoryState(path)) throw new Error(`${label} is missing`) }
async function assertMissing(path, label) { try { await lstat(path); throw new Error(`${label} already exists`) } catch (error) { if (error?.code !== 'ENOENT') throw error } }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function runCommand(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${String(code)}`)))
  })
}
