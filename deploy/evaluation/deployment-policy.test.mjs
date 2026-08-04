import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('./', import.meta.url)
const compose = await readFile(new URL('compose.yaml', root), 'utf8')
const templates = await readFile(new URL('run-templates.json', root), 'utf8')
const builder = await readFile(new URL('build-swe-bench-trial-image.sh', root), 'utf8')

function serviceBlock(name, next) {
  const servicesStart = compose.indexOf('\nservices:')
  const start = compose.indexOf(`  ${name}:`, servicesStart)
  const end = next ? compose.indexOf(`  ${next}:`, start + 1) : compose.indexOf('\nsecrets:', start)
  assert.notEqual(start, -1)
  return compose.slice(start, end)
}

test('published ports default to loopback and services have operational limits', () => {
  assert.match(compose, /AGENT_EVAL_BIND_ADDRESS:-127\.0\.0\.1/g)
  for (const name of ['orchestrator', 'analyzer', 'dashboard']) {
    const block = serviceBlock(name, name === 'orchestrator' ? 'analyzer' : name === 'analyzer' ? 'docker-worker' : undefined)
    assert.match(block, /deploy:/)
  }
  assert.match(compose.slice(compose.indexOf('x-worker:'), compose.indexOf('services:')), /deploy:/)
  assert.match(compose, /restart: unless-stopped/)
  assert.match(compose, /max-size: "10m"/)
  const initializer = serviceBlock('config-init', 'orchestrator')
  assert.match(initializer, /cap_add: \["DAC_OVERRIDE"\]/)
  assert.doesNotMatch(serviceBlock('orchestrator', 'analyzer'), /cap_add:/)
  assert.doesNotMatch(serviceBlock('docker-worker', 'lxd-worker'), /cap_add:/)
  assert.doesNotMatch(serviceBlock('lxd-worker', 'dashboard'), /cap_add:/)
})

test('auth, scoped tokens, signing key, and model settings are file secrets', () => {
  for (const name of ['auth_config', 'worker_token', 'analyzer_token', 'dashboard_token', 'worker_signing_key', 'analyzer_signing_key', 'docker_model_settings', 'lxd_model_settings']) assert.match(compose, new RegExp(`\\n  ${name}:`))
  assert.doesNotMatch(compose, /AGENT_EVAL_(?:TOKEN|AUTH_CONFIG|SIGNING_KEY):\s*[^/\n]/)
  assert.match(serviceBlock('orchestrator', 'analyzer'), /\/run\/secrets\/auth_config/)
  assert.match(serviceBlock('analyzer', 'docker-worker'), /\/run\/secrets\/analyzer_signing_key/)
  assert.match(serviceBlock('docker-worker', 'lxd-worker'), /worker_signing_key/)
  assert.match(serviceBlock('lxd-worker', 'dashboard'), /worker_signing_key/)
  assert.doesNotMatch(serviceBlock('docker-worker', 'lxd-worker'), /analyzer_signing_key/)
  assert.doesNotMatch(serviceBlock('lxd-worker', 'dashboard'), /analyzer_signing_key/)
})

test('worker profiles are socket-exclusive and model credentials are profile-scoped', () => {
  const docker = serviceBlock('docker-worker', 'lxd-worker')
  const lxd = serviceBlock('lxd-worker', 'dashboard')
  assert.match(docker, /profiles: \["docker-worker"\]/)
  assert.match(docker, /docker\.sock/)
  assert.doesNotMatch(docker, /lxd\/unix\.socket|lxd_model_settings/)
  assert.match(docker, /docker_model_settings/)
  assert.match(lxd, /profiles: \["lxd-worker"\]/)
  assert.match(lxd, /lxd\/unix\.socket/)
  assert.doesNotMatch(lxd, /docker\.sock|docker_model_settings/)
  assert.match(lxd, /lxd_model_settings/)
})

test('committed deployment files contain no developer home, private IPv4, or fixed fingerprint', () => {
  const text = `${compose}\n${templates}\n${builder}`
  assert.doesNotMatch(text, /\/home\/[A-Za-z0-9._-]+\//)
  assert.doesNotMatch(text, /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/)
  assert.doesNotMatch(builder, /local:[a-f0-9]{64}/)
  assert.doesNotMatch(templates, /local:[a-f0-9]{64}/)
  assert.match(templates, /model-gateway\.invalid:3000/)
  assert.match(templates, /lxd-image\.invalid\/(?:base|swe-bench)/)
})
