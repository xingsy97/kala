#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const taskPacksRoot = join(root, 'task-packs')
let failures = 0
let discovered = 0

for (const family of readdirSync(taskPacksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  const familyDir = join(taskPacksRoot, family.name)
  for (const task of readdirSync(familyDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const cwd = join(familyDir, task.name)
    const testsDirectory = join(cwd, 'tests')
    const testFiles = existsSync(testsDirectory)
      ? readdirSync(testsDirectory, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.test\.[cm]?js$/u.test(entry.name))
      : []
    if (testFiles.length === 0) {
      console.error(`No task-pack tests discovered in ${family.name}/${task.name}`)
      failures += 1
      continue
    }
    discovered += testFiles.length
    const result = spawnSync(process.execPath, ['--test'], { cwd, stdio: 'inherit' })
    if (result.status !== 0) failures += 1
  }
}

if (discovered === 0) {
  console.error('No task-pack tests discovered under task-packs/**/tests')
  process.exit(1)
}

if (failures > 0) {
  console.error(`${failures} task-pack test suite(s) failed`)
  process.exit(1)
}
