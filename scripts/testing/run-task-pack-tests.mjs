#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const taskPacksRoot = join(root, 'task-packs')
let failures = 0

for (const family of readdirSync(taskPacksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  const familyDir = join(taskPacksRoot, family.name)
  for (const task of readdirSync(familyDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const cwd = join(familyDir, task.name)
    const result = spawnSync(process.execPath, ['--test'], { cwd, stdio: 'inherit' })
    if (result.status !== 0) failures += 1
  }
}

if (failures > 0) {
  console.error(`${failures} task-pack test suite(s) failed`)
  process.exit(1)
}
