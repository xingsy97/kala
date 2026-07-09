#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'release')
const dashboardDist = join(root, 'packages/dashboard/dist')
const component = parseComponent(process.argv.slice(2))

mkdirSync(outDir, { recursive: true })

const allEntries = [
  {
    name: 'agent-kernel-host',
    component: 'host',
    entry: join(root, 'packages/host/bin/agent-kernel-host.ts'),
  },
  {
    name: 'agent-kernel-executor',
    component: 'executor',
    entry: join(root, 'packages/executor/bin/agent-kernel-executor.ts'),
  },
]
const entries = allEntries.filter((entry) => component === 'all' || entry.component === component)
const includeDashboard = component === 'all' || component === 'host' || component === 'dashboard'
const expectedAssets = [
  ...allEntries.map((entry) => `${entry.name}.cjs`),
  'agent-kernel-dashboard-dist.tar.gz',
  'manifest.json',
  'SHA256SUMS',
]

for (const asset of expectedAssets) {
  rmSync(join(outDir, asset), { force: true })
}

if (includeDashboard) {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'])
}

for (const item of entries) {
  const outfile = join(outDir, `${item.name}.cjs`)
  await build({
    entryPoints: [item.entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  const bundled = readFileSync(outfile, 'utf8')
  writeFileSync(outfile, keepSingleShebang(bundled))
  chmodSync(outfile, 0o755)
}

if (includeDashboard) {
  await run('tar', [
    '-czf',
    join(outDir, 'agent-kernel-dashboard-dist.tar.gz'),
    '-C',
    dashboardDist,
    '.',
  ])
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  component,
  node: '>=22',
  assets: entries
    .map((item) => `${item.name}.cjs`)
    .concat(includeDashboard ? ['agent-kernel-dashboard-dist.tar.gz'] : []),
  notes: [
    'host and executor assets are single-file Node.js executables, not native binaries',
    'host releases include the dashboard dist because agent-kernel-host serves it when DASHBOARD_DIR is set',
  ],
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const files = [
  ...manifest.assets,
  'manifest.json',
]
const sums = files
  .map((file) => `${sha256(join(outDir, file))}  ${file}`)
  .join('\n')
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`)

console.log(`release assets written to ${outDir}`)
for (const file of [...files, 'SHA256SUMS']) {
  console.log(` - ${basename(file)}`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function keepSingleShebang(text) {
  const shebang = '#!/usr/bin/env node\n'
  if (!text.startsWith(shebang)) return text
  return shebang + text.slice(shebang.length).replaceAll(shebang, '')
}

function parseComponent(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const value = normalized[0] === '--component' ? normalized[1] : 'all'
  const allowed = new Set(['all', 'host', 'executor', 'dashboard'])
  if (!allowed.has(value)) {
    throw new Error(`unknown release component ${value}; expected all, host, executor, or dashboard`)
  }
  return value
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}`))
    })
  })
}
