import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { rootCertificates } from 'node:tls'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const image = (name, character) => `ghcr.io/example/${name}@sha256:${character.repeat(64)}`

test('source-free init-config creates protected material and preflight blocks every external placeholder', async () => {
  const appPort = await freePort()
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-config-'))
  const bundle = join(scratch, 'bundle')
  build(bundle)
  const bin = join(scratch, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'openssl'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
for(const option of ['-keyout','-out']){const index=args.indexOf(option);if(index>=0)fs.writeFileSync(args[index+1],option==='-keyout'?'TEST PRIVATE KEY':'TEST CERTIFICATE')}
`)
  const dockerCapture = join(scratch, 'docker-calls.jsonl')
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.DOCKER_CAPTURE,JSON.stringify({args:process.argv.slice(2),oidcCa:process.env.KALA_OIDC_CA_FILE,nfsAddress:process.env.KALA_NFS_LISTEN_ADDRESS,nfsPort:process.env.KALA_NFS_PORT})+'\\n');
if(process.argv.includes('--version')||process.argv.includes('version')) console.log('fixture version')
`)
  chmodSync(join(bin, 'openssl'), 0o755); chmodSync(join(bin, 'docker'), 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator'), DOCKER_CAPTURE: dockerCapture }
  const cli = join(bundle, 'kala-private-cloud.mjs'); const config = join(scratch, 'config')
  const initialized = run(process.execPath, [cli, 'init-config', '--bundle', bundle, '--config-dir', config, '--profile', 'cloudflare', '--identity', 'external', '--app-port', String(appPort)], { env })
  assert.equal(JSON.parse(initialized.stdout).ok, true)
  const nfsPort = JSON.parse(initialized.stdout).nfsPort
  assert.ok(Number.isInteger(nfsPort) && nfsPort >= 1024)
  assert.doesNotMatch(initialized.stdout, /REPLACE_WITH/u)
  assert.equal(statSync(join(config, 'secrets')).mode & 0o077, 0)
  assert.equal(statSync(join(config, 'secrets', 'session_secret')).mode & 0o077, 0)

  const placeholder = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
  assert.notEqual(placeholder.status, 0)
  assert.match(placeholder.stderr, /external IdP|placeholder/u)

  writeFileSync(join(config, 'deployment.env'), [
    'KALA_PROFILE=cloudflare', 'KALA_STORAGE=nfs', 'COMPOSE_PROJECT_NAME=kala-private-cloud',
    'KALA_PUBLIC_URLS=https://kala.example.test', 'OIDC_ISSUER=https://id.example.test',
    'OIDC_DISCOVERY_ORIGIN=https://id.example.test', `KALA_PUBLIC_LISTEN=127.0.0.1:${appPort}`, `KALA_NFS_PORT=${nfsPort}`, '',
  ].join('\n'), { mode: 0o600 })
  for (const [name, value] of [['oidc_client_id', 'real-client'], ['oidc_client_secret', 'real-client-secret'], ['llm_api_key', 'real-provider-key']]) writeFileSync(join(config, 'secrets', name), value, { mode: 0o600 })
  const catalog = JSON.parse(readFileSync(join(config, 'runtime-provider-catalog.json'), 'utf8'))
  for (const provider of catalog.providers) provider.baseUrl = 'https://llm.example.test/v1'
  writeFileSync(join(config, 'runtime-provider-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 })
  const checked = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env })
  assert.deepEqual(JSON.parse(checked.stdout).checks, ['bundle-integrity', 'configuration', 'secret-permissions', 'external-oidc-values', 'oidc-private-ca', 'provider-key', 'docker-daemon', 'docker-compose', 'compose-config', 'loopback-ports'])
  let dockerCalls = readFileSync(dockerCapture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(dockerCalls.some((call) => call.args.some((arg) => arg.endsWith('compose.oidc-private-ca.yaml'))), false)
  assert.equal(dockerCalls.some((call) => call.oidcCa), false)
  const hostileShell = { ...env, KALA_NFS_LISTEN_ADDRESS: '0.0.0.0', KALA_NFS_PORT: String(appPort) }
  run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env: hostileShell })
  dockerCalls = readFileSync(dockerCapture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(dockerCalls.at(-1).nfsAddress, '127.0.0.1')
  assert.equal(dockerCalls.at(-1).nfsPort, String(nfsPort))

  // Another service owns the port: preflight must fail before touching Docker,
  // and must leave the listening service and saved OIDC origin unchanged.
  const occupant = createServer()
  await new Promise((resolve, reject) => { occupant.once('error', reject); occupant.listen(appPort, '127.0.0.1', resolve) })
  try {
    const beforeCalls = readFileSync(dockerCapture, 'utf8')
    const beforeConfig = readFileSync(join(config, 'deployment.env'), 'utf8')
    const collision = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
    assert.notEqual(collision.status, 0)
    assert.match(collision.stderr, new RegExp(`loopback port ${appPort} is already in use`, 'u'))
    assert.equal(occupant.listening, true)
    assert.equal(readFileSync(dockerCapture, 'utf8'), beforeCalls)
    assert.equal(readFileSync(join(config, 'deployment.env'), 'utf8'), beforeConfig)
  } finally { await new Promise((resolve) => occupant.close(resolve)) }

  const nfsOccupant = createServer()
  await new Promise((resolve, reject) => { nfsOccupant.once('error', reject); nfsOccupant.listen(nfsPort, '127.0.0.1', resolve) })
  try {
    const beforeCalls = readFileSync(dockerCapture, 'utf8')
    const collision = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
    assert.notEqual(collision.status, 0)
    assert.match(collision.stderr, new RegExp(`local NFS loopback port ${nfsPort} is already in use`, 'u'))
    assert.equal(nfsOccupant.listening, true)
    assert.equal(readFileSync(dockerCapture, 'utf8'), beforeCalls)
  } finally { await new Promise((resolve) => nfsOccupant.close(resolve)) }

  const safeConfig = readFileSync(join(config, 'deployment.env'), 'utf8')
  for (const [unsafe, reason] of [['KALA_NFS_LISTEN_ADDRESS=0.0.0.0', /local NFS must bind its own distinct 127\.0\.0\.1 port/u], [`KALA_NFS_PORT=${appPort}`, /local NFS must bind its own distinct 127\.0\.0\.1 port/u]]) {
    writeFileSync(join(config, 'deployment.env'), `${safeConfig}\n${unsafe}\n`, { mode: 0o600 })
    const rejected = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, reason)
  }
  writeFileSync(join(config, 'deployment.env'), safeConfig, { mode: 0o600 })

  const caPath = join(config, 'oidc-ca.pem')
  writeFileSync(caPath, `${rootCertificates[0]}\n`, { mode: 0o600 })
  const privateCaChecked = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env })
  assert.equal(JSON.parse(privateCaChecked.stdout).ok, true)
  dockerCalls = readFileSync(dockerCapture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const privateCaCompose = dockerCalls.findLast((call) => call.args.includes('config'))
  assert.equal(privateCaCompose.oidcCa, caPath)
  assert.equal(privateCaCompose.args.some((arg) => arg.endsWith('compose.oidc-private-ca.yaml')), true)
  const override = readFileSync(join(bundle, 'compose.oidc-private-ca.yaml'), 'utf8')
  assert.match(override, /runtime-ingress:[\s\S]*NODE_EXTRA_CA_CERTS: \/run\/kala-secrets\/oidc_ca\.pem/u)
  assert.doesNotMatch(override, /runtime-host:|dashboard:/u)
  assert.ok(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')).files['compose.oidc-private-ca.yaml'])

  chmodSync(caPath, 0o644)
  const permissive = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
  assert.notEqual(permissive.status, 0)
  assert.match(permissive.stderr, /owner-readable.*0600 or 0400/u)
  writeFileSync(caPath, '-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----\n', { mode: 0o600 })
  chmodSync(caPath, 0o600)
  const privateKey = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
  assert.notEqual(privateKey.status, 0)
  assert.match(privateKey.stderr, /never a private key/u)
  const caTarget = join(scratch, 'symlinked-ca.pem')
  writeFileSync(caTarget, `${rootCertificates[0]}\n`, { mode: 0o600 })
  rmSync(caPath); symlinkSync(caTarget, caPath)
  const symlinked = run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env, allowFailure: true })
  assert.notEqual(symlinked.status, 0)
  assert.match(symlinked.stderr, /regular file, not a symlink/u)
})

test('init-config never overwrites a non-empty configuration directory', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-config-preserve-'))
  const config = join(scratch, 'config'); mkdirSync(config); writeFileSync(join(config, 'keep'), 'operator data')
  const result = run(process.execPath, [join(root, 'scripts/deploy/kala-private-cloud.mjs'), 'init-config', '--bundle', scratch, '--config-dir', config, '--profile', 'local'], { allowFailure: true, env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator') } })
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(join(config, 'keep'), 'utf8'), 'operator data')
})

test('bundled initialization avoids an occupied default port and persists matching local OIDC origins', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-ports-'))
  const bundle = join(scratch, 'bundle'); build(bundle)
  const config = join(scratch, 'config')
  const occupant = createServer()
  const ownsDefault = await new Promise((resolve, reject) => {
    occupant.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
    occupant.listen(13001, '127.0.0.1', () => resolve(true))
  })
  const nfsOccupant = createServer()
  const ownsNfsDefault = await new Promise((resolve, reject) => {
    nfsOccupant.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
    nfsOccupant.listen(12049, '127.0.0.1', () => resolve(true))
  })
  try {
    const env = { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator') }
    const invalid = run(process.execPath, [join(bundle, 'kala-private-cloud.mjs'), 'init-config', '--bundle', bundle, '--config-dir', config, '--identity', 'bundled', '--app-port', '13101'], { env, allowFailure: true })
    assert.notEqual(invalid.status, 0)
    const initialized = run(process.execPath, [join(bundle, 'kala-private-cloud.mjs'), 'init-config', '--bundle', bundle, '--config-dir', config, '--identity', 'bundled'], { env })
    const result = JSON.parse(initialized.stdout)
    assert.notEqual(result.kalaUrl, 'http://localhost:13001')
    assert.notEqual(result.nfsPort, 12049)
    const storageCompose = readFileSync(join(bundle, 'compose.storage-nfs.yaml'), 'utf8')
    assert.match(storageCompose, /KALA_NFS_SUBNET:-192\.0\.2\.0\/24/u)
    const configText = readFileSync(join(config, 'deployment.env'), 'utf8')
    const appPort = Number(new URL(result.kalaUrl).port)
    const identityPort = Number(new URL(result.identityUrl).port)
    assert.notEqual(appPort, identityPort)
    assert.ok(configText.includes(`KALA_PUBLIC_LISTEN=127.0.0.1:${appPort}`))
    assert.ok(configText.includes(`KALA_PUBLIC_URLS=http://localhost:${appPort}`))
    assert.ok(configText.includes(`KALA_IDENTITY_PORT=${identityPort}`))
    assert.ok(configText.includes(`OIDC_ISSUER=http://localhost:${identityPort}`))
    assert.ok(configText.includes(`KALA_NFS_PORT=${result.nfsPort}`))
    assert.equal(statSync(join(config, 'identity-secrets')).mode & 0o077, 0)
    if (ownsDefault) assert.equal(occupant.listening, true)
    if (ownsNfsDefault) assert.equal(nfsOccupant.listening, true)
  } finally {
    if (ownsDefault) await new Promise((resolve) => occupant.close(resolve))
    if (ownsNfsDefault) await new Promise((resolve) => nfsOccupant.close(resolve))
  }
})

test('explicit local-volume storage avoids NFS port selection and rejects a meaningless NFS override', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-local-volume-'))
  const bundle = join(scratch, 'bundle'); build(bundle)
  const config = join(scratch, 'config')
  const appPort = await freePort()
  let identityPort = await freePort()
  while (identityPort === appPort) identityPort = await freePort()
  const cli = join(bundle, 'kala-private-cloud.mjs')
  const env = { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator') }
  const args = [cli, 'init-config', '--bundle', bundle, '--config-dir', config, '--identity', 'bundled', '--storage', 'local-volume', '--app-port', String(appPort), '--identity-port', String(identityPort)]
  const bad = run(process.execPath, [...args, '--nfs-port', '12149'], { env, allowFailure: true })
  assert.notEqual(bad.status, 0)
  const created = JSON.parse(run(process.execPath, args, { env }).stdout)
  assert.equal(created.storage, 'local-volume')
  assert.equal(created.nfsPort, undefined)
  const configText = readFileSync(join(config, 'deployment.env'), 'utf8')
  assert.match(configText, /KALA_STORAGE=local-volume/u)
  assert.doesNotMatch(configText, /KALA_NFS_PORT=/u)
})

function freePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) }) }
function build(output) {
  run(process.execPath, ['scripts/release/build-private-cloud-bundle.mjs', '--output', output, '--runtime-image', image('runtime', 'a'), '--ingress-image', image('ingress', 'b'), '--dashboard-image', image('dashboard', 'c'), '--revision', '1'.repeat(40)])
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: options.env ?? process.env })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} failed: ${result.stderr}`)
  return result
}
