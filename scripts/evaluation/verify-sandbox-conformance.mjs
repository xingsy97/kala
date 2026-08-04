import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { runSandboxConformance } from '../../adapters/environments/common/dist/index.js'
import { DockerSandboxProvider } from '../../adapters/environments/docker/dist/index.js'
import { createLxdContainerProvider } from '../../adapters/environments/lxd-container/dist/index.js'
import { createLxdVmProvider } from '../../adapters/environments/lxd-vm/dist/index.js'

const providers = values('--provider')
const selected = providers.length > 0 ? providers : ['docker', 'lxd-container', 'lxd-vm']
const supported = new Set(['docker', 'lxd-container', 'lxd-vm'])
for (const provider of selected) if (!supported.has(provider)) throw new Error('unsupported provider: ' + provider)

const definitions = {
  docker: {
    create: () => new DockerSandboxProvider(),
    policy: { provider: 'docker', imageDigest: option('--docker-image') ?? 'alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 1024, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] },
  },
  'lxd-container': {
    create: createLxdContainerProvider,
    policy: { provider: 'lxd-container', imageDigest: option('--lxd-container-image') ?? '9c68ebff3356', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 512, diskMb: 2048, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] },
  },
  'lxd-vm': {
    create: createLxdVmProvider,
    policy: { provider: 'lxd-vm', imageDigest: option('--lxd-vm-image') ?? 'e934afab20c7', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 1024, diskMb: 4096, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] },
  },
}

const results = []
for (const name of selected) {
  const definition = definitions[name]
  const provider = definition.create()
  const preflight = await provider.preflight(definition.policy)
  if (!preflight.ok) throw new Error(name + ' preflight failed: ' + preflight.errors.map((error) => error.code + ': ' + error.message).join('; '))
  const result = await runSandboxConformance(provider, definition.policy)
  const failed = Object.entries(result.checks).filter(([, passed]) => !passed).map(([check]) => check)
  results.push({ name, descriptor: provider.descriptor, policy: definition.policy, preflight, result })
  if (failed.length > 0) throw new Error(name + ' conformance failed: ' + failed.join(', '))
}

const sourcePaths = [
  'adapters/environments/common/src/conformance.ts',
  'adapters/environments/common/src/lxd.ts',
  'adapters/environments/docker/src/index.ts',
  'adapters/environments/lxd-container/src/index.ts',
  'adapters/environments/lxd-vm/src/index.ts',
  'scripts/evaluation/verify-sandbox-conformance.mjs',
  'pnpm-lock.yaml',
]
const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(path)))])))
const sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve('.'), encoding: 'utf8' }).stdout.trim() || 'unknown'
const sourceBundleSha256 = sha256(Buffer.from(Object.entries(sourceFiles).map(([path, hash]) => path + ':' + hash).join('\n') + '\n'))
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), nodeVersion: process.version, sourceRevision, sourceBundleSha256, sourceFiles, providers: results }
const output = option('--output')
if (output) {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}
process.stdout.write(JSON.stringify({ ok: true, providers: results.map((entry) => ({ name: entry.name, checks: entry.result.checks, imageDigest: entry.result.evidence.environmentLock?.imageDigest, version: entry.preflight.resolvedVersion })), output: output ? resolve(output) : undefined }) + '\n')

function values(name) { const output = []; for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) output.push(process.argv[++index]); else if (process.argv[index]?.startsWith(name + '=')) output.push(process.argv[index].slice(name.length + 1)); return output }
function option(name) { return values(name).at(-1) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
