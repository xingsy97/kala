import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { generationLinkPlan } from './update.js'

export type ManagedGenerationInstall = {
  generation: string
  executable: string
  installed: boolean
}

export function managedInstallSourceExecutable(
  execPath: string,
  argvEntry: string | undefined,
): string {
  if (!/^node(?:\.exe)?$/iu.test(basename(execPath))) return execPath
  if (!argvEntry) throw new Error('Node.js Executor installer is missing its script path')
  return resolve(argvEntry)
}

export function installManagedGeneration(
  sourceExecutable: string,
  managedRoot: string,
  release: string,
  invalidExistingExecutable?: string,
): ManagedGenerationInstall {
  const plan = generationLinkPlan(managedRoot, release)
  const executable = join(plan.generation, 'runlab-executor')
  mkdirSync(plan.generation, { recursive: true, mode: 0o700 })

  let installed = false
  if (invalidExistingExecutable && existsSync(executable) && filesEqual(executable, invalidExistingExecutable)) {
    rmSync(executable, { force: true })
  }
  if (!existsSync(executable)) {
    const temporary = `${executable}.install-${process.pid}`
    try {
      rmSync(temporary, { force: true })
      copyFileSync(sourceExecutable, temporary)
      chmodSync(temporary, 0o755)
      renameSync(temporary, executable)
      installed = true
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  const pointer = `${plan.current}.install-${process.pid}`
  try {
    rmSync(pointer, { recursive: true, force: true })
    symlinkSync(plan.generation, pointer, process.platform === 'win32' ? 'junction' : 'dir')
    renameSync(pointer, plan.current)
  } finally {
    rmSync(pointer, { recursive: true, force: true })
  }

  return { generation: plan.generation, executable, installed }
}

function filesEqual(left: string, right: string): boolean {
  if (statSync(left).size !== statSync(right).size) return false
  const leftFd = openSync(left, 'r')
  const rightFd = openSync(right, 'r')
  const leftBuffer = Buffer.allocUnsafe(64 * 1024)
  const rightBuffer = Buffer.allocUnsafe(64 * 1024)
  try {
    while (true) {
      const leftBytes = readSync(leftFd, leftBuffer)
      const rightBytes = readSync(rightFd, rightBuffer)
      if (leftBytes !== rightBytes) return false
      if (leftBytes === 0) return true
      if (!leftBuffer.subarray(0, leftBytes).equals(rightBuffer.subarray(0, rightBytes))) return false
    }
  } finally {
    closeSync(leftFd)
    closeSync(rightFd)
  }
}
