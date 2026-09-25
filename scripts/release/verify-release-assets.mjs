#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyReleaseChecksums } from './release-checksums.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const releaseDir = join(root, 'release')
const manifestPath = join(releaseDir, 'manifest.json')

if (!existsSync(manifestPath)) fail('missing release/manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const supportedNativeTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
if (!/^[0-9a-f]{40}$/u.test(manifest.source?.revision ?? '')
  || !/^[0-9a-f]{64}$/u.test(manifest.source?.snapshotSha256 ?? '')
  || typeof manifest.source?.dirty !== 'boolean') {
  fail('manifest.source must bind a revision, exact worktree snapshot SHA-256, and dirty flag')
}
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  fail('manifest.assets must be a non-empty array')
}
if (new Set(manifest.assets).size !== manifest.assets.length) {
  fail('manifest.assets must not contain duplicates')
}
for (const asset of manifest.assets) assertSupportedReleaseAssetName(asset, 'manifest')
if (!Array.isArray(manifest.nativeTargets)
  || new Set(manifest.nativeTargets).size !== manifest.nativeTargets.length
  || manifest.nativeTargets.some((target) => !supportedNativeTargets.includes(target))) {
  fail('manifest.nativeTargets must contain only unique Linux/macOS x64/arm64 targets')
}
for (const [product, assets] of Object.entries(manifest.nativeAssets ?? {})) {
  if (!Array.isArray(assets)) fail(`manifest.nativeAssets.${product} must be an array`)
  for (const asset of assets) {
    assertSupportedReleaseAssetName(asset, `manifest.nativeAssets.${product}`)
    if (!supportedNativeTargets.some((target) => asset.endsWith(`-${target}`))) fail(`unsupported native asset target in ${asset}`)
  }
}
for (const asset of ['sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt']) {
  if (!manifest.assets.includes(asset)) fail(`manifest missing supply-chain asset ${asset}`)
}
const sbom = JSON.parse(readFileSync(join(releaseDir, 'sbom.cdx.json'), 'utf8'))
if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6' || sbom.metadata?.component?.version !== manifest.version || !Array.isArray(sbom.components) || sbom.components.length === 0) {
  fail('release CycloneDX SBOM is invalid or version-mismatched')
}
if (sbom.components.some((component) => component.licenses?.some((entry) => entry.license?.id === 'Unknown'))) fail('release SBOM contains an unknown license')
const notices = readFileSync(join(releaseDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
if (!notices.includes(`Kala ${manifest.version}`) || !notices.includes('third-party dependency inventory')) fail('release third-party notices are invalid')
const expectedReleaseFiles = [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS'].sort()
const actualReleaseEntries = readdirSync(releaseDir, { withFileTypes: true })
for (const entry of actualReleaseEntries) assertSupportedReleaseAssetName(entry.name, 'release directory')
if (actualReleaseEntries.some((entry) => !entry.isFile())
  || JSON.stringify(actualReleaseEntries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedReleaseFiles)) {
  fail('release file set does not exactly match its manifest')
}
const includesHost = manifest.component === 'all' || manifest.component === 'host'
if (includesHost) {
  for (const asset of [
    'agent-runlab-dedicated-ingress.cjs',
    'agent-runlab-runtime.cjs',
    'agent-runlab-dedicated-deploy-supervisor.cjs',
    'agent-runlab-dedicated-ingress.service',
    'agent-runlab-dedicated-unit@.service',
    'agent-runlab-dedicated-deploy-supervisor.service',
    'agent-runlab-dedicated-control-updater.service',
    'agent-runlab-dedicated-migration-finalizer.service',
    'deployment.json',
    'install-dedicated-systemd.mjs',
    'runlab-dedicated.mjs',
    'deploy-dedicated.mjs',
    'deploy-dashboard.mjs',
    'cutover-dedicated-systemd.mjs',
    'dedicated-data-migration.mjs',
    'dedicated-settings-fingerprint.mjs',
    'update-dedicated-control-plane.mjs',
    'rollback-dedicated-systemd.mjs',
  ]) {
    if (!manifest.assets.includes(asset)) fail(`manifest missing Dedicated asset ${asset}`)
  }
  const dedicatedDeployment = JSON.parse(readFileSync(join(releaseDir, 'deployment.json'), 'utf8'))
  if (dedicatedDeployment.schemaVersion !== 1
    || dedicatedDeployment.architecture !== 'platform'
    || dedicatedDeployment.tenancy !== 'single-tenant'
    || dedicatedDeployment.runtimeProfile !== 'full') {
    fail('release deployment.json is not the canonical Dedicated configuration')
  }
  const hostBundle = readFileSync(join(releaseDir, 'bundle-dashboard-with-runtime.cjs'), 'utf8')
  const embeddedAssetsPrefix = 'globalThis.__AGENT_KERNEL_EMBEDDED_RELEASE_ASSETS__='
  const embeddedAssetsStart = hostBundle.indexOf(embeddedAssetsPrefix)
  if (embeddedAssetsStart < 0) fail('release Host bundle is missing embedded release assets')
  const embeddedAssetsEnd = hostBundle.indexOf(';\n', embeddedAssetsStart + embeddedAssetsPrefix.length)
  if (embeddedAssetsEnd < 0) fail('release Host bundle has unterminated embedded release assets')
  // The banner may contain hundreds of MB of base64. V8 regular expressions
  // over that whole line overflow the call stack; locate its terminator instead.
  const embeddedAssets = JSON.parse(hostBundle.slice(embeddedAssetsStart + embeddedAssetsPrefix.length, embeddedAssetsEnd))
  for (const asset of embeddedAssets) assertSupportedReleaseAssetName(asset?.path, 'embedded Host assets')
  if (!hostBundle.includes('__AGENT_KERNEL_EMBEDDED_DOCS__')
    || !hostBundle.includes(Buffer.from('# Dedicated Platform Runtime Unit Refactor').toString('base64'))) {
    fail('release Host bundle is missing embedded product documentation')
  }
  const platformRuntime = readFileSync(join(releaseDir, 'agent-runlab-runtime.cjs'), 'utf8')
  if (platformRuntime.includes('globalThis.__AGENT_KERNEL_EMBEDDED_DASHBOARD__=')) fail('Self-hosted Platform Runtime must not embed Dashboard assets')
  const dashboardRelease = JSON.parse(readFileSync(join(releaseDir, 'dashboard-release.json'), 'utf8'))
  if (dashboardRelease.schemaVersion !== 1 || dashboardRelease.product !== 'agent-runlab-dashboard' || !dashboardRelease.files?.some((entry) => entry.path === 'index.html')) fail('release Dashboard manifest is invalid')
  const operatorHelp = spawnSync('node', ['runlab-dedicated.mjs', '--help'], { cwd: releaseDir, encoding: 'utf8' })
  if (operatorHelp.status !== 0 || !['install', 'status', 'upgrade', 'rollback', 'backup', 'restore', 'uninstall'].every((command) => operatorHelp.stdout.includes(command))) fail('Dedicated operator CLI help is incomplete')
  accessSync(join(releaseDir, 'runlab-dedicated.mjs'), constants.X_OK)
}

const forbiddenLegacyEvaluationMarkers = [
  'src/eval/',
  'run-benchmark-web',
  'run-programbench-legacy-runner',
  'run-browsecomp-legacy-runner',
  'run-jobbench-legacy-runner',
]

for (const asset of manifest.assets) {
  const path = join(releaseDir, asset)
  if (!existsSync(path)) fail(`missing asset ${asset}`)
  if (asset.endsWith('.cjs')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env node\n')) {
      fail(`${asset} is missing node shebang`)
    }
    for (const marker of forbiddenLegacyEvaluationMarkers) {
      if (text.includes(marker)) fail(`${asset} contains legacy evaluation content: ${marker}`)
    }
    accessSync(path, constants.X_OK)
  }
  if (isNativeAsset(asset)) {
    accessSync(path, constants.X_OK)
  }
  if (asset === 'run.sh') {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env bash\n')) {
      fail(`${asset} is missing bash shebang`)
    }
    accessSync(path, constants.X_OK)
    if (text.includes('curl')) fail(`${asset} must be wget-only and must not mention curl`)
    if (/wget\s+-qO-.*\|.*bash/.test(text)) {
      fail(`${asset} must not suggest quiet wget pipe-to-bash bootstrap commands`)
    }
    if (!text.includes('wget -nv -O')) {
      fail(`${asset} user-facing examples must use diagnostic temp-file bootstrap commands`)
    }
    if (/win32|mingw|msys|cygwin|\.exe|\.ps1|conpty/iu.test(text)) fail(`${asset} must not offer Windows release assets`)
    if (!text.includes('AGENT_KERNEL_RUNTIME:-auto')) {
      fail(`${asset} must support AGENT_KERNEL_RUNTIME=auto|cjs|native`)
    }
    if (!text.includes('[ "$runtime" = "auto" ] && has_node22')) {
      fail(`${asset} must prefer compact .cjs assets when Node.js 22+ is available`)
    }
    if (!text.includes('Kala bootstrap | %s')) {
      fail(`${asset} must use the compact bootstrap log prefix`)
    }
    if (!text.includes('wget -q --tries=3 --timeout=30 --retry-connrefused')) {
      fail(`${asset} must keep wget output compact`)
    }
    if (text.includes('--show-progress') || text.includes('--progress=')) {
      fail(`${asset} must not print wget progress output by default`)
    }
    if (text.includes('Downloading ${name} from ${url}')) {
      fail(`${asset} must not print verbose download source lines by default`)
    }
    const syntax = spawnSync('bash', ['-n', path], { stdio: 'inherit' })
    if (syntax.status !== 0) fail(`${asset} failed bash syntax check`)
    const badComponent = spawnSync('bash', ['-c', 'COMPONENT=bad bash release/run.sh'], {
      cwd: root,
      encoding: 'utf8',
    })
    if (badComponent.status === 0) fail(`${asset} unknown component smoke test should fail`)
    const badComponentOutput = `${badComponent.stdout}\n${badComponent.stderr}`
    if (!badComponentOutput.includes('Unknown COMPONENT') || !badComponentOutput.includes('wget -nv -O "$tmp"') || !badComponentOutput.includes('HOST_URL=http://host-machine:3000 COMPONENT=executor')) {
      fail(`${asset} unknown component smoke test did not print diagnostic usage`)
    }
    if (badComponentOutput.includes('unbound variable')) {
      fail(`${asset} unknown component usage must not expand example shell variables`)
    }
    const missingHost = spawnSync('bash', ['-c', 'COMPONENT=executor bash release/run.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOST_URL: '' },
    })
    if (missingHost.status === 0) fail(`${asset} executor missing HOST_URL smoke test should fail`)
    const missingHostOutput = `${missingHost.stdout}\n${missingHost.stderr}`
    if (!missingHostOutput.includes('requires HOST_URL') || !missingHostOutput.includes('wget -nv -O "$tmp"') || !missingHostOutput.includes('HOST_URL=http://host-machine:3000 COMPONENT=executor')) {
      fail(`${asset} executor missing HOST_URL smoke test did not print diagnostic usage`)
    }
    if (missingHostOutput.includes('download SHA256SUMS') || missingHostOutput.includes('unbound variable')) {
      fail(`${asset} executor missing HOST_URL must fail before downloads and must not expand example shell variables`)
    }
  }
}

const installer = 'install-executor.sh'
if (!manifest.assets.includes(installer)) fail(`manifest missing ${installer}`)
const installerText = readFileSync(join(releaseDir, installer), 'utf8')
for (const marker of ['RUNLAB_INSTALLER_ALLOW_UNSIGNED', 'SHA256SUMS', 'runlab-executor-', '--internal-installer', 'Linux and macOS only']) {
  if (!installerText.includes(marker)) fail(`${installer} missing required installer marker: ${marker}`)
}
if (installerText.includes('manifest.json')) fail(`${installer} must use the Host-scoped checksum index without manifest fallback`)
if (!installerText.includes('agent-kernel-executor.cjs') || !installerText.includes('Node.js 22+')) fail(`${installer} must provide the checksum-verified Node.js 22 fallback when a platform native is unavailable`)
if (/win32|mingw|msys|cygwin|\.exe|\.ps1|conpty/iu.test(installerText)) fail(`${installer} must support only the four Linux/macOS targets`)
const installerSyntax = spawnSync('bash', ['-n', join(releaseDir, 'install-executor.sh')], { stdio: 'inherit' })
if (installerSyntax.status !== 0) fail('install-executor.sh failed bash syntax check')

const notesPath = join(releaseDir, 'RELEASE_NOTES.md')
if (!existsSync(notesPath)) fail('missing release/RELEASE_NOTES.md')
const notes = readFileSync(notesPath, 'utf8')
if (manifest.assets.includes('run.sh') && (!notes.includes("set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL") || !notes.includes('| COMPONENT='))) {
  fail('release notes missing direct HTTPS curl-to-bash bootstrap with pipefail')
}
if (manifest.assets.includes('run.sh') && !notes.includes('## Advanced Usage')) {
  fail('release notes missing advanced usage section')
}
if (notes.includes('## Assets')) {
  fail('release notes must not duplicate the GitHub release assets list')
}
if (/bash -c 'set -euo pipefail; tmp=\$\(mktemp\)/.test(notes)) {
  fail('release notes must not wrap bootstrap commands in bash -c temp-file snippets')
}
if (notes.includes('chmod +x run.sh') || notes.includes('./run.sh')) {
  fail('release notes must not require saving run.sh before execution')
}
if (/wget\s+-qO-.*\|.*bash/.test(notes)) {
  fail('release notes must not pipe quiet wget output directly into bash')
}
if (notes.includes('run-host.sh') || notes.includes('run-executor.sh')) {
  fail('release notes must use unified run.sh only')
}
if (!notes.includes('sha256sum -c SHA256SUMS --ignore-missing')) {
  fail('release notes missing checksum verification command')
}
if (/agent-kernel-(host|executor)\.cjs\s*\|\s*node/.test(notes)) {
  fail('release notes must not pipe Node.js assets directly to node')
}
if (!notes.includes('Linux and macOS (x64 and arm64)') || !notes.includes('Windows release assets are not included')) {
  fail('release notes must state the four-target Linux/macOS support scope')
}
if (/https?:\/\/\S*(?:win32|windows|\.ps1|\.exe|conpty)/iu.test(notes)) fail('release notes must not offer Windows downloads')

try {
  await verifyReleaseChecksums(releaseDir, expectedReleaseFiles.filter((file) => file !== 'SHA256SUMS'))
} catch {
  fail('SHA256SUMS verification failed')
}

if (manifest.assets.includes('agent-kernel-executor.cjs')) {
  const executorHelp = spawnSync('node', ['agent-kernel-executor.cjs', '--help'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executorHelp.status !== 0) fail('executor --help smoke test should exit 0')
  const helpOutput = `${executorHelp.stdout}\n${executorHelp.stderr}`
  if (!helpOutput.includes('Kala Executor') || !helpOutput.includes('Usage:') || !helpOutput.includes('runlab-executor --host <url>') || !helpOutput.includes('--sandbox-root <path>') || !helpOutput.includes('service status|logs|start|stop|restart|uninstall')) {
    fail('executor --help smoke test did not print daemon and service lifecycle usage')
  }
  if (helpOutput.includes('connecting to')) {
    fail('executor --help must not connect to a host')
  }

  const executorVersion = spawnSync('node', ['agent-kernel-executor.cjs', '--version'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executorVersion.status !== 0) fail('executor --version smoke test should exit 0')
  const reportedVersion = executorVersion.stdout.match(/^Kala Executor (\S+)$/m)?.[1]
  if (!reportedVersion || reportedVersion !== manifest.version) {
    fail(`executor --version must equal the release product version ${manifest.version}`)
  }

  const executor = spawnSync('node', ['agent-kernel-executor.cjs'], {
    cwd: releaseDir,
    encoding: 'utf8',
    env: { ...process.env, HOST_URL: '' },
  })
  if (executor.status !== 1) fail('executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('missing host url') || !output.includes('"flag":"--host"') || !output.includes('"env":"HOST_URL"')) {
    fail('executor usage smoke test did not print usage')
  }
}

if (manifest.assets.includes('bundle-dashboard-with-runtime.cjs')) {
  const hostHelp = spawnSync('node', ['bundle-dashboard-with-runtime.cjs', '--help'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (hostHelp.status !== 0) fail('host --help smoke test should exit 0')
  const output = `${hostHelp.stdout}\n${hostHelp.stderr}`
  if (!output.includes('Kala Runtime') || !output.includes('Usage:') || !output.includes('bundle-dashboard-with-runtime.cjs [options]') || !output.includes('--port <port>')) {
    fail('host --help smoke test did not print CLI usage')
  }
  if (output.includes('host listening')) {
    fail('host --help must not start the server')
  }

  const hostVersion = spawnSync('node', ['bundle-dashboard-with-runtime.cjs', '-v'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (hostVersion.status !== 0) fail('host -v smoke test should exit 0')
  if (!/^Kala Runtime \d+\.\d+\.\d+/m.test(hostVersion.stdout)) {
    fail('host -v smoke test did not print version')
  }
}

const nativeExecutor = manifest.assets.find((asset) => asset === nativeAssetName('agent-kernel-executor'))
if (nativeExecutor) {
  const executor = spawnSync(`./${nativeExecutor}`, [], {
    cwd: releaseDir,
    encoding: 'utf8',
    env: { ...process.env, HOST_URL: '' },
  })
  if (executor.status !== 1) fail('native executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('missing host url') || !output.includes('"flag":"--host"') || !output.includes('"env":"HOST_URL"')) {
    fail('native executor usage smoke test did not print usage')
  }
}

console.log('release assets verified')

function isNativeAsset(asset) {
  return /^(?:agent-kernel-(?:host|executor)|runlab-executor)-(linux|darwin)-(x64|arm64)$/.test(asset)
}

function nativeAssetName(base) {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined
  return os && arch ? `${base}-${os}-${arch}` : undefined
}

function assertSupportedReleaseAssetName(name, location) {
  if (typeof name !== 'string' || /(?:win32|windows|conpty)/iu.test(name) || /\.(?:exe|ps1)$/iu.test(name) || /^node-pty-.*\.tar\.gz$/iu.test(name) || /^executor-update-(?:manifest\.json|public-key\.pem)$/u.test(name)) {
    fail(`${location} contains unsupported or platform-ambiguous release asset ${String(name)}`)
  }
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
