import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const image = (name, digit) => `ghcr.io/example/${name}@sha256:${digit.repeat(64)}`

function run(args, env, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure) throw new Error(`setup failed: ${result.stderr}`)
  return result
}

test('setup collects external OIDC inputs once, checks then installs, without printing credentials', async () => {
  const appPort = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
  const scratch = mkdtempSync(join(tmpdir(), 'kala-setup-'))
  const bundle = join(scratch, 'bundle')
  run(['scripts/release/build-private-cloud-bundle.mjs', '--output', bundle, '--revision', '1'.repeat(40), '--runtime-image', image('runtime', 'a'), '--ingress-image', image('ingress', 'b'), '--dashboard-image', image('dashboard', 'c')], process.env)
  const bin = join(scratch, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'openssl'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
for(const name of ['-keyout','-out']) {const index=args.indexOf(name);if(index>=0)fs.writeFileSync(args[index+1],'test-pem')}
`)
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const args=process.argv.slice(2), fs=require('node:fs');
fs.appendFileSync(process.env.DOCKER_CALLS,JSON.stringify(args)+'\\n');
if(args.includes('ps')&&args.includes('json')) for(const service of ['runtime-host','runtime-ingress','dashboard']) console.log(JSON.stringify({Service:service,ID:'fixture-'+service,State:'running',Health:'healthy'}));
if(args.includes('config')&&args.includes('json')) console.log(JSON.stringify({volumes:{}}));
`)
  chmodSync(join(bin, 'openssl'), 0o755); chmodSync(join(bin, 'docker'), 0o755)
  const config = join(scratch, 'config')
  const catalog = { version: 1, defaultModel: 'test:small', providers: [{ id: 'test', wire: 'openai', baseUrl: 'https://model.example.test/v1', credentialRef: 'file:llm_api_key', models: [{ id: 'small', label: 'Small', contextWindow: 4096 }] }] }
  const catalogFile = join(scratch, 'catalog.json'); writeFileSync(catalogFile, JSON.stringify(catalog))
  for (const [name, value] of [['model-key', 'model-test-credential'], ['client-id', 'external-client-id'], ['client-secret', 'external-client-secret']]) writeFileSync(join(scratch, name), value, { mode: 0o600 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator'), DOCKER_CALLS: join(scratch, 'docker-calls') }
  const args = [join(bundle, 'kala-private-cloud.mjs'), 'setup', '--bundle', bundle, '--config-dir', config, '--identity', 'external', '--app-port', String(appPort), '--provider-catalog', catalogFile, '--llm-api-key-file', join(scratch, 'model-key'), '--oidc-issuer', 'https://id.example.test', '--oidc-discovery-origin', 'https://id.example.test', '--oidc-client-id-file', join(scratch, 'client-id'), '--oidc-client-secret-file', join(scratch, 'client-secret')]
  chmodSync(join(scratch, 'model-key'), 0o644)
  const bad = run(args, env, true)
  assert.notEqual(bad.status, 0)
  assert.equal(existsSync(config), false, 'bad input must fail before generating config')
  chmodSync(join(scratch, 'model-key'), 0o600)
  const occupant = createServer()
  await new Promise((resolve, reject) => { occupant.once('error', reject); occupant.listen(appPort, '127.0.0.1', resolve) })
  try {
    const occupied = run(args, env, true)
    assert.notEqual(occupied.status, 0)
    assert.match(occupied.stderr, /already in use/u)
    assert.equal(existsSync(config), false, 'a conflicting OIDC callback port must fail before creating identity configuration')
    assert.equal(existsSync(env.DOCKER_CALLS), false, 'a conflicting listener must not start or pull any Compose service')
    assert.equal(occupant.listening, true)
  } finally { await new Promise((resolve) => occupant.close(resolve)) }
  const installed = run(args, env)
  assert.match(installed.stdout, new RegExp(`"kalaUrl": "http://localhost:${appPort}"`, 'u'))
  assert.match(installed.stdout, /"browserLoginVerified": false/u)
  assert.match(installed.stdout, /"firstOwnerProvisioned": false/u)
  assert.doesNotMatch(installed.stdout + installed.stderr, /model-test-credential|external-client-secret/u)
  assert.equal(readFileSync(join(config, 'secrets', 'llm_api_key'), 'utf8'), 'model-test-credential')
  const calls = readFileSync(env.DOCKER_CALLS, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(calls.some((call) => call.includes('config')))
  assert.ok(calls.some((call) => call.includes('pull')))
  assert.ok(calls.some((call) => call.includes('up')))
  const repeated = run(args, env, true)
  assert.notEqual(repeated.status, 0)
  assert.match(repeated.stderr, /already installed/u)
})
