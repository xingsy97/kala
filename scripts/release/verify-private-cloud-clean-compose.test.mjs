import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const script = 'scripts/release/verify-private-cloud-clean-compose.mjs'
const identities = {
  PRIVATE_CLOUD_TEST_ALICE_EMAIL: 'alice@example.test',
  PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER: 'https://identity.example.test',
  PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: 'alice-idp-subject-7f2',
  PRIVATE_CLOUD_TEST_BOB_EMAIL: 'bob@example.test',
  PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER: 'https://identity.example.test',
  PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: 'bob-idp-subject-9a4',
}

const valid = {
  unitResourceIsolation: { aliceArtifactStatuses: [400], bobArtifactStatuses: [200] },
  restartRecovery: {
    queuedMarkerRecovered: true,
    cursorBefore: 2,
    cursorAfter: 5,
    dagRunIdBefore: 'run-1',
    dagRunIdAfter: 'run-1',
    dagLeaseEventsBefore: 1,
    dagLeaseEventsAfter: 2,
  },
}

test('plans two distinct Organizations from explicit OIDC claims without exposing subjects', () => {
  const result = inspectProvisioning(identities)
  assert.equal(result.status, 0, result.stderr)
  const requests = JSON.parse(result.stdout).requests
  assert.deepEqual(requests.map(({ name, issuer, email }) => ({ name, issuer, email })), [
    { name: 'alice', issuer: identities.PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER, email: identities.PRIVATE_CLOUD_TEST_ALICE_EMAIL },
    { name: 'bob', issuer: identities.PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER, email: identities.PRIVATE_CLOUD_TEST_BOB_EMAIL },
  ])
  assert.equal(requests[0].subject, undefined)
  assert.equal(requests[0].subjectSha256, createHash('sha256').update(identities.PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT).digest('hex'))
  assert.notEqual(requests[0].organizationName, requests[1].organizationName)
  assert.notEqual(requests[0].contractReference, requests[1].contractReference)
  assert.notEqual(requests[0].operationId, requests[1].operationId)
})

test('requires independent exact OIDC subjects and never falls back to owner email', () => {
  const missing = inspectProvisioning({ ...identities, PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: '' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT is required/u)

  const duplicate = inspectProvisioning({
    ...identities,
    PRIVATE_CLOUD_TEST_BOB_EMAIL: 'other@example.test',
    PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: identities.PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT,
  })
  assert.notEqual(duplicate.status, 0)
  assert.match(duplicate.stderr, /distinct exact OIDC issuer\/sub identities/u)
})

test('installs either the candidate or predecessor before provisioning and first login', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  const selection = source.indexOf('const initialBundle = freshCandidate ? candidate : predecessor')
  const install = source.indexOf("operator(initialOperator, ['install'")
  const provision = source.indexOf('provisionAcceptanceOrganizations(worktreeOperator, env, organizationRequests)')
  const login = source.indexOf('const browser = await puppeteer.launch')
  assert.ok(selection >= 0 && install > selection && provision > install && login > provision)
  assert.match(source, /const initialOperator = freshCandidate \? candidateOperator : bundleOperator\(predecessor\)/u)
  assert.match(source, /worktreeOperator = join\(root, 'scripts\/deploy\/kala-private-cloud\.mjs'\)/u)
})

test('predecessor lifecycle binds signed archive version and revision to the selected tag', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /predecessorTag = freshCandidate \? undefined : required\('--predecessor-tag'\)/u)
  assert.match(source, /predecessorManifest\.revision !== predecessorRevision/u)
  assert.match(source, /predecessorManifest\.version !== predecessorTag\.slice\(1\)/u)
})

test('fresh mode requires no predecessor and proves candidate checks without upgrade or rollback claims', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /predecessorArchive = freshCandidate \? undefined/u)
  assert.match(source, /target = freshCandidate \? 'linux-x64-compose-fresh'/u)
  assert.match(source, /freshCandidateInstall: true/u)
  assert.match(source, /imageDigestPinning: true/u)
  const freshBranch = source.slice(source.indexOf('if (freshCandidate) {', source.indexOf("if (!workspace.stdout.trim())")), source.indexOf('} else {', source.indexOf("if (!workspace.stdout.trim())")))
  assert.match(freshBranch, /verifyCandidateRuntimeGates/u)
  assert.match(freshBranch, /verifyBackupRestore/u)
  assert.doesNotMatch(freshBranch, /upgrade|rollback/u)
})

test('keeps tenant capabilities protected until a browser has authenticated', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /fetch\('http:\/\/localhost:13001\/runtime\/capabilities'\)\)\.status !== 401/u)
  assert.match(source, /const capabilities = await page\.evaluate\(async \(\) => \{/u)
  assert.match(source, /await fetch\('\/runtime\/capabilities'\)/u)
  assert.doesNotMatch(source, /waitForHttp\([^\n]*\/runtime\/capabilities/u)
})

test('accepts candidate Runtime gate evidence only when quota isolation and restart state are complete', () => {
  const result = check(valid)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true })
})

test('rejects a quota result that could hide cross-Unit coupling or partial admission', () => {
  const result = check({ ...valid, unitResourceIsolation: { aliceArtifactStatuses: [400], bobArtifactStatuses: [400] } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /per-Unit artifact quota/u)
})

test('rejects cursor regression or a missing recovered queued operation', () => {
  const result = check({ ...valid, restartRecovery: { ...valid.restartRecovery, queuedMarkerRecovered: false, cursorAfter: 1 } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /queue or Session cursor/u)
})

test('rejects a replaced DAG run or lost lease history after restart', () => {
  const result = check({ ...valid, restartRecovery: { ...valid.restartRecovery, dagRunIdAfter: 'run-2', dagLeaseEventsAfter: 0 } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DAG lease history/u)
})

function inspectProvisioning(env) {
  return spawnSync(process.execPath, [script, '--internal-inspect-organization-provisioning'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function check(report) {
  return spawnSync(process.execPath, [script, '--internal-assert-runtime-gates'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(report),
  })
}
