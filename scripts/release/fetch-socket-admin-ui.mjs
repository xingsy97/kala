#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const outDir = join(root, '.presq/socket.io-admin-ui/dist')

const hostRequire = createRequire(new URL('../../packages/host/package.json', import.meta.url))
const packageJsonPath = hostRequire.resolve('@socket.io/admin-ui/package.json')
const packageRoot = dirname(packageJsonPath)
const sourceDir = join(packageRoot, 'ui/dist')

if (!existsSync(join(sourceDir, 'index.html'))) {
  throw new Error(`Socket.IO Admin UI package dist missing index.html at ${sourceDir}`)
}

rmSync(outDir, { force: true, recursive: true })
mkdirSync(outDir, { recursive: true })
cpSync(sourceDir, outDir, { recursive: true })
console.log(`Socket.IO Admin UI dist prepared at ${outDir}`)
