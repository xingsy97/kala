#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const files = walk(join(root, 'scripts')).filter((path) => path.endsWith('.test.mjs'))
const vitestFiles = files.filter((path) => readFileSync(path, 'utf8').includes("from 'vitest'"))
const nodeFiles = files.filter((path) => !vitestFiles.includes(path))

if (nodeFiles.length > 0) run(process.execPath, ['--test', ...nodeFiles])
if (vitestFiles.length > 0) run('pnpm', ['exec', 'vitest', 'run', ...vitestFiles])

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
