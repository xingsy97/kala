#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(option('--output') ?? join(root, 'release/kala-private-cloud'))
const target = option('--target') ?? `${process.platform}-${process.arch}`
const expected = process.platform === 'linux' ? `linux-${process.arch}` : `${process.platform}-${process.arch}`
if (target !== expected || !['linux-x64', 'linux-arm64'].includes(target)) throw new Error(`operator native target ${target} must match a Linux x64/arm64 runner (${expected})`)
const workspace = join(dirname(output), `.private-cloud-operator-${target}`)
rmSync(workspace, { recursive: true, force: true }); mkdirSync(workspace, { recursive: true })
const cjs = join(workspace, 'kala-private-cloud.cjs'); const blob = join(workspace, 'kala-private-cloud.blob'); const config = join(workspace, 'sea-config.json')
await build({ entryPoints: [join(root, 'scripts/deploy/runlab-private-cloud.mjs')], outfile: cjs, bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'silent' })
writeFileSync(cjs, readFileSync(cjs, 'utf8').replace('#!/usr/bin/env node\n', ''))
writeFileSync(config, `${JSON.stringify({ main: cjs, output: blob, disableExperimentalSEAWarning: true }, null, 2)}\n`)
run(process.execPath, ['--experimental-sea-config', config]); copyFileSync(process.execPath, output)
run('pnpm', ['exec', 'postject', output, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'])
chmodSync(output, 0o755); rmSync(workspace, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify({ ok: true, target, output: basename(output) })}\n`)
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function run(command, args) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' }); if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`) }
