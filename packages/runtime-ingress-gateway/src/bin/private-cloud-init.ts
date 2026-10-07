#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { lchown, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const CONTROL_UID = 65532
const CONTROL_GID = 65532

interface PrivateCloudInitDependencies {
  runScript: (scriptPath: string, environment: NodeJS.ProcessEnv) => Promise<void>
  chownTree: (path: string, uid: number, gid: number) => Promise<void>
  isFile: (path: string) => Promise<boolean>
  readSecret: (path: string) => Promise<string>
}

interface PrivateCloudInitOptions {
  environment?: NodeJS.ProcessEnv
  dependencies?: Partial<PrivateCloudInitDependencies>
}

export async function initializePrivateCloudControlPlane(options: PrivateCloudInitOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env
  const dependencies = { ...defaultDependencies, ...options.dependencies }
  const packageRoot = environment.KALA_INGRESS_PACKAGE_ROOT ?? '/app/packages/runtime-ingress-gateway'
  const controlDataDir = environment.KALA_INGRESS_CONTROL_DATA_DIR ?? '/control'
  const passwordFile = environment.KALA_INGRESS_CONTROL_POSTGRES_PASSWORD_FILE ?? '/run/secrets/control_postgres_password'
  const password = stripTrailingNewlines(await dependencies.readSecret(passwordFile))
  if (!password) throw new Error('control PostgreSQL password file is empty')

  const databaseEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    KALA_INGRESS_ADMIN_DATABASE_URL: postgresUrl(password, 'postgres'),
    KALA_INGRESS_DATABASE_URL: postgresUrl(password, 'runlab_control'),
    KALA_INGRESS_MIGRATIONS_DIR: environment.KALA_INGRESS_MIGRATIONS_DIR ?? join(packageRoot, 'migrations'),
  }

  await dependencies.runScript(join(packageRoot, 'dist/src/bin/init-control-plane.js'), databaseEnvironment)
  await dependencies.chownTree(controlDataDir, CONTROL_UID, CONTROL_GID)

  const legacyDirectory = join(controlDataDir, 'tenant-directory.json')
  if (await dependencies.isFile(legacyDirectory)) {
    await dependencies.runScript(join(packageRoot, 'dist/src/bin/import-json-control.js'), {
      ...databaseEnvironment,
      KALA_INGRESS_JSON_DIRECTORY: legacyDirectory,
      KALA_INGRESS_JSON_SESSIONS: join(controlDataDir, 'login-states.json.sessions'),
      KALA_INGRESS_JSON_BACKUP_PREFIX: join(controlDataDir, 'pre-postgres'),
    })
  }
}

const defaultDependencies: PrivateCloudInitDependencies = {
  runScript: runNodeScript,
  chownTree,
  isFile,
  readSecret: (path) => readFile(path, 'utf8'),
}

function postgresUrl(password: string, database: string): string {
  const url = new URL(`postgresql://control-postgres:5432/${database}`)
  url.username = 'runlab'
  url.password = password
  url.searchParams.set('sslmode', 'disable')
  return url.toString()
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/u, '')
}

async function runNodeScript(scriptPath: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`control-plane helper failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`})`))
    })
  })
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const childPath = join(path, entry.name)
    if (entry.isDirectory()) await chownTree(childPath, uid, gid)
    else await lchown(childPath, uid, gid)
  }
  await lchown(path, uid, gid)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  initializePrivateCloudControlPlane().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
