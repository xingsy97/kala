#!/usr/bin/env node
import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const origin = process.env.ZITADEL_INTERNAL_ORIGIN ?? 'http://127.0.0.1:13002'
const force = process.argv.includes('--force-new-client')
const host = process.env.ZITADEL_PUBLIC_HOST ?? 'localhost:13002'
const secrets = resolve(process.env.PRIVATE_CLOUD_SECRETS_DIR ?? 'deploy/private-cloud/.secrets')
const patPath = process.env.ZITADEL_BOOTSTRAP_PAT ?? '/zitadel/bootstrap/bootstrap.pat'
const clientIdPath = resolve(secrets, 'oidc_client_id')
const clientSecretPath = resolve(secrets, 'oidc_client_secret')
if (!force) {
  try {
    await Promise.all([access(clientIdPath), access(clientSecretPath)])
    const [clientId, clientSecret] = await Promise.all([readFile(clientIdPath, 'utf8'), readFile(clientSecretPath, 'utf8')])
    if (clientId.trim() && clientSecret.trim() && !clientId.includes('REPLACE_') && !clientSecret.includes('REPLACE_')) {
      console.log(JSON.stringify({ reused: true, clientId: clientId.trim() }))
      process.exit(0)
    }
  } catch {}
}
let pat
if (process.env.ZITADEL_PAT) pat = process.env.ZITADEL_PAT.trim()
else {
  const volume = process.env.ZITADEL_BOOTSTRAP_VOLUME ?? 'agent-runlab-identity-zitadel-bootstrap'
  const { execFileSync } = await import('node:child_process')
  const relative = patPath.replace(/^\/zitadel\/bootstrap\//u, '')
  pat = execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${volume}:/bootstrap:ro`, 'alpine:3.22.2', 'cat', `/bootstrap/${relative}`], { encoding: 'utf8' }).trim()
}
if (!pat) throw new Error('ZITADEL bootstrap PAT is empty')
const headers = { authorization: `Bearer ${pat}`, 'content-type': 'application/json', 'x-zitadel-instance-host': host, 'x-zitadel-public-host': host }
async function post(path, body) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text(); if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`)
  return JSON.parse(text)
}
const projectName = process.env.ZITADEL_PROJECT_NAME ?? 'Kala Private Cloud'
const applicationName = process.env.ZITADEL_APPLICATION_NAME ?? 'Kala Gateway'
const project = await post('/management/v1/projects', { name: projectName, projectRoleAssertion: false, projectRoleCheck: false, hasProjectCheck: false })
const app = await post(`/management/v1/projects/${project.id}/apps/oidc`, {
  name: applicationName,
  redirectUris: ['http://localhost:13001/auth/callback'],
  responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
  grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
  appType: 'OIDC_APP_TYPE_WEB', authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
  postLogoutRedirectUris: ['http://localhost:13001/'], version: 'OIDC_VERSION_1_0',
  devMode: true, accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
})
for (const [name, value] of [['oidc_client_id', app.clientId], ['oidc_client_secret', app.clientSecret]]) {
  if (!value) throw new Error(`ZITADEL did not return ${name}`)
  const path = resolve(secrets, name); await writeFile(path, `${value}\n`, { mode: 0o600 }); await chmod(path, 0o600)
}
console.log(JSON.stringify({ projectId: project.id, applicationId: app.appId, clientId: app.clientId }))
