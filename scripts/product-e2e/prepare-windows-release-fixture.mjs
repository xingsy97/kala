#!/usr/bin/env node
// A source-built product E2E fixture, NOT a signed release candidate. Real RC
// acceptance separately downloads and verifies the exact published assets.
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { generateExecutorInstallerPowerShell } from '../release/executor-installer.mjs'

const hostDir = resolve(required('--host-release'))
const executorDir = resolve(required('--executor-release'))
if (hostDir === executorDir) throw new Error('Windows Host and native Executor build outputs must be separate')
const windowsAssets = ['kala-executor-win32-x64.exe', 'node-pty-win32-x64.tar.gz', 'install-executor.ps1']
const checksumPath = join(hostDir, 'SHA256SUMS')
const lines = readFileSync(checksumPath, 'utf8').trimEnd().split(/\r?\n/u)
const names = new Set()
for (const line of lines) {
  const match = line.match(/^[0-9a-f]{64}  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u)
  if (!match || names.has(match[1]) || windowsAssets.includes(match[1])) throw new Error('Host build has an invalid or preexisting Windows checksum entry')
  names.add(match[1])
  const actual = createHash('sha256').update(readFileSync(join(hostDir, match[1]))).digest('hex')
  if (actual !== line.slice(0, 64)) throw new Error(`Host source-built asset checksum mismatch: ${match[1]}`)
}
if (!names.has('kala-dashboard-with-runtime.cjs')) throw new Error('Host CJS must already be in the local release checksum index')
for (const name of windowsAssets.slice(0, 2)) copyFileSync(join(executorDir, name), join(hostDir, name))
writeFileSync(join(hostDir, 'install-executor.ps1'), generateExecutorInstallerPowerShell({ repo: 'xingsy97/kala', tag: 'latest' }))
for (const name of windowsAssets) {
  const file = join(hostDir, name)
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  lines.push(`${digest}  ${basename(file)}`)
}
writeFileSync(checksumPath, lines.join('\n') + '\n')
process.stdout.write('Windows source-built Host/Executor integration fixture ready (not signed release evidence)\n')

function required(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${flag}`)
  return process.argv[index + 1]
}
