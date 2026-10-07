import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const WINDOWS_EXECUTOR_TARGET = 'win32-x64'
export const WINDOWS_NODE_PTY_BINARY_FILES = Object.freeze([
  'conpty.node',
  'conpty_console_list.node',
  'pty.node',
  'winpty-agent.exe',
  'winpty.dll',
])
export const WINDOWS_NODE_PTY_JS_FILES = Object.freeze([
  'worker/conoutSocketWorker.js',
  'shared/conout.js',
])
export const WINDOWS_NODE_PTY_FILES = Object.freeze([
  ...WINDOWS_NODE_PTY_BINARY_FILES.map((name) => `prebuilds/${WINDOWS_EXECUTOR_TARGET}/${name}`),
  ...WINDOWS_NODE_PTY_JS_FILES,
])

const ARCHIVE_ENTRIES = Object.freeze([
  'node-pty-companion.json',
  `${WINDOWS_EXECUTOR_TARGET}/`,
  ...WINDOWS_NODE_PTY_BINARY_FILES.map((name) => `${WINDOWS_EXECUTOR_TARGET}/${name}`),
  'worker/',
  'worker/conoutSocketWorker.js',
  'shared/',
  'shared/conout.js',
])

export function windowsNodePtyCompanionAssetName(target = WINDOWS_EXECUTOR_TARGET) {
  assertWindowsExecutorTarget(target)
  return `node-pty-${target}.tar.gz`
}

export function packageWindowsNodePtyCompanion({ nodePtyRoot, outputPath, target = WINDOWS_EXECUTOR_TARGET }) {
  assertWindowsExecutorTarget(target)
  const packageJsonPath = join(nodePtyRoot, 'package.json')
  if (!existsSync(packageJsonPath)) throw new Error('node-pty package metadata is missing')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (packageJson.name !== 'node-pty' || typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
    throw new Error('node-pty package identity is invalid')
  }

  const sources = [
    ...WINDOWS_NODE_PTY_BINARY_FILES.map((name) => ({
      source: join(nodePtyRoot, 'prebuilds', target, name),
      archivePath: `${target}/${name}`,
      runtimePath: `prebuilds/${target}/${name}`,
      pe: true,
    })),
    ...WINDOWS_NODE_PTY_JS_FILES.map((path) => ({
      source: join(nodePtyRoot, 'lib', ...path.split('/')),
      archivePath: path,
      runtimePath: path,
      pe: false,
    })),
  ]
  const files = sources.map(({ source, runtimePath, pe }) => {
    if (!existsSync(source) || !lstatSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`node-pty ${target} runtime is missing ${runtimePath}`)
    }
    const bytes = readFileSync(source)
    if (pe) assertWindowsX64Pe(bytes, runtimePath)
    return {
      path: runtimePath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })

  const stage = mkdtempSync(join(tmpdir(), 'kala-node-pty-'))
  try {
    for (const source of sources) {
      const destination = join(stage, ...source.archivePath.split('/'))
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(source.source, destination, { recursive: false, force: false })
    }
    const manifest = {
      schemaVersion: 1,
      product: 'kala-executor-node-pty-companion',
      target,
      nodePtyVersion: packageJson.version,
      files,
    }
    writeFileSync(join(stage, 'node-pty-companion.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const packed = spawnSync('tar', ['-czf', outputPath, '-C', stage, 'node-pty-companion.json', target, 'worker', 'shared'], { encoding: 'utf8' })
    if (packed.status !== 0) throw new Error(`failed to package ${basename(outputPath)}: ${packed.stderr || packed.error?.message || packed.status}`)
    if (!existsSync(outputPath) || statSync(outputPath).size === 0) throw new Error(`failed to package ${basename(outputPath)}`)
    verifyWindowsNodePtyCompanion(outputPath, { expectedNodePtyVersion: packageJson.version, target })
    return manifest
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function verifyWindowsNodePtyCompanion(archivePath, { expectedNodePtyVersion, target = WINDOWS_EXECUTOR_TARGET } = {}) {
  assertWindowsExecutorTarget(target)
  const listed = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`failed to inspect ${basename(archivePath)}: ${listed.stderr || listed.error?.message || listed.status}`)
  const entries = listed.stdout.split(/\r?\n/u).map((entry) => entry.replace(/^\.\//u, '')).filter(Boolean)
  if (new Set(entries).size !== entries.length || !sameSorted(entries, ARCHIVE_ENTRIES)) {
    throw new Error(`${basename(archivePath)} contains an unexpected file inventory`)
  }

  const stage = mkdtempSync(join(tmpdir(), 'kala-node-pty-verify-'))
  try {
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', stage], { encoding: 'utf8' })
    if (extracted.status !== 0) throw new Error(`failed to extract ${basename(archivePath)}: ${extracted.stderr || extracted.error?.message || extracted.status}`)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(stage, 'node-pty-companion.json'), 'utf8'))
    } catch (error) {
      throw new Error('ConPTY companion manifest is not valid JSON', { cause: error })
    }
    assertManifest(manifest, target, expectedNodePtyVersion)
    for (const file of manifest.files) {
      const archiveRelative = file.path.startsWith(`prebuilds/${target}/`)
        ? file.path.slice('prebuilds/'.length)
        : file.path
      const path = join(stage, ...archiveRelative.split('/'))
      if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`ConPTY companion is missing ${file.path}`)
      const bytes = readFileSync(path)
      if (bytes.length !== file.bytes) throw new Error(`ConPTY companion size mismatch for ${file.path}`)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== file.sha256) throw new Error(`ConPTY companion checksum mismatch for ${file.path}`)
    }
    return manifest
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function assertManifest(manifest, target, expectedNodePtyVersion) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || manifest.product !== 'kala-executor-node-pty-companion'
    || manifest.target !== target
    || typeof manifest.nodePtyVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.nodePtyVersion)
    || (expectedNodePtyVersion !== undefined && manifest.nodePtyVersion !== expectedNodePtyVersion)
    || !Array.isArray(manifest.files)
    || manifest.files.length !== WINDOWS_NODE_PTY_FILES.length) {
    throw new Error('ConPTY companion manifest identity is invalid')
  }
  const paths = manifest.files.map((file) => file?.path)
  if (new Set(paths).size !== paths.length || !sameSorted(paths, WINDOWS_NODE_PTY_FILES)) {
    throw new Error('ConPTY companion manifest file inventory is invalid')
  }
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || !WINDOWS_NODE_PTY_FILES.includes(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || !sameSorted(Object.keys(file), ['bytes', 'path', 'sha256'])) {
      throw new Error('ConPTY companion manifest file metadata is invalid')
    }
  }
}

function sameSorted(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function assertWindowsX64Pe(bytes, label) {
  const peOffset = bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a ? bytes.readUInt32LE(0x3c) : -1
  const hasPeSignature = peOffset >= 0 && peOffset + 6 <= bytes.length && bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
  const machine = hasPeSignature ? bytes.readUInt16LE(peOffset + 4) : -1
  if (!hasPeSignature || machine !== 0x8664) throw new Error(`node-pty ${label} is not a Windows x64 PE binary`)
}

function assertWindowsExecutorTarget(target) {
  if (target !== WINDOWS_EXECUTOR_TARGET) throw new Error(`unsupported Windows Executor target ${target}`)
}
