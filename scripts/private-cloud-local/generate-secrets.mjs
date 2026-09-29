#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = resolve(process.argv[2] ?? 'deploy/private-cloud/.secrets')
await mkdir(dir, { recursive: true, mode: 0o700 })
const values = {
  control_postgres_password: randomBytes(32).toString('base64url'),
  session_secret: randomBytes(48).toString('base64url'),
  ingress_secret: randomBytes(48).toString('base64url'),
  oidc_client_id: 'REPLACE_AFTER_ZITADEL_BOOTSTRAP',
  oidc_client_secret: 'REPLACE_AFTER_ZITADEL_BOOTSTRAP',
  llm_api_key: 'REPLACE_WITH_PROVIDER_API_KEY',
}
for (const [name, value] of Object.entries(values)) {
  const path = resolve(dir, name)
  try { await access(path, constants.F_OK); continue } catch {}
  await writeFile(path, value, { mode: 0o600, flag: 'wx' })
}
const tlsFiles = ['internal_ca_key.pem', 'internal_ca.pem', 'runtime_host_key.pem', 'runtime_host.pem', 'ingress_client_key.pem', 'ingress_client.pem', 'runtime_health_key.pem', 'runtime_health.pem']
const existingTlsFiles = (await Promise.all(tlsFiles.map(async (name) => {
  try { await access(resolve(dir, name), constants.F_OK); return name } catch { return undefined }
}))).filter(Boolean)
if (existingTlsFiles.length !== 0 && existingTlsFiles.length !== tlsFiles.length) {
  throw new Error(`Private Cloud mTLS material is incomplete; preserve or remove all of: ${tlsFiles.join(', ')}`)
}
if (existingTlsFiles.length === 0) {
  const serverExt = resolve(dir, '.runtime-host.ext')
  const clientExt = resolve(dir, '.ingress-client.ext')
  await writeFile(serverExt, 'subjectAltName=DNS:runtime-host\nextendedKeyUsage=serverAuth\n', { mode: 0o600 })
  await writeFile(clientExt, 'extendedKeyUsage=clientAuth\n', { mode: 0o600 })
  try {
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650', '-subj', '/CN=Kala Private Cloud Internal CA', '-keyout', resolve(dir, 'internal_ca_key.pem'), '-out', resolve(dir, 'internal_ca.pem')])
    openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=runtime-host', '-keyout', resolve(dir, 'runtime_host_key.pem'), '-out', resolve(dir, 'runtime_host.csr')])
    openssl(['x509', '-req', '-days', '825', '-in', resolve(dir, 'runtime_host.csr'), '-CA', resolve(dir, 'internal_ca.pem'), '-CAkey', resolve(dir, 'internal_ca_key.pem'), '-CAcreateserial', '-extfile', serverExt, '-out', resolve(dir, 'runtime_host.pem')])
    openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=runtime-ingress', '-keyout', resolve(dir, 'ingress_client_key.pem'), '-out', resolve(dir, 'ingress_client.csr')])
    openssl(['x509', '-req', '-days', '825', '-in', resolve(dir, 'ingress_client.csr'), '-CA', resolve(dir, 'internal_ca.pem'), '-CAkey', resolve(dir, 'internal_ca_key.pem'), '-CAcreateserial', '-extfile', clientExt, '-out', resolve(dir, 'ingress_client.pem')])
    openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=runtime-health', '-keyout', resolve(dir, 'runtime_health_key.pem'), '-out', resolve(dir, 'runtime_health.csr')])
    openssl(['x509', '-req', '-days', '825', '-in', resolve(dir, 'runtime_health.csr'), '-CA', resolve(dir, 'internal_ca.pem'), '-CAkey', resolve(dir, 'internal_ca_key.pem'), '-CAcreateserial', '-extfile', clientExt, '-out', resolve(dir, 'runtime_health.pem')])
  } finally {
    await Promise.all(['runtime_host.csr', 'ingress_client.csr', 'runtime_health.csr', 'internal_ca.srl', '.runtime-host.ext', '.ingress-client.ext'].map((name) => rm(resolve(dir, name), { force: true })))
  }
}
for (const name of tlsFiles) await chmod(resolve(dir, name), 0o600)
await chmod(dir, 0o700)
process.stdout.write(`Private Cloud secrets prepared at ${dir}; existing files were preserved.\n`)

function openssl(args) {
  const result = spawnSync('openssl', args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`openssl exited ${String(result.status)}`)
}
