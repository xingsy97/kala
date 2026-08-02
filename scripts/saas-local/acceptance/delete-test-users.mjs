#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const ids = process.argv.slice(2).filter(Boolean)
if (!ids.length) throw new Error('usage: delete-test-users.mjs USER_ID...')
const origin = process.env.ZITADEL_INTERNAL_ORIGIN ?? 'http://localhost:13002'
const host = process.env.ZITADEL_PUBLIC_HOST ?? 'localhost:13002'
const volume = process.env.ZITADEL_BOOTSTRAP_VOLUME ?? 'agent-runlab-saas_zitadel-bootstrap'
const pat = process.env.ZITADEL_PAT?.trim() || execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${volume}:/bootstrap:ro`, 'alpine:3.22.2', 'cat', '/bootstrap/bootstrap.pat'], { encoding: 'utf8' }).trim()
for (const id of ids) {
  const response = await fetch(`${origin}/v2/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${pat}`, 'x-zitadel-instance-host': host, 'x-zitadel-public-host': host } })
  if (!response.ok && response.status !== 404) throw new Error(`delete ${id} failed: ${response.status} ${await response.text()}`)
}
process.stdout.write(`${JSON.stringify({ deleted: ids })}\n`)
