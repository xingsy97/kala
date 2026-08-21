#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

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
await chmod(dir, 0o700)
process.stdout.write(`Private Cloud secrets prepared at ${dir}; existing files were preserved.\n`)
