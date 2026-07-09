#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../..', import.meta.url))
const releaseDir = join(root, 'release')
const manifestPath = join(releaseDir, 'manifest.json')

if (!existsSync(manifestPath)) fail('missing release/manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  fail('manifest.assets must be a non-empty array')
}

for (const asset of manifest.assets) {
  const path = join(releaseDir, asset)
  if (!existsSync(path)) fail(`missing asset ${asset}`)
  if (asset.endsWith('.cjs')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env node\n')) {
      fail(`${asset} is missing node shebang`)
    }
    accessSync(path, constants.X_OK)
  }
  if (isNativeAsset(asset)) {
    accessSync(path, constants.X_OK)
  }
  if (asset.endsWith('.sh')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env bash\n')) {
      fail(`${asset} is missing bash shebang`)
    }
    accessSync(path, constants.X_OK)
    if (asset !== 'run.sh') fail(`unexpected shell bootstrap ${asset}; use run.sh only`)
    if (text.includes('curl')) fail(`${asset} must be wget-only and must not mention curl`)
    if (/wget\s+-qO-.*\|.*bash/.test(text)) {
      fail(`${asset} must not suggest quiet wget pipe-to-bash bootstrap commands`)
    }
    if (!text.includes('wget -nv -O')) {
      fail(`${asset} user-facing examples must use diagnostic temp-file bootstrap commands`)
    }
    if (!text.includes('AGENT_KERNEL_RUNTIME:-auto')) {
      fail(`${asset} must support AGENT_KERNEL_RUNTIME=auto|cjs|native`)
    }
    if (!text.includes('[ "$runtime" = "auto" ] && has_node22')) {
      fail(`${asset} must prefer compact .cjs assets when Node.js 22+ is available`)
    }
    if (!text.includes('Agent RunLab bootstrap | %s')) {
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

const shellAssets = manifest.assets.filter((asset) => asset.endsWith('.sh'))
if (shellAssets.length > 1) fail(`expected at most one shell bootstrap, got ${shellAssets.join(', ')}`)

const notesPath = join(releaseDir, 'RELEASE_NOTES.md')
if (!existsSync(notesPath)) fail('missing release/RELEASE_NOTES.md')
const notes = readFileSync(notesPath, 'utf8')
if (manifest.assets.includes('run.sh') && !notes.includes('wget -nv -O "$tmp"')) {
  fail('release notes missing diagnostic bootstrap download command')
}
if (notes.includes('curl ')) {
  fail('release notes must not mention curl')
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

const checksum = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
  cwd: releaseDir,
  stdio: 'inherit',
})
if (checksum.status !== 0) fail('SHA256SUMS verification failed')

if (manifest.assets.includes('agent-kernel-executor.cjs')) {
  const executorHelp = spawnSync('node', ['agent-kernel-executor.cjs', '--help'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executorHelp.status !== 0) fail('executor --help smoke test should exit 0')
  const helpOutput = `${executorHelp.stdout}\n${executorHelp.stderr}`
  if (!helpOutput.includes('Agent RunLab Executor') || !helpOutput.includes('Usage:') || !helpOutput.includes('agent-kernel-executor.cjs --host <url>') || !helpOutput.includes('--sandbox-root <path>')) {
    fail('executor --help smoke test did not print CLI usage')
  }
  if (helpOutput.includes('connecting to')) {
    fail('executor --help must not connect to a host')
  }

  const executorVersion = spawnSync('node', ['agent-kernel-executor.cjs', '--version'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executorVersion.status !== 0) fail('executor --version smoke test should exit 0')
  if (!/^Agent RunLab Executor \d+\.\d+\.\d+/m.test(executorVersion.stdout)) {
    fail('executor --version smoke test did not print version')
  }

  const executor = spawnSync('node', ['agent-kernel-executor.cjs'], {
    cwd: releaseDir,
    encoding: 'utf8',
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
  if (!output.includes('Agent RunLab Runtime') || !output.includes('Usage:') || !output.includes('bundle-dashboard-with-runtime.cjs [options]') || !output.includes('--port <port>')) {
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
  if (!/^Agent RunLab Runtime \d+\.\d+\.\d+/m.test(hostVersion.stdout)) {
    fail('host -v smoke test did not print version')
  }
}

const nativeExecutor = manifest.assets.find((asset) => asset === nativeAssetName('agent-kernel-executor'))
if (nativeExecutor) {
  const executor = spawnSync(`./${nativeExecutor}`, [], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executor.status !== 1) fail('native executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('missing host url') || !output.includes('"flag":"--host"') || !output.includes('"env":"HOST_URL"')) {
    fail('native executor usage smoke test did not print usage')
  }
}

console.log('release assets verified')

function isNativeAsset(asset) {
  return /^agent-kernel-(host|executor)-(linux|darwin|win32)-(x64|arm64)(\.exe)?$/.test(asset)
}

function nativeAssetName(base) {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return `${base}-${os}-${arch}${os === 'win32' ? '.exe' : ''}`
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
