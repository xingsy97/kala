#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const current = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' })
if (current.status === 0 && current.stdout.trim() && current.stdout.trim() !== '.githooks') {
  process.stderr.write(`Refusing to replace existing core.hooksPath=${current.stdout.trim()}\n`)
  process.exit(1)
}
const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
process.stdout.write('Installed repository Git hooks via core.hooksPath=.githooks\n')
