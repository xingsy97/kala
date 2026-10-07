import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const basePath = join(root, 'deploy/private-cloud/compose.yaml')
const overlayPath = join(root, 'deploy/private-cloud/compose.identity-local.yaml')
const caddyPath = join(root, 'deploy/private-cloud/identity-local/Caddyfile')
const identityReadmePath = join(root, 'deploy/private-cloud/identity-local/README.md')

test('identity overlay keeps credentials file-backed and exposure loopback-only', () => {
  const overlay = readFileSync(overlayPath, 'utf8')
  const caddy = readFileSync(caddyPath, 'utf8')
  const identityReadme = readFileSync(identityReadmePath, 'utf8')

  assert.match(overlay, /127\.0\.0\.1:\$\{KALA_IDENTITY_PORT:-13002\}:8080/u)
  assert.doesNotMatch(overlay, /\$\{[^}]*IDENTITY[^}]*BIND|0\.0\.0\.0:13002|(?:^|\s)13002:8080/u)
  assert.match(overlay, /KALA_INGRESS_IDENTITY_ORIGIN: http:\/\/identity-proxy:8080/u)
  assert.match(overlay, /OIDC_ISSUER: http:\/\/localhost:\$\{KALA_IDENTITY_PORT:-13002\}/u)
  assert.match(overlay, /KALA_IDENTITY_SECRETS_DIR:\?/u)
  assert.match(overlay, /initial_human_password/u)
  assert.doesNotMatch(overlay, /ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD(?:\s|:|=)/u)
  assert.doesNotMatch(overlay, /Password1!/u)
  assert.match(overlay, /Password: "\$\$human_password"/u)
  assert.match(overlay, /cat > \/config\/steps\.yaml <<EOF/u)
  assert.match(overlay, /--steps, \/zitadel\/config\/steps\.yaml/u)
  assert.match(overlay, /--tlsMode, disabled/u)
  assert.match(overlay, /HOSTNAME: 0\.0\.0\.0/u)
  assert.match(overlay, /directory mode must be 0700/u)
  assert.match(overlay, /zitadel_masterkey must contain exactly 32 bytes/u)
  assert.match(overlay, /cat \/identity-secrets\/zitadel_masterkey > \/config\/masterkey/u)
  assert.match(overlay, /chown 1000:65533 \/bootstrap\s+chmod 750 \/bootstrap/u)
  assert.match(overlay, /chown 1000:1000 \/config\/masterkey\s+chmod 400 \/config\/masterkey/u)
  assert.match(overlay, /--masterkeyFile, \/zitadel\/config\/masterkey/u)
  assert.doesNotMatch(overlay, /identity_zitadel_masterkey|\/run\/secrets\/identity_zitadel_masterkey/u)
  assert.match(overlay, /\+ 86400/u)
  assert.doesNotMatch(overlay, /ORG_MACHINE_PAT_EXPIRATIONDATE/u)
  assert.match(overlay, /ORG_LOGINCLIENT_PAT_EXPIRATIONDATE: "2099-01-01T00:00:00Z"/u)
  assert.match(overlay, /ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI: http:\/\/localhost:\$\{KALA_IDENTITY_PORT:-13002\}\/ui\/v2\/login/u)
  assert.match(overlay, /ZITADEL_OIDC_DEFAULTLOGINURLV2: http:\/\/localhost:\$\{KALA_IDENTITY_PORT:-13002\}\/ui\/v2\/login\/login\?authRequest=/u)
  assert.match(overlay, /ZITADEL_OIDC_DEFAULTLOGOUTURLV2: http:\/\/localhost:\$\{KALA_IDENTITY_PORT:-13002\}\/ui\/v2\/login\/logout\?post_logout_redirect=/u)
  assert.match(overlay, /\/app\/healthcheck\.mjs, \/ui\/v2\/login\/healthy/u)
  assert.doesNotMatch(overlay, /r\.status\s*<\s*500/u)
  assert.match(identityReadme, /source material.*flattens.*identity-local\.Caddyfile/su)
  assert.match(identityReadme, /Do not invoke the source overlay directly/u)

  for (const digest of overlay.matchAll(/image:\s+(\S+)/gu)) {
    assert.match(digest[1], /@sha256:[a-f0-9]{64}$/u)
  }
  assert.equal([...overlay.matchAll(/image:\s+(\S+)/gu)].length, 6)
  assert.equal([...overlay.matchAll(/ports:/gu)].length, 1)
  assert.match(overlay, /KALA_IDENTITY_HOST: localhost:\$\{KALA_IDENTITY_PORT:-13002\}/u)
  assert.equal([...caddy.matchAll(/header_up Host \{\$KALA_IDENTITY_HOST\}$/gmu)].length, 2)
  assert.equal([...caddy.matchAll(/header_up X-Forwarded-Proto http$/gmu)].length, 2)
  assert.doesNotMatch(caddy, /https|tls/u)
})

test('base, local, and identity overlay resolve as a valid Compose model', (t) => {
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (version.status !== 0) return t.skip('docker compose is not available')

  const scratch = mkdtempSync(join(tmpdir(), 'kala-identity-compose-'))
  const secrets = join(scratch, 'identity-secrets')
  mkdirSync(secrets, { mode: 0o700 })
  for (const [name, value] of [
    ['postgres_password', 'postgres-password-123456789'],
    ['zitadel_masterkey', '0123456789abcdef0123456789abcdef'],
    ['initial_human_password', 'Initial-Random-Password-123456'],
  ]) {
    writeFileSync(join(secrets, name), value, { mode: 0o600 })
    chmodSync(join(secrets, name), 0o600)
  }
  chmodSync(secrets, 0o700)

  const image = (name, character) => `ghcr.io/example/${name}@sha256:${character.repeat(64)}`
  const composeEnvironment = {
    ...process.env,
    KALA_IDENTITY_SECRETS_DIR: secrets,
    KALA_RUNTIME_IMAGE: image('runtime', 'a'),
    KALA_INGRESS_IMAGE: image('ingress', 'b'),
    KALA_DASHBOARD_IMAGE: image('dashboard', 'c'),
    OIDC_DISCOVERY_ORIGIN: 'http://identity-proxy:8080',
    OIDC_ISSUER: 'http://localhost:13002',
  }
  const composeConfig = (environment) => spawnSync('docker', ['compose', '-f', basePath, '-f', join(root, 'deploy/private-cloud/compose.local.yaml'), '-f', overlayPath, 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
  })
  const result = composeConfig(composeEnvironment)
  assert.equal(result.status, 0, result.stderr)
  const model = JSON.parse(result.stdout)
  assert.deepEqual(model.services['identity-proxy'].ports, [{ mode: 'ingress', target: 8080, published: '13002', protocol: 'tcp', host_ip: '127.0.0.1' }])
  assert.deepEqual(model.services['identity-proxy'].networks, { edge: null })
  assert.equal(model.services['runtime-ingress'].environment.KALA_INGRESS_IDENTITY_ORIGIN, 'http://identity-proxy:8080')
  assert.equal(model.services['runtime-ingress'].environment.OIDC_ISSUER, 'http://localhost:13002')
  assert.equal(model.networks.identity.internal, true)
  assert.equal(model.services['identity-zitadel'].environment.ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD, undefined)
  assert.equal(model.services['identity-zitadel'].environment.ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI, 'http://localhost:13002/ui/v2/login')
  assert.equal(model.services['identity-zitadel'].environment.ZITADEL_OIDC_DEFAULTLOGINURLV2, 'http://localhost:13002/ui/v2/login/login?authRequest=')
  assert.equal(model.services['identity-zitadel'].environment.ZITADEL_OIDC_DEFAULTLOGOUTURLV2, 'http://localhost:13002/ui/v2/login/logout?post_logout_redirect=')
  assert.deepEqual(model.services['identity-login'].healthcheck.test, ['CMD', '/usr/local/bin/node', '/app/healthcheck.mjs', '/ui/v2/login/healthy'])
  assert.equal(model.services['identity-zitadel'].secrets, undefined)

  const changed = composeConfig({
    ...composeEnvironment,
    KALA_PUBLIC_URLS: 'http://localhost:14101',
    KALA_PUBLIC_LISTEN: '127.0.0.1:14101',
    KALA_IDENTITY_PORT: '14102',
    OIDC_ISSUER: 'http://localhost:14102',
  })
  assert.equal(changed.status, 0, changed.stderr)
  const changedModel = JSON.parse(changed.stdout)
  assert.deepEqual(changedModel.services['identity-proxy'].ports, [{ mode: 'ingress', target: 8080, published: '14102', protocol: 'tcp', host_ip: '127.0.0.1' }])
  assert.equal(changedModel.services['identity-proxy'].environment.KALA_IDENTITY_HOST, 'localhost:14102')
  assert.equal(changedModel.services['identity-zitadel'].environment.ZITADEL_EXTERNALPORT, '14102')
  assert.equal(changedModel.services['identity-zitadel'].environment.ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI, 'http://localhost:14102/ui/v2/login')
  assert.equal(changedModel.services['identity-zitadel'].environment.ZITADEL_OIDC_DEFAULTLOGINURLV2, 'http://localhost:14102/ui/v2/login/login?authRequest=')
  assert.equal(changedModel.services['identity-zitadel'].environment.ZITADEL_OIDC_DEFAULTLOGOUTURLV2, 'http://localhost:14102/ui/v2/login/logout?post_logout_redirect=')
  assert.equal(changedModel.services['identity-login'].environment.CUSTOM_REQUEST_HEADERS, 'Host:localhost:14102,X-Forwarded-Proto:http')
  assert.ok(changedModel.services['identity-zitadel-health'].healthcheck.test.includes('Host: localhost:14102'))
  assert.equal(changedModel.services['runtime-ingress'].environment.KALA_PUBLIC_URLS, 'http://localhost:14101')
  assert.equal(changedModel.services['runtime-ingress'].environment.KALA_INGRESS_IDENTITY_ORIGIN, 'http://identity-proxy:8080')
  assert.equal(changedModel.services['runtime-ingress'].environment.OIDC_ISSUER, 'http://localhost:14102')
})
