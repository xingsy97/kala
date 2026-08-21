#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const origin = process.env.ZITADEL_INTERNAL_ORIGIN ?? 'http://localhost:13002'
const host = process.env.ZITADEL_PUBLIC_HOST ?? 'localhost:13002'
const volume = process.env.ZITADEL_BOOTSTRAP_VOLUME ?? 'agent-runlab-identity-zitadel-bootstrap'
const pat = process.env.ZITADEL_PAT?.trim() || execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${volume}:/bootstrap:ro`, 'alpine:3.22.2', 'cat', '/bootstrap/bootstrap.pat'], { encoding: 'utf8' }).trim()
const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
const password = `RunLab-${randomBytes(12).toString('base64url')}!2a`
const headers = { authorization: `Bearer ${pat}`, 'content-type': 'application/json', 'x-zitadel-instance-host': host, 'x-zitadel-public-host': host }
const users = []
for (const name of ['alice', 'bob']) {
  const email = `runlab-${name}-${suffix}@example.test`
  const response = await fetch(`${origin}/v2/users/human`, { method: 'POST', headers, body: JSON.stringify({
    username: email,
    profile: { givenName: name === 'alice' ? 'Alice' : 'Bob', familyName: 'RunLab', displayName: `${name === 'alice' ? 'Alice' : 'Bob'} RunLab` },
    email: { email, isVerified: true },
    password: { password, changeRequired: false },
  }) })
  const body = await response.json()
  if (!response.ok || !body.userId) throw new Error(`create ${name} failed: ${response.status} ${JSON.stringify(body)}`)
  users.push({ name, id: body.userId, email, password })
}
process.stdout.write(`${JSON.stringify({ origin, users })}\n`)
