import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { formatFindings, loadPrivacyPolicy, scanEntry } from './privacy-check-lib.mjs'

const root = resolve(import.meta.dirname, '../..')
const policy = loadPrivacyPolicy(root)

test('allows public examples and registered runtime assets', () => {
  assert.deepEqual(scan('docs/example.md', 'home=/home/example ip=192.0.2.10 email=user@example.com path=`/home/example`'), [])
  assert.deepEqual(scan('docs/example.md', 'systemctl status agent-runlab-dedicated-unit@blue.service'), [])
  assert.deepEqual(scan('packages/dashboard/public/favicon.svg', readFileSync(join(root, 'packages/dashboard/public/favicon.svg'))), [])
})

test('blocks structural private data without echoing matched values', () => {
  const home = ['/home', 'private-user'].join('/')
  const ip = [10, 23, 45, 67].join('.')
  const findings = scan('docs/example.md', `home=${home}\nip=${ip}`)
  assert.deepEqual(findings.map(({ rule }) => rule), ['privacy.private-ipv4', 'privacy.personal-home'])
  const output = formatFindings(findings)
  assert.equal(output.includes(home), false)
  assert.equal(output.includes(ip), false)
})

test('blocks unregistered images, binary files, and private denylist values', () => {
  assert(scan('docs/design/preview.png', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.design-image'))
  assert(scan('fixtures/new.bin', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.unregistered-binary'))
  const marker = ['machine', 'only', 'marker'].join('-')
  assert(scan('docs/example.md', marker, [marker]).some(({ rule }) => rule === 'privacy.private-denylist'))
  const pathFinding = scanEntry({ path: `docs/${marker}/example.md`, content: `docs/${marker}/example.md`, policy, denylist: [marker], source: 'path' })
  assert(pathFinding.some(({ rule }) => rule === 'privacy.private-denylist'))
  assert.equal(formatFindings(pathFinding).includes(marker), false)
  const contentFinding = scanEntry({ path: `docs/${marker}/example.md`, content: [10, 2, 3, 4].join('.'), policy, denylist: [marker] })
  assert.equal(formatFindings(contentFinding).includes(marker), false)
  assert(scan('packages/dashboard/public/icons/icon-192.png', Buffer.from([0, 1, 2])).some(({ rule }) => rule === 'privacy.asset-content-drift'))
  const credential = ['sk-', 'test', 'A'.repeat(24)].join('')
  assert(scan('docs/example.md', credential).some(({ rule }) => rule === 'privacy.api-token'))
})

test('versioned hooks block a real commit and allow a public example commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'privacy-hook-'))
  try {
    run(directory, 'git', ['init', '-q'])
    run(directory, 'git', ['config', 'user.name', 'Example User'])
    run(directory, 'git', ['config', 'user.email', 'example@users.noreply.github.com'])
    run(directory, 'mkdir', ['-p', 'scripts/security', 'security', '.githooks'])
    for (const path of ['scripts/security/privacy-check.mjs', 'scripts/security/privacy-check-lib.mjs', 'security/privacy-policy.json', '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push']) {
      const target = join(directory, path)
      run(directory, 'cp', [join(root, path), target])
    }
    run(directory, 'git', ['config', 'core.hooksPath', '.githooks'])
    const privateIp = [10, 77, 88, 99].join('.')
    writeFileSync(join(directory, 'sample.txt'), `endpoint=${privateIp}\n`)
    run(directory, 'git', ['add', 'sample.txt'])
    writeFileSync(join(directory, 'sample.txt'), 'endpoint=192.0.2.10\n')
    const blocked = spawnSync('git', ['commit', '-m', 'add sample'], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(blocked.status, 0)
    assert.equal(`${blocked.stdout}${blocked.stderr}`.includes(privateIp), false)
    run(directory, 'git', ['add', 'sample.txt'])
    const messageBlocked = spawnSync('git', ['commit', '-m', `connect ${privateIp}`], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(messageBlocked.status, 0)
    assert.equal(`${messageBlocked.stdout}${messageBlocked.stderr}`.includes(privateIp), false)
    run(directory, 'git', ['commit', '-q', '-m', 'add public example'])
    assert.equal(run(directory, 'git', ['rev-list', '--count', 'HEAD']).stdout.trim(), '1')

    const bare = `${directory}-remote.git`
    run(directory, 'git', ['init', '--bare', '-q', bare])
    run(directory, 'git', ['remote', 'add', 'origin', bare])
    run(directory, 'git', ['push', '-q', '-u', 'origin', 'HEAD:main'])
    writeFileSync(join(directory, 'sample.txt'), `endpoint=${privateIp}\n`)
    run(directory, 'git', ['add', 'sample.txt'])
    run(directory, 'git', ['commit', '--no-verify', '-q', '-m', 'bypassed local commit hook'])
    const pushBlocked = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: directory, encoding: 'utf8' })
    assert.notEqual(pushBlocked.status, 0)
    assert.equal(`${pushBlocked.stdout}${pushBlocked.stderr}`.includes(privateIp), false)
    rmSync(bare, { recursive: true, force: true })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function scan(path, content, denylist = []) {
  return scanEntry({ path, content, policy, denylist })
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`)
  return result
}
