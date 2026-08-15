import { cp, lstat, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const PROVIDER_FILES = ['.claude/settings.json', '.config/agent-kernel/models.json', '.config/agent-kernel/agent-settings.json']

export async function moveStandaloneData(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const dataRoot = resolve(options.dataRoot)
  const sourceState = sourceRoot.endsWith('/.agent-kernel') ? sourceRoot : join(sourceRoot, '.agent-kernel')
  const legacyHome = sourceState.slice(0, -'/.agent-kernel'.length)
  const targetState = join(dataRoot, '.agent-kernel')
  const run = options.run ?? runCommand
  const legacyOwner = options.legacyOwner ?? 'ubuntu:ubuntu'
  const targetOwner = options.targetOwner ?? 'agent-runlab:agent-runlab'
  const copied = []
  let moved = false

  await assertDirectory(sourceState, 'legacy state')
  await assertMissing(targetState, 'target state')
  await mkdir(dataRoot, { recursive: true, mode: 0o711 })
  const [sourceFs, targetFs] = await Promise.all([stat(sourceState), stat(dataRoot)])
  if (sourceFs.dev !== targetFs.dev) throw new Error('legacy and target state must be on the same filesystem for atomic move migration')

  try {
    await rename(sourceState, targetState)
    moved = true
    for (const relative of PROVIDER_FILES) {
      const source = join(legacyHome, relative)
      const target = join(dataRoot, relative)
      try {
        await assertMissing(target, `target provider file ${relative}`)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await cp(source, target, { force: false, errorOnExist: true })
        copied.push(target)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const roots = await existingProviderRoots(dataRoot)
    await run('chown', ['-R', targetOwner, targetState, ...roots])
    return { schemaVersion: 1, mode: 'atomic-move', sourceState, targetState, legacyHome, legacyOwner, targetOwner, copied }
  } catch (error) {
    for (const target of copied.reverse()) await rm(target, { force: true }).catch(() => undefined)
    if (moved) {
      await run('chown', ['-R', legacyOwner, targetState]).catch(() => undefined)
      await rename(targetState, sourceState).catch(() => undefined)
    }
    throw error
  }
}

export async function rollbackStandaloneData(migration, options = {}) {
  if (!migration || migration.mode !== 'atomic-move') throw new Error('invalid Standalone data migration receipt')
  const run = options.run ?? runCommand
  await assertDirectory(migration.targetState, 'migrated state')
  await assertMissing(migration.sourceState, 'legacy rollback target')
  for (const target of [...migration.copied].reverse()) await rm(target, { force: true }).catch(() => undefined)
  await run('chown', ['-R', migration.legacyOwner, migration.targetState])
  await rename(migration.targetState, migration.sourceState)
}

async function existingProviderRoots(dataRoot) {
  const roots = []
  for (const path of [join(dataRoot, '.claude'), join(dataRoot, '.config')]) {
    try { if ((await lstat(path)).isDirectory()) roots.push(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return roots
}
async function assertDirectory(path, label) {
  const value = await lstat(path)
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
}
async function assertMissing(path, label) {
  try { await lstat(path); throw new Error(`${label} already exists`) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}
function runCommand(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${String(code)}`)))
  })
}
