import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const WINDOWS_EXECUTOR_TARGET = 'win32-x64'
export const WINDOWS_NODE_PTY_FILES = Object.freeze([
  'conpty.node',
  'conpty_console_list.node',
  'pty.node',
  'winpty-agent.exe',
  'winpty.dll',
])

export function windowsNodePtyCompanionAssetName(target = WINDOWS_EXECUTOR_TARGET) {
  assertWindowsExecutorTarget(target)
  return `node-pty-${target}.tar.gz`
}

export function packageWindowsNodePtyCompanion({ nodePtyRoot, outputPath, target = WINDOWS_EXECUTOR_TARGET }) {
  assertWindowsExecutorTarget(target)
  const packageJsonPath = join(nodePtyRoot, 'package.json')
  const sourceDir = join(nodePtyRoot, 'prebuilds', target)
  if (!existsSync(packageJsonPath)) throw new Error('node-pty package metadata is missing')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (packageJson.name !== 'node-pty' || typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
    throw new Error('node-pty package identity is invalid')
  }

  const files = WINDOWS_NODE_PTY_FILES.map((name) => {
    const source = join(sourceDir, name)
    if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`node-pty ${target} runtime is missing ${name}`)
    }
    const bytes = readFileSync(source)
    assertWindowsX64Pe(bytes, `${target}/${name}`)
    return {
      path: `prebuilds/${target}/${name}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })

  const stage = mkdtempSync(join(tmpdir(), 'kala-node-pty-'))
  try {
    const stagedTarget = join(stage, target)
    mkdirSync(stagedTarget, { recursive: true })
    for (const file of files) {
      const name = basename(file.path)
      cpSync(join(sourceDir, name), join(stagedTarget, name), { recursive: false, force: false })
    }
    const manifest = {
      schemaVersion: 1,
      product: 'kala-executor-node-pty-companion',
      target,
      nodePtyVersion: packageJson.version,
      files,
    }
    writeFileSync(join(stage, 'node-pty-companion.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const packed = spawnSync('tar', ['-czf', outputPath, '-C', stage, 'node-pty-companion.json', target], { encoding: 'utf8' })
    if (packed.status !== 0) throw new Error(`failed to package ${basename(outputPath)}: ${packed.stderr || packed.error?.message || packed.status}`)
    if (!existsSync(outputPath) || statSync(outputPath).size === 0) throw new Error(`failed to package ${basename(outputPath)}`)
    return manifest
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
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
