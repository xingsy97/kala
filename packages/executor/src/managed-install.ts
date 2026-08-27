import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { generationLinkPlan } from './update.js'

export type ManagedGenerationInstall = {
  generation: string
  executable: string
  installed: boolean
}

export function installManagedGeneration(
  sourceExecutable: string,
  managedRoot: string,
  release: string,
): ManagedGenerationInstall {
  const plan = generationLinkPlan(managedRoot, release)
  const executable = join(plan.generation, 'runlab-executor')
  mkdirSync(plan.generation, { recursive: true, mode: 0o700 })

  let installed = false
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
