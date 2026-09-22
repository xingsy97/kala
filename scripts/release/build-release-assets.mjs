#!/usr/bin/env node
import { copyFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import {
  executorNativeAssetName,
  generateExecutorInstallerPs1,
  generateExecutorInstallerSh,
  legacyExecutorNativeAssetName,
} from './executor-installer.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const outDir = join(root, 'release')
const dashboardDist = join(root, 'packages/dashboard/dist')
const docsDir = join(root, 'docs')
const modelCatalogSeed = join(root, 'resources', 'model-catalog', 'models-dev-seed.json')
const socketAdminDist = resolveSocketAdminDist()
const options = parseOptions(process.argv.slice(2))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sourceIdentity = readSourceIdentity()
const { component, tag, nativeOnly, finalizeOnly, noNative, skipDashboardBuild, skipPackageBuild } = options
const repo = options.repo ?? repoFromPackageJson(packageJson)
if (!repo && component !== 'dashboard') {
  throw new Error('release repo is required; pass --repo owner/name or set GITHUB_REPOSITORY')
}
const wantsNativeBuild = !finalizeOnly && (nativeOnly || !noNative)
const currentNativeTarget = wantsNativeBuild ? detectNativeTarget() : undefined
const nativeTarget = wantsNativeBuild ? options.nativeTarget ?? currentNativeTarget : undefined

if (!finalizeOnly) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const allEntries = [
  {
    name: 'agent-kernel-host',
    cjsName: 'bundle-dashboard-with-runtime',
    component: 'host',
    entry: join(root, 'packages/host/bin/agent-kernel-host.ts'),
  },
  {
    name: 'agent-runlab-runtime',
    component: 'host',
    entry: join(root, 'packages/host/bin/agent-kernel-host.ts'),
    platformOnly: true,
  },
  {
    name: 'agent-kernel-executor',
    component: 'executor',
    entry: join(root, 'packages/executor/bin/agent-kernel-executor.ts'),
  },
  {
    name: 'agent-runlab-dedicated-ingress',
    component: 'host',
    entry: join(root, 'packages/host/bin/agent-runlab-dedicated-ingress.ts'),
  },
  {
    name: 'agent-runlab-dedicated-deploy-supervisor',
    component: 'host',
    entry: join(root, 'packages/host/bin/agent-runlab-dedicated-deploy-supervisor.ts'),
  },
]
const entries = allEntries.filter((entry) => component === 'all' || entry.component === component)
const includeDashboard = component === 'all' || component === 'host' || component === 'dashboard'
const nativeTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']
if (finalizeOnly) {
  finalizeRelease()
  process.exit(0)
}

if (wantsNativeBuild && nativeTarget !== currentNativeTarget) {
  throw new Error(`native target ${nativeTarget} does not match this runner (${currentNativeTarget}); Node SEA builds are not cross-compiled`)
}

if (!nativeOnly && !skipPackageBuild) {
  await run('pnpm', ['--filter', '@agent-kernel/kernel', 'build'])
  await run('pnpm', ['--filter', '@agent-kernel/shared', 'build'])
  await run('pnpm', ['--filter', '@agent-kernel/executor', 'build'])
  await run('pnpm', ['--filter', '@agent-kernel/host', 'build'])
}

// Dashboard imports generated declarations from kernel/shared. Build those
// packages first or a clean production build can typecheck against stale dist.
if (includeDashboard && !skipDashboardBuild) {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'])
}
if (includeDashboard && skipDashboardBuild) {
  assertDashboardDistReady(dashboardDist)
}

// The host bundle is built before finalizeRelease(), so every asset that must be
// served from an embedded-only deployment has to exist before the host banner is
// generated. Keep this in front of buildEntries; moving it back below the host
// build silently produces a valid bundle with broken /install/assets URLs.
prepareBootstrapAssets()

const buildEntries = [...entries].sort((a, b) => {
  if (a.component === 'host' && b.component !== 'host') return 1
  if (b.component === 'host' && a.component !== 'host') return -1
  return 0
})

for (const item of buildEntries) {
  const embedsHostRuntime = item.name === 'agent-kernel-host' || item.name === 'agent-runlab-runtime'
  const embedsDashboard = item.name === 'agent-kernel-host' && includeDashboard
  const embeddedReleaseAssets = embedsHostRuntime
    ? prepareEmbeddedReleaseAssetsForHost()
    : ''
  const embeddedDashboard = embedsDashboard
    ? embeddedDashboardBanner(dashboardDist)
    : ''
  const embeddedDocs = embedsHostRuntime && includeDashboard
    ? embeddedDocsBanner(docsDir)
    : ''
  const embeddedSocketAdmin = embedsHostRuntime
    ? embeddedSocketAdminBanner(socketAdminDist)
    : ''
  const buildInfo = buildInfoBanner({ artifactKind: nativeOnly ? 'native' : 'cjs', dashboardMode: embedsDashboard ? 'embedded' : 'none', socketAdminMode: embedsHostRuntime ? 'embedded' : 'missing' })
  const outfile = nativeOnly
    ? join(outDir, '.sea', `${item.name}-${nativeTarget}`, `${item.name}.cjs`)
    : join(outDir, cjsAssetName(item))
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [item.entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    mainFields: ['module', 'main'],
    banner: { js: `#!/usr/bin/env node\n${buildInfo}${embeddedDashboard}${embeddedDocs}${embeddedSocketAdmin}${embeddedReleaseAssets}` },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  const bundled = readFileSync(outfile, 'utf8')
  writeFileSync(outfile, keepSingleShebang(bundled))
  if (!nativeOnly) chmodSync(outfile, 0o755)
  if (!item.platformOnly && (nativeOnly || !noNative)) {
    await buildNativeSea(item.name, outfile, nativeTarget)
    if (item.name === 'agent-kernel-executor') {
      copyFileSync(join(outDir, legacyExecutorNativeAssetName(nativeTarget)), join(outDir, executorNativeAssetName(nativeTarget)))
      chmodSync(join(outDir, executorNativeAssetName(nativeTarget)), 0o755)
    }
  }
}

if (nativeOnly) {
  if (component === 'all' || component === 'host') prepareCopilotRuntimeAsset(nativeTarget, false)
  removeNativeBuildWorkspace()
  console.log(`native release assets written to ${outDir} for ${nativeTarget}`)
  for (const item of entries) console.log(` - ${basename(nativeAssetName(item.name, nativeTarget))}`)
  process.exit(0)
}

if (includeDashboard) {
  await run('tar', ['-czf', join(outDir, 'agent-kernel-dashboard-dist.tar.gz'), '-C', dashboardDist, '.'])
  writeDashboardReleaseManifest(dashboardDist)
  await run('tar', ['-czf', join(outDir, 'agent-runlab-docs.tar.gz'), '-C', docsDir, '.'])
}

finalizeRelease()

console.log(`release assets written to ${outDir}`)
for (const file of [...releaseFiles(), 'SHA256SUMS']) {
  console.log(` - ${basename(file)}`)
}

function finalizeRelease() {
  assertSourceIdentityUnchanged()
  removeNativeBuildWorkspace()
  const bootstrapAssets = prepareBootstrapAssets()
  const copilotRuntimeAssets = component === 'all' || component === 'host'
    ? prepareCopilotRuntimeAsset(detectNativeTarget(), true)
    : []
  if (entries.some((entry) => entry.name === 'agent-kernel-executor') && currentNativeTarget && exists(executorNativeAssetName(currentNativeTarget))) writeExecutorUpdateManifest()
  if (includeDashboard && existsSync(modelCatalogSeed)) {
    copyFileSync(modelCatalogSeed, join(outDir, 'agent-runlab-model-catalog-seed.json'))
  }
  if (component !== 'dashboard') {
    if (component === 'all' || component === 'host') {
      for (const asset of [
        'deploy/dedicated-systemd/agent-runlab-dedicated-ingress.service',
        'deploy/dedicated-systemd/agent-runlab-dedicated-unit@.service',
        'deploy/dedicated-systemd/agent-runlab-dedicated-deploy-supervisor.service',
        'deploy/dedicated-systemd/agent-runlab-dedicated-control-updater.service',
        'deploy/dedicated-systemd/agent-runlab-dedicated-migration-finalizer.service',
        'deploy/dedicated-systemd/deployment.json',
        'scripts/deploy/install-dedicated-systemd.mjs',
        'scripts/deploy/runlab-dedicated.mjs',
        'scripts/deploy/deploy-dedicated.mjs',
        'scripts/deploy/deploy-dashboard.mjs',
        'scripts/deploy/cutover-dedicated-systemd.mjs',
        'scripts/deploy/dedicated-data-migration.mjs',
        'scripts/deploy/dedicated-settings-fingerprint.mjs',
        'scripts/deploy/update-dedicated-control-plane.mjs',
        'scripts/deploy/rollback-dedicated-systemd.mjs',
      ]) {
        const target = join(outDir, basename(asset))
        copyFileSync(join(root, asset), target)
        bootstrapAssets.push(basename(asset))
      }
    }
  }

  const builtEntries = entries.map((entry) => {
    const cjs = cjsAssetName(entry)
    const natives = nativeTargets
      .map((target) => nativeAssetName(entry.name, target))
      .filter((asset) => exists(asset))
    return { ...entry, cjs: exists(cjs) ? cjs : undefined, natives }
  })
  const executorProductNatives = nativeTargets.map(executorNativeAssetName).filter((asset) => exists(asset))
  const desktopPublicAssets = ['desktop-install.sh', 'desktop-package.deb', 'desktop-dependencies.json', 'desktop-SHA256SUMS.txt'].filter((name) => exists(name))
  writeDependencyMetadata()
  const assets = builtEntries.flatMap((entry) => [entry.cjs, ...entry.natives].filter(Boolean))
    .concat(executorProductNatives)
    .concat(copilotRuntimeAssets)
    .concat(includeDashboard && exists('agent-kernel-dashboard-dist.tar.gz') ? ['agent-kernel-dashboard-dist.tar.gz'] : [])
    .concat(includeDashboard && exists('dashboard-release.json') ? ['dashboard-release.json'] : [])
    .concat(includeDashboard && exists('agent-runlab-docs.tar.gz') ? ['agent-runlab-docs.tar.gz'] : [])
    .concat(includeDashboard && exists('agent-runlab-model-catalog-seed.json') ? ['agent-runlab-model-catalog-seed.json'] : [])
    .concat(bootstrapAssets)
    .concat(desktopPublicAssets)
    .concat(['sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt'])
    .concat(entries.some((entry) => entry.name === 'agent-kernel-executor') && exists('executor-update-manifest.json') ? ['executor-update-manifest.json', 'executor-update-public-key.pem'] : [])
  const hasNativeAssets = builtEntries.some((entry) => entry.natives.length > 0)
  const manifest = {
    name: packageJson.name,
    version: packageJson.version,
    source: sourceIdentity,
    component,
    repo: repo ?? '',
    tag,
    node: '>=22',
    nativeTargets: nativeTargets.filter((target) => builtEntries.some((entry) => entry.natives.includes(nativeAssetName(entry.name, target)))),
    assets,
    nativeAssets: {
      ...Object.fromEntries(builtEntries.map((entry) => [entry.name, entry.natives])),
      ...(entries.some((entry) => entry.name === 'agent-kernel-executor') ? { 'runlab-executor': executorProductNatives } : {}),
    },
    fallbackAssets: Object.fromEntries(builtEntries.map((entry) => [entry.name, entry.cjs]).filter(([, cjs]) => cjs)),
    notes: [
      hasNativeAssets
        ? 'runtime releases include native binaries plus Node.js .cjs fallback assets'
        : 'runtime releases include Node.js .cjs fallback assets; native binaries are added by the native release job',
      'run.sh is a wget-only bash bootstrap that uses compact .cjs assets when Node.js 22+ is available and falls back to native binaries otherwise',
      'install-executor.sh and install-executor.ps1 install only checksum-verified runlab-executor native assets; unsigned mode is development-only',
      'Portable uses bundle-dashboard-with-runtime.cjs with embedded dashboard assets; Self-hosted Platform uses agent-runlab-runtime.cjs plus an independently activated dashboard release',
    ],
  }

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(outDir, 'RELEASE_NOTES.md'), releaseNotes(manifest))

  writeSha256Sums(releaseFiles())
}

function prepareCopilotRuntimeAsset(target, includeGenericAlias) {
  const [platform, arch] = target.split('-')
  const packageName = `@github/copilot-${platform}-${arch}`
  const hostRequire = createRequire(new URL('../../packages/host/package.json', import.meta.url))
  const sdkEntry = hostRequire.resolve('@github/copilot-sdk')
  const sdkRequire = createRequire(sdkEntry)
  const copilotPackage = sdkRequire.resolve('@github/copilot/package.json')
  const copilotRequire = createRequire(copilotPackage)
  const source = copilotRequire.resolve(packageName)
  if (!existsSync(source)) throw new Error(`Copilot runtime binary is missing from ${packageName}`)
  const binaryAsset = `copilot-cli-${target}${platform === 'win32' ? '.exe' : ''}`
  const licenseAsset = 'COPILOT_CLI_LICENSE.md'
  copyFileSync(source, join(outDir, binaryAsset))
  copyFileSync(join(dirname(copilotPackage), 'LICENSE.md'), join(outDir, licenseAsset))
  chmodSync(join(outDir, binaryAsset), 0o755)
  if (includeGenericAlias) {
    copyFileSync(source, join(outDir, 'copilot-cli'))
    chmodSync(join(outDir, 'copilot-cli'), 0o755)
  }
  return [binaryAsset, ...(includeGenericAlias ? ['copilot-cli'] : []), licenseAsset]
}

function writeDependencyMetadata() {
  const inventory = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (inventory.status !== 0) throw new Error('production dependency license inventory failed')
  const classes = JSON.parse(inventory.stdout)
  const components = []
  for (const [reportedLicense, packages] of Object.entries(classes)) {
    for (const dependency of packages) {
      const license = reportedLicense === 'Unknown' && dependency.name === 'khroma'
        ? 'MIT'
        : reportedLicense === 'Unknown' && (dependency.name === '@github/copilot' || dependency.name.startsWith('@github/copilot-'))
          ? 'LicenseRef-GitHub-Copilot-CLI'
          : reportedLicense
      if (license === 'Unknown') throw new Error(`unreviewed dependency license: ${dependency.name}`)
      for (const version of dependency.versions) {
        const encodedName = dependency.name.startsWith('@')
          ? dependency.name.split('/').map(encodeURIComponent).join('/')
          : encodeURIComponent(dependency.name)
        components.push({ type: 'library', name: dependency.name, version, purl: `pkg:npm/${encodedName}@${encodeURIComponent(version)}`, licenses: [{ license: { id: license } }] })
      }
    }
  }
  components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'agent-runlab', version: packageJson.version },
      properties: [
        { name: 'agent-runlab:source-revision', value: sourceIdentity.revision },
        { name: 'agent-runlab:source-snapshot-sha256', value: sourceIdentity.snapshotSha256 },
      ],
    },
    components,
  }
  writeFileSync(join(outDir, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`)
  const notices = [
    `Kala ${packageJson.version} third-party dependency inventory`,
    '',
    'The packages below retain their own copyright and license terms.',
    'Consult each upstream package for the complete license text and notices.',
    '',
    ...components.map((item) => `${item.name}@${item.version} — ${item.licenses[0].license.id}`),
    '',
  ]
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'))
}

function prepareBootstrapAssets() {
  const bootstrapAssets = []
  if (component === 'dashboard' || nativeOnly) return bootstrapAssets
  const runPath = join(outDir, 'run.sh')
  writeFileSync(runPath, unifiedBootstrap({ repo, tag, component }))
  chmodSync(runPath, 0o755)
  bootstrapAssets.push('run.sh')
  if (component === 'all' || component === 'executor') {
    const shPath = join(outDir, 'install-executor.sh')
    writeFileSync(shPath, generateExecutorInstallerSh({ repo, tag }))
    chmodSync(shPath, 0o755)
    writeFileSync(join(outDir, 'install-executor.ps1'), generateExecutorInstallerPs1({ repo, tag }))
    bootstrapAssets.push('install-executor.sh', 'install-executor.ps1')
    for (const target of ['win32-x64', 'win32-arm64']) {
      const prebuilds = join(root, 'packages/executor/node_modules/node-pty/prebuilds', target)
      if (!existsSync(prebuilds)) continue
      const archive = `node-pty-${target}.tar.gz`
      const packed = spawnSync('tar', ['-czf', join(outDir, archive), '-C', dirname(prebuilds), target], { encoding: 'utf8' })
      if (packed.status !== 0) throw new Error(`failed to package ${archive}: ${packed.stderr}`)
      bootstrapAssets.push(archive)
    }
  }
  return bootstrapAssets
}

function writeSha256Sums(files) {
  const sums = files
    .filter((file) => exists(file))
    .map((file) => `${sha256(join(outDir, file))}  ${file}`)
    .join('\n')
  writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`)
}

function writeExecutorUpdateManifest() {
  const target = detectNativeTarget()
  const asset = executorNativeAssetName(target)
  if (!exists(asset)) return
  const tagged = String(tag).replace(/^v/u, '')
  const release = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tagged) ? tagged : packageJson.version
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release)) return
  const configured = process.env.RUNLAB_EXECUTOR_UPDATE_PRIVATE_KEY_PEM
  if (!configured && tag !== 'latest') throw new Error('RUNLAB_EXECUTOR_UPDATE_PRIVATE_KEY_PEM is required for signed Executor releases')
  const pair = configured
    ? { privateKey: createPrivateKey(configured), publicKey: createPublicKey(configured) }
    : generateKeyPairSync('ed25519')
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const signed = JSON.stringify({
    version: 1, release, channel: 'stable', protocol: { min: 1, max: 1 },
    artifact: { url: `./${asset}`, size: statSync(join(outDir, asset)).size, sha256: sha256(join(outDir, asset)), file: 'runlab-executor' },
  })
  const signature = sign(null, Buffer.from(signed), pair.privateKey).toString('base64')
  writeFileSync(join(outDir, 'executor-update-manifest.json'), `${JSON.stringify({ signed, signature })}\n`)
  writeFileSync(join(outDir, 'executor-update-public-key.pem'), publicPem)
}

function releaseFiles() {
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  return [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md']
}

function removeNativeBuildWorkspace() {
  rmSync(join(outDir, '.sea'), { recursive: true, force: true })
}

function exists(asset) {
  return existsSync(join(outDir, asset))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function normalizeNodeShebang(text) {
  return `#!/usr/bin/env node\n${text.replace(/^#![^\n]*\n/gm, '')}`
}

function keepSingleShebang(text) {
  const shebang = '#!/usr/bin/env node\n'
  if (!text.startsWith(shebang)) return text
  return shebang + text.slice(shebang.length).replaceAll(shebang, '')
}

function detectNativeTarget() {
  const os = process.platform
  const arch = process.arch
  const normalizedOs = os === 'win32' ? 'win32' : os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : os
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch
  if (!['linux', 'darwin', 'win32'].includes(normalizedOs)) {
    throw new Error(`unsupported native release os ${os}`)
  }
  if (!['x64', 'arm64'].includes(normalizedArch)) {
    throw new Error(`unsupported native release arch ${arch}`)
  }
  return `${normalizedOs}-${normalizedArch}`
}

function nativeAssetName(name, target) {
  return `${name}-${target}${target.startsWith('win32-') ? '.exe' : ''}`
}

function cjsAssetName(entry) {
  return `${entry.cjsName ?? entry.name}.cjs`
}

function embeddedDashboardBanner(dir) {
  assertDashboardDistReady(dir)
  const assets = []
  for (const file of walkFiles(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/')
    assets.push({ path: rel, contentBase64: readFileSync(file).toString('base64') })
  }
  return `globalThis.__AGENT_KERNEL_EMBEDDED_DASHBOARD__=${JSON.stringify(assets)};\n`
}

function writeDashboardReleaseManifest(dir) {
  assertDashboardDistReady(dir)
  const files = [...walkFiles(dir)].map((file) => {
    const path = relative(dir, file).replace(/\\/g, '/')
    const bytes = readFileSync(file)
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const assetDigest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  writeFileSync(join(outDir, 'dashboard-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'agent-runlab-dashboard',
    version: packageJson.version,
    builtAt: new Date().toISOString(),
    source: sourceIdentity,
    protocol: { min: '1.0.0', max: '1.0.0' },
    assetDigest,
    files,
  }, null, 2)}\n`)
}

function embeddedDocsBanner(dir) {
  const assets = []
  for (const file of walkFiles(dir)) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const rel = relative(dir, file).replace(/\\/g, '/')
    assets.push({ path: rel, contentBase64: readFileSync(file).toString('base64') })
  }
  return `globalThis.__AGENT_KERNEL_EMBEDDED_DOCS__=${JSON.stringify(assets)};\n`
}

function assertDashboardDistReady(dir) {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`dashboard dist missing index.html at ${dir}; run pnpm --filter @agent-kernel/dashboard build or omit --skip-dashboard-build`)
  }
}

function embeddedSocketAdminBanner(dir) {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`Socket.IO Admin UI dist missing index.html at ${dir}; run pnpm prepare:socket-admin-ui first`)
  }
  const assets = []
  for (const file of walkFiles(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/')
    assets.push({ path: rel, contentBase64: readFileSync(file).toString('base64') })
  }
  return `globalThis.__AGENT_KERNEL_EMBEDDED_SOCKET_ADMIN_UI__=${JSON.stringify(assets)};\n`
}

function resolveSocketAdminDist() {
  const configured = process.env.AGENT_KERNEL_SOCKET_ADMIN_DIST
  if (configured) return configured

  const localPrepared = join(root, '.presq/socket.io-admin-ui/dist')
  if (existsSync(join(localPrepared, 'index.html'))) return localPrepared

  try {
    const hostRequire = createRequire(new URL('../../packages/host/package.json', import.meta.url))
    const packageRoot = dirname(hostRequire.resolve('@socket.io/admin-ui/package.json'))
    return join(packageRoot, 'ui/dist')
  } catch {}

  return localPrepared
}

function prepareEmbeddedReleaseAssetsForHost() {
  if (nativeOnly) return ''
  const executorEntry = allEntries.find((entry) => entry.component === 'executor')
  if (!executorEntry) return ''
  const executorCjs = cjsAssetName(executorEntry)
  if (!exists(executorCjs)) return ''
  if (!exists('run.sh')) {
    const path = join(outDir, 'run.sh')
    writeFileSync(path, unifiedBootstrap({ repo, tag, component }))
    chmodSync(path, 0o755)
  }
  const nativeExecutor = currentNativeTarget ? executorNativeAssetName(currentNativeTarget) : undefined
  if (nativeExecutor && exists(nativeExecutor)) writeExecutorUpdateManifest()
  const desktopDownloadDir = join(dashboardDist, 'downloads', 'desktop')
  const desktopManifestPath = join(desktopDownloadDir, 'release.json')
  const desktopNames = []
  if (existsSync(desktopManifestPath)) {
    const desktopManifest = JSON.parse(readFileSync(desktopManifestPath, 'utf8'))
    const assets = [
      [desktopManifest.artifact?.file, 'desktop-package.deb'],
      [desktopManifest.dependencies?.file, 'desktop-dependencies.json'],
      [desktopManifest.checksums?.file, 'desktop-SHA256SUMS.txt'],
      ['install.sh', 'desktop-install.sh'],
    ]
    for (const [source, target] of assets) {
      if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+~-]*$/u.test(source)) throw new Error('invalid Desktop release asset name')
      copyFileSync(join(desktopDownloadDir, source), join(outDir, target))
      desktopNames.push(target)
    }
  }
  const embeddedNames = [executorCjs, nativeExecutor, 'run.sh', 'install-executor.sh', 'install-executor.ps1', 'node-pty-win32-x64.tar.gz', 'node-pty-win32-arm64.tar.gz', 'executor-update-manifest.json', 'executor-update-public-key.pem', ...desktopNames]
    .filter((name) => name && exists(name))
  writeSha256Sums(embeddedNames)
  return embeddedReleaseAssetsBanner(outDir, [...embeddedNames, 'SHA256SUMS'])
}

function embeddedReleaseAssetsBanner(dir, names) {
  const assets = []
  for (const name of names) {
    const file = join(dir, name)
    if (!existsSync(file) || !statSync(file).isFile()) continue
    assets.push({ path: name, contentBase64: readFileSync(file).toString('base64') })
  }
  if (assets.length === 0) return ''
  return `globalThis.__AGENT_KERNEL_EMBEDDED_RELEASE_ASSETS__=${JSON.stringify(assets)};\n`
}

function buildInfoBanner({ artifactKind, dashboardMode, socketAdminMode }) {
  const info = {
    releaseTag: tag,
    productVersion: packageJson.version,
    gitCommit: sourceIdentity.revision.slice(0, 12),
    sourceSnapshotSha256: sourceIdentity.snapshotSha256,
    builtAt: new Date().toISOString(),
    artifactKind,
    dashboardMode,
    socketAdminMode,
  }
  return `globalThis.__AGENT_KERNEL_BUILD_INFO__=${JSON.stringify(info)};\n`
}

function readSourceIdentity() {
  const revision = gitText(['rev-parse', 'HEAD']).trim()
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('release source revision is unavailable')
  return {
    revision,
    snapshotSha256: sourceSnapshotSha256(),
    dirty: gitText(['status', '--porcelain=v1', '--untracked-files=all']).trim().length > 0,
  }
}

function assertSourceIdentityUnchanged() {
  if (sourceSnapshotSha256() !== sourceIdentity.snapshotSha256) {
    throw new Error('release source changed while assets were being built')
  }
}

function sourceSnapshotSha256() {
  const paths = gitBuffer(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean).filter((path) => existsSync(join(root, path))).sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    const absolute = join(root, path)
    const stat = lstatSync(absolute)
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
    hash.update(`${stat.mode & 0o7777}\0${path}\0${content.length}\0`)
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function gitText(args) {
  return gitBuffer(args).toString('utf8')
}

function gitBuffer(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr?.toString('utf8') || `git ${args[0]} failed`)
  return result.stdout
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(abs)
    } else if (entry.isFile()) {
      const st = statSync(abs)
      if (st.size > 0) yield abs
    }
  }
}

async function buildNativeSea(name, cjsPath, target) {
  const seaDir = join(outDir, '.sea', `${name}-${target}`)
  mkdirSync(seaDir, { recursive: true })
  const seaConfigPath = join(seaDir, 'sea-config.json')
  const blobPath = join(seaDir, `${name}.blob`)
  const nativePath = join(outDir, nativeAssetName(name, target))
  writeFileSync(seaConfigPath, `${JSON.stringify({ main: cjsPath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)}\n`)
  await run(process.execPath, ['--experimental-sea-config', seaConfigPath])
  copyFileSync(process.execPath, nativePath)
  await run('pnpm', ['exec', 'postject', nativePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'])
  chmodSync(nativePath, 0o755)
}

function parseOptions(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const value = optionValue(normalized, '--component') ?? 'all'
  const allowed = new Set(['all', 'host', 'executor', 'dashboard'])
  if (!allowed.has(value)) {
    throw new Error(`unknown release component ${value}; expected all, host, executor, or dashboard`)
  }
  return {
    component: value,
    tag: optionValue(normalized, '--tag') ?? process.env.GITHUB_REF_NAME ?? 'latest',
    repo: optionValue(normalized, '--repo') ?? process.env.GITHUB_REPOSITORY,
    nativeOnly: normalized.includes('--native-only'),
    finalizeOnly: normalized.includes('--finalize-only'),
    noNative: normalized.includes('--no-native'),
    skipDashboardBuild: normalized.includes('--skip-dashboard-build'),
    skipPackageBuild: normalized.includes('--skip-package-build'),
    nativeTarget: optionValue(normalized, '--native-target'),
  }
}

function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === name) return args[i + 1]
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function repoFromPackageJson(pkg) {
  const repository = pkg.repository
  if (typeof repository === 'string') return normalizeRepo(repository)
  if (repository && typeof repository.url === 'string') return normalizeRepo(repository.url)
  return undefined
}

function normalizeRepo(value) {
  const trimmed = value.trim()
  const match = trimmed.match(/github\.com[:/]([^/]+\/[^/.#]+)(?:\.git)?(?:[#?].*)?$/)
  if (match) return match[1]
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed
  return undefined
}

function unifiedBootstrap({ repo, tag, component }) {
  const defaultComponent = component === 'all' ? 'host-frontend' : (component === 'dashboard' ? 'frontend' : component)
  return bash([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `REPO="${repo}"`,
    `TAG="${tag}"`,
    `DEFAULT_COMPONENT="${defaultComponent}"`,
    'DEFAULT_BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"',
    'if [ "$TAG" = "latest" ]; then',
    '  DEFAULT_BASE_URL="https://github.com/${REPO}/releases/latest/download"',
    'fi',
    'BASE_URL="${AGENT_KERNEL_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}"',
    'COMPONENT="${COMPONENT:-${AGENT_KERNEL_COMPONENT:-${1:-$DEFAULT_COMPONENT}}}"',
    'BOOTSTRAP_LOG_LEVEL="${AGENT_KERNEL_BOOTSTRAP_LOG_LEVEL:-info}"',
    '',
    'print_download_example() {',
    '  local example_component="$1"',
    '  local env_prefix="${2:-}"',
    '  if [ -n "$env_prefix" ]; then',
    '    env_prefix="$env_prefix "',
    '  fi',
    '  printf "  tmp=\\$(mktemp)\\n" >&2',
    '  printf "  wget -nv -O \\\"\\$tmp\\\" \\\"%s/run.sh\\\"\\n" "$BASE_URL" >&2',
    '  printf "  %sCOMPONENT=%s bash \\\"\\$tmp\\\"\\n" "$env_prefix" "$example_component" >&2',
    '}',
    '',
    'USER_WORK_DIR="${AGENT_KERNEL_RUN_DIR:-}"',
    'if [ -n "$USER_WORK_DIR" ]; then',
    '  WORK_DIR="$USER_WORK_DIR"',
    '  mkdir -p "$WORK_DIR"',
    'else',
    '  WORK_DIR=$(mktemp -d)',
    '  trap \'rm -rf "$WORK_DIR"\' EXIT',
    'fi',
    '',
    'case "$COMPONENT" in',
    '  host|executor|frontend|host-frontend) ;;',
    '  *)',
    '    echo "Unknown COMPONENT: \"$COMPONENT\". Set COMPONENT to one of:" >&2',
    '    echo >&2',
    '    echo "  host-frontend  Run the host process AND serve the dashboard bundle (one-command VM deploy). DEFAULT." >&2',
    '    echo "  host           Run only the headless host process (no web UI). Pair with a separately deployed frontend." >&2',
    '    echo "  frontend       Download and extract the dashboard bundle only; do not start any process." >&2',
    '    echo "  executor       Run an executor that dials into an existing host. Requires HOST_URL." >&2',
    '    echo >&2',
    '    echo "Examples:" >&2',
    '    print_download_example host-frontend',
    '    echo >&2',
    '    print_download_example host',
    '    echo >&2',
    '    print_download_example frontend',
    '    echo >&2',
    '    print_download_example executor HOST_URL=http://host-machine:3000',
    '    exit 1',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  COMPONENT=host-frontend bash \"\\$tmp\"" >&2',
    '    echo >&2',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  COMPONENT=host bash \"\\$tmp\"" >&2',
    '    echo >&2',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  COMPONENT=frontend bash \"\\$tmp\"" >&2',
    '    echo >&2',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  HOST_URL=http://host-machine:3000 COMPONENT=executor bash \"\\$tmp\"" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    'if [ "$COMPONENT" = "executor" ] && [ -z "${HOST_URL:-}" ] && [ "$#" -eq 0 ]; then',
    '  echo "COMPONENT=executor requires HOST_URL (URL of the running host to dial into)." >&2',
    '  echo "  Example:" >&2',
    '  print_download_example executor HOST_URL=http://host-machine:3000',
    '  exit 1',
    '  echo "    tmp=\\$(mktemp)" >&2',
    '  echo "    wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '  echo "    HOST_URL=http://host-machine:3000 COMPONENT=executor bash \"\\$tmp\"" >&2',
    '  exit 1',
    'fi',
    '',
    'FRONTEND_DIR="${AGENT_KERNEL_FRONTEND_DIR:-${WORK_DIR}/frontend}"',
    'case "$COMPONENT" in',
    '  frontend|host-frontend) mkdir -p "$FRONTEND_DIR" ;;',
    'esac',
    '',
    'require_cmd() {',
    '  if ! command -v "$1" >/dev/null 2>&1; then',
    '    echo "Required command \'$1\' not found in PATH" >&2',
    '    exit 1',
    '  fi',
    '}',
    'require_cmd wget',
    '',
    'log() {',
    '  printf "Kala bootstrap | %s\\n" "$*" >&2',
    '}',
    '',
    'debug() {',
    '  if [ "$BOOTSTRAP_LOG_LEVEL" = "debug" ]; then',
    '    log "$@"',
    '  fi',
    '}',
    '',
    'download() {',
    '  local name="$1"',
    '  local url="${BASE_URL}/${name}"',
    '  log "download ${name}"',
    '  debug "source ${url}"',
    '  if ! wget -q --tries=3 --timeout=30 --retry-connrefused -O "${WORK_DIR}/${name}" "$url"; then',
    '    log "failed to download ${name}"',
    '    log "source ${url}"',
    '    log "check network reachability and release tag ${TAG} in ${REPO}"',
    '    exit 1',
    '  fi',
    '}',
    '',
    'hash_file() {',
    '  if command -v shasum >/dev/null 2>&1; then',
    '    shasum -a 256 "$1" | awk \'{print $1}\'',
    '  elif command -v sha256sum >/dev/null 2>&1; then',
    '    sha256sum "$1" | awk \'{print $1}\'',
    '  else',
    '    echo "Required command \'shasum\' or \'sha256sum\' not found in PATH" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'verify_file() {',
    '  local name="$1"',
    '  local expected',
    '  expected=$(awk -v file="$name" \'$2 == file {print $1}\' "${WORK_DIR}/SHA256SUMS")',
    '  if [ -z "$expected" ]; then',
    '    log "SHA256SUMS has no checksum for $name; release may be missing this asset"',
    '    exit 1',
    '  fi',
    '  local actual',
    '  actual=$(hash_file "${WORK_DIR}/${name}")',
    '  if [ "$actual" != "$expected" ]; then',
    '    log "checksum mismatch for $name"',
    '    log "expected $expected"',
    '    log "actual   $actual"',
    '    exit 1',
    '  fi',
    '  debug "verified ${name}"',
    '}',
    '',
    'download SHA256SUMS',
    '',
    'platform_target() {',
    '  local os arch',
    '  os=$(uname -s | tr "[:upper:]" "[:lower:]")',
    '  arch=$(uname -m)',
    '  case "$os" in',
    '    linux) os="linux" ;;',
    '    darwin) os="darwin" ;;',
    '    mingw*|msys*|cygwin*) os="win32" ;;',
    '    *) echo ""; return ;;',
    '  esac',
    '  case "$arch" in',
    '    x86_64|amd64) arch="x64" ;;',
    '    arm64|aarch64) arch="arm64" ;;',
    '    *) echo ""; return ;;',
    '  esac',
    '  echo "${os}-${arch}"',
    '}',
    '',
    'checksum_exists() {',
    '  local name="$1"',
    '  awk -v file="$name" \'$2 == file {found=1} END {exit found ? 0 : 1}\' "${WORK_DIR}/SHA256SUMS"',
    '}',
    '',
    'has_node22() {',
    '  command -v node >/dev/null 2>&1 && node -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\' >/dev/null 2>&1',
    '}',
    '',
    'download_and_extract_frontend() {',
    '  require_cmd tar',
    '  download agent-kernel-dashboard-dist.tar.gz',
    '  verify_file agent-kernel-dashboard-dist.tar.gz',
    '  tar -xzf "${WORK_DIR}/agent-kernel-dashboard-dist.tar.gz" -C "$FRONTEND_DIR"',
    '  if [ ! -f "${FRONTEND_DIR}/index.html" ]; then',
    '    echo "Extracted frontend bundle to $FRONTEND_DIR but index.html is missing" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'run_asset() {',
    '  local base="$1"',
    '  shift',
    '  local target native cjs runtime',
    '  target=$(platform_target)',
    '  native="${base}-${target}"',
    '  case "$target" in win32-*) native="${native}.exe" ;; esac',
    '  cjs="${base}.cjs"',
    '  if [ "$base" = "agent-kernel-host" ]; then',
    '    cjs="bundle-dashboard-with-runtime.cjs"',
    '  fi',
    '  runtime="${AGENT_KERNEL_RUNTIME:-auto}"',
    '  if [ "${AGENT_RUNLAB_COPILOT_ENABLED:-0}" = "1" ]; then',
    '    local copilot_asset="copilot-cli-${target}"',
    '    case "$target" in win32-*) copilot_asset="${copilot_asset}.exe" ;; esac',
    '    if [ -z "$target" ] || ! checksum_exists "$copilot_asset"; then',
    '      log "Copilot runtime is enabled but no Copilot CLI is published for platform ${target:-unsupported}"',
    '      exit 1',
    '    fi',
    '    download "$copilot_asset"',
    '    verify_file "$copilot_asset"',
    '    chmod +x "${WORK_DIR}/${copilot_asset}"',
    '    export COPILOT_CLI_PATH="${WORK_DIR}/${copilot_asset}"',
    '  fi',
    '  case "$runtime" in auto|cjs|native) ;; *) echo "AGENT_KERNEL_RUNTIME must be auto, cjs, or native" >&2; exit 1 ;; esac',
    '  if [ "$runtime" = "cjs" ] || { [ "$runtime" = "auto" ] && has_node22; }; then',
    '    if checksum_exists "$cjs"; then',
    '      download "$cjs"',
    '      verify_file "$cjs"',
    '      chmod +x "${WORK_DIR}/${cjs}"',
    '      AGENT_KERNEL_RELEASE_TAG="$TAG" AGENT_KERNEL_UPDATE_REPO="$REPO" exec node "${WORK_DIR}/${cjs}" "$@"',
    '    fi',
    '    if [ "$runtime" = "cjs" ]; then',
    '      log "missing checksum for $cjs"',
    '      exit 1',
    '    fi',
    '  fi',
    '  if [ -n "$target" ] && checksum_exists "$native"; then',
    '    download "$native"',
    '    verify_file "$native"',
    '    chmod +x "${WORK_DIR}/${native}"',
    '    AGENT_KERNEL_RELEASE_TAG="$TAG" AGENT_KERNEL_UPDATE_REPO="$REPO" exec "${WORK_DIR}/${native}" "$@"',
    '  fi',
    '  if [ "$runtime" = "native" ]; then',
    '    log "no native binary published for platform ${target:-unsupported}"',
    '    log "available runtimes: set AGENT_KERNEL_RUNTIME=cjs (needs Node.js 22+) or unset it for auto"',
    '    exit 1',
    '  fi',
    '  if ! has_node22; then',
    '    log "no native binary for platform ${target:-unsupported} and no Node.js 22+ for .cjs fallback"',
    '    log "install Node.js 22+, or run on a platform with a published native binary"',
    '    exit 1',
    '  fi',
    '  download "$cjs"',
    '  verify_file "$cjs"',
    '  chmod +x "${WORK_DIR}/${cjs}"',
    '  AGENT_KERNEL_RELEASE_TAG="$TAG" AGENT_KERNEL_UPDATE_REPO="$REPO" exec node "${WORK_DIR}/${cjs}" "$@"',
    '}',
    '',
    'print_start_banner() {',
    '  local bind="${HOST:-127.0.0.1}"',
    '  local port="${PORT:-3000}"',
    '  log "starting host component=${COMPONENT} bind=${bind}:${port}"',
    '  if [ "$bind" = "0.0.0.0" ]; then',
    '    log "open http://<this-host-ip>:${port}"',
    '  else',
    '    log "open http://${bind}:${port}"',
    '    debug "set HOST=0.0.0.0 to expose on all interfaces"',
    '  fi',
    '  if [ "$COMPONENT" = "host-frontend" ]; then',
    '    log "frontend $FRONTEND_DIR"',
    '  else',
    '    log "headless host; deploy frontend separately"',
    '  fi',
    '}',
    '',
    'case "$COMPONENT" in',
    '  frontend)',
    '    download_and_extract_frontend',
    '    log "frontend ready $FRONTEND_DIR"',
    '    log "serve example: cd $FRONTEND_DIR && python3 -m http.server 8080"',
    '    log "browser example: ?host=http://<host-ip>:3000"',
    '    exit 0',
    '    ;;',
  '  host-frontend)',
    '    print_start_banner',
    '    run_asset agent-kernel-host "$@"',
    '    ;;',
    '  host)',
    '    print_start_banner',
    '    run_asset agent-kernel-host "$@"',
    '    ;;',
    '  executor)',
    '    run_asset agent-kernel-executor "$@"',
    '    ;;',
    'esac',
  ])
}


function releaseNotes(manifest) {
  const tagPath = manifest.tag === 'latest' ? 'latest/download' : `download/${manifest.tag}`
  const base = `https://github.com/${manifest.repo}/releases/${tagPath}`
  const canRunHost = manifest.component === 'all' || manifest.component === 'host'
  const canRunDashboard = manifest.component === 'all' || manifest.component === 'dashboard'
  const canRunExecutor = manifest.component === 'all' || manifest.component === 'executor'
  const run = (component, extraEnv = '') => {
    const env = [extraEnv.trim(), `COMPONENT=${component}`].filter(Boolean).join(' ')
    return `wget -nv -O - "${base}/run.sh" | ${env} bash`
  }
  const hasNativeAssets = Object.values(manifest.nativeAssets ?? {}).some((assets) => Array.isArray(assets) && assets.length > 0)
  const lines = [
    `# Kala ${manifest.tag}`,
    '',
    'Kala is a self-hosted runtime and dashboard for coding agents. This release packages the runtime, dashboard, executor, checksums, and bootstrap scripts needed to start from GitHub Releases.',
    '',
    '## What ships',
    '',
    '- Host + Dashboard bundle for running Kala locally or on a VM.',
    '- Separately deployable Executor for workspace tools.',
    '- `SHA256SUMS` for release-asset verification.',
    hasNativeAssets
      ? '- Native fallback binaries when Node.js 22+ is unavailable.'
      : '- Node.js `.cjs` assets for environments with Node.js 22+.',
    '',
    '## Quick Start',
    '',
  ]
  if (manifest.assets.includes('run.sh')) {
    if (canRunHost) {
      lines.push(
        'Run the host and dashboard together:',
        '',
        '```bash',
        run('host-frontend'),
        '```',
        '',
      )
    }
    if (canRunExecutor) {
      lines.push(
        'Run an executor that connects to the host:',
        '',
        '```bash',
        run('executor', 'HOST_URL=http://host-machine:3000'),
        '```',
        '',
        'Native installer preview (unsigned development mode; production remains fail-closed until release signing is implemented):',
        '',
        '```bash',
        `wget -nv -O - "${base}/install-executor.sh" | RUNLAB_INSTALLER_ALLOW_UNSIGNED=1 bash`,
        '```',
        '',
        '```powershell',
        `$env:RUNLAB_INSTALLER_ALLOW_UNSIGNED='1'; irm "${base}/install-executor.ps1" | iex`,
        '```',
        '',
        'Use `HOST_URL=https://agent.example.com` when the host is exposed through a public domain.',
        '',
      )
    }
    if (canRunHost || canRunDashboard) {
      lines.push('## Advanced Usage', '')
    }
    if (canRunHost) {
      lines.push('Run only the headless host:', '', '```bash', run('host'), '```', '')
    }
    if (canRunDashboard) {
      lines.push(
        'Download and extract only the dashboard frontend bundle:',
        '',
        '```bash',
        run('frontend'),
        '```',
        '',
      )
    }
    if (canRunHost) {
      lines.push('Bind the host to all interfaces and use a custom port:', '', '```bash', run('host-frontend', 'HOST=0.0.0.0 PORT=3000'), '```', '')
    }
    if (canRunHost || canRunExecutor) {
      lines.push(
        '## Configuration',
        '',
        '- `COMPONENT=host-frontend|host|frontend|executor`',
        '- `HOST_URL` - host URL used by executors.',
        '- `HOST` - host bind interface, default `127.0.0.1`.',
        '- `PORT` - host listen port, default `3000`.',
        '- `AGENT_KERNEL_FRONTEND_DIR` - frontend extraction directory.',
        '- `AGENT_KERNEL_ALLOWED_ORIGINS` - comma-separated dashboard origins.',
        '- `AGENT_KERNEL_RUNTIME=auto|cjs|native` - runtime selection.',
        '- `AGENT_KERNEL_RUN_DIR` - persistent runtime scratch directory.',
        '',
      )
    }
  }
  const verifyTargets = manifest.assets.filter((asset) => asset !== 'RELEASE_NOTES.md' && asset !== 'manifest.json' && asset !== 'SHA256SUMS')
  lines.push(
    '## Verify Checksums',
    '',
    '```bash',
    `wget -q ${base}/SHA256SUMS`,
    ...verifyTargets.map((asset) => `wget -q ${base}/${asset}`),
    'sha256sum -c SHA256SUMS --ignore-missing',
    '```',
    '',
  )
  return `${lines.join('\n')}\n`
}

function bash(lines) {
  return `${lines.join('\n')}\n`
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}`))
    })
  })
}
