import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import vm from 'node:vm'
import { aptInstallSnippet } from '../../dashboard/public/downloads/desktop/apt-snippet.js'

const config = { schemaVersion: 1, url: 'https://packages.example.org/runlab', fingerprint: 'A'.repeat(40) }

test('APT bootstrap rejects missing configuration and shell interpolation', () => {
  for (const value of [
    undefined, { ...config, fingerprint: 'latest' },
    { ...config, url: 'http://packages.example.org' },
    { ...config, url: 'https://packages.example.org/$(id)' },
    { ...config, url: "https://packages.example.org/'" },
    { ...config, url: 'https://packages.example.org/../other' },
    { ...config, url: 'https://credentials.example.invalid' },
    { ...config, url: 'https://packages.example.org/?source=other' },
  ]) assert.throws(() => aptInstallSnippet(value))
  assert.equal(aptInstallSnippet({ ...config, fingerprint: 'a'.repeat(40) }), aptInstallSnippet(config))
  const syntax = spawnSync('bash', ['-n'], { input: aptInstallSnippet(config), encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

function exercise({ fingerprint = config.fingerprint, architecture = 'amd64', multiple = false, failUpdate = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'runlab-apt-snippet-'))
  const log = join(directory, 'calls')
  const source = join(directory, 'source')
  const executable = (name, script) => writeFileSync(join(directory, name), `#!/bin/bash\nset -eu\n${script}`, { mode: 0o755 })
  writeFileSync(log, '')
  writeFileSync(source, '')
  executable('dpkg', `printf '%s\\n' '${architecture}'`)
  executable('sudo', `printf '%s\\n' "$*" >> "$CALLS"
if [ "$1" = tee ]; then /usr/bin/tee "$SOURCE"; fi
if [ "$1" = apt-get ] && [ "$*" != "apt-get install -y ca-certificates curl gnupg" ] && [ -s "$SOURCE" ] && [ "$FAIL_UPDATE" = yes ]; then exit 100; fi`)
  executable('curl', `printf '%s\\n' "$*" >> "$CALLS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then printf 'fixture key\\n' > "$2"; break; fi
  shift
done`)
  executable('gpg', `printf 'pub::::::::::\\nfpr:::::::::${fingerprint}:\\nsub::::::::::\\nfpr:::::::::BBBB:\\n'
${multiple ? "printf 'pub::::::::::\\nfpr:::::::::CCCC:\\n'" : ''}`)
  try {
    const result = spawnSync('bash', [], {
      input: aptInstallSnippet(config), encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CALLS: log, SOURCE: source, FAIL_UPDATE: failUpdate ? 'yes' : 'no' },
    })
    return { ...result, log: readFileSync(log, 'utf8'), source: readFileSync(source, 'utf8') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('one pasted block validates key, writes scoped source, updates and installs', () => {
  const result = exercise()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.source, /URIs: https:\/\/packages.example.org\/runlab\//)
  assert.match(result.source, /Signed-By: \/etc\/apt\/keyrings\/agent-runlab-desktop.gpg/)
  assert.ok(result.log.indexOf('install -m 0644') < result.log.lastIndexOf('apt-get -o APT::Update::Error-Mode=any update'))
  assert.match(result.log, /apt-get install -y agent-runlab-desktop/)
  assert.doesNotMatch(result.log, /apt-key|trusted=yes|allow-unauthenticated/)
})

test('wrong or multiple keys cannot change sources; failed apt update cannot install', () => {
  for (const options of [{ fingerprint: 'B'.repeat(40) }, { multiple: true }, { architecture: 'arm64' }]) {
    const result = exercise(options)
    assert.notEqual(result.status, 0)
    assert.equal(result.source, '')
    assert.doesNotMatch(result.log, /install -m 0644|install -y agent-runlab-desktop/)
  }
  const failedUpdate = exercise({ failUpdate: true })
  assert.notEqual(failedUpdate.status, 0)
  assert.doesNotMatch(failedUpdate.log, /install -y agent-runlab-desktop/)
})

test('real GPG inspection does not create a trust database or alter user keyrings', {
  skip: !existsSync('/usr/share/keyrings/ubuntu-archive-keyring.gpg') || !existsSync('/usr/bin/gpg'),
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'runlab-gpg-inspect-'))
  try {
    const snippet = aptInstallSnippet(config)
    const invocation = snippet.slice(snippet.indexOf('gpg --'), snippet.indexOf('\nactual='))
      .replaceAll('"$tmp"', '"$GPG_HOME"')
      .replaceAll('"$tmp/key.gpg"', '"/usr/share/keyrings/ubuntu-archive-keyring.gpg"')
      .replace(' > "$tmp/key-info"', '')
    const result = spawnSync('bash', ['-c', invocation], {
      encoding: 'utf8', env: { ...process.env, GPG_HOME: directory },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^fpr:/m)
    assert.deepEqual(readdirSync(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('website exposes one copyable block only with valid published APT settings', async () => {
  const source = readFileSync(new URL('../../dashboard/public/downloads/desktop/install-apt.js', import.meta.url), 'utf8')
    .replace(/^import .+\n/, '')
  for (const scenario of [
    { status: 404 },
    { status: 500 },
    { status: 200, body: { ...config, fingerprint: 'unverified' } },
    { status: 200, body: config },
  ]) {
    const nodes = new Map()
    let copied
    const node = (id) => {
      if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', addEventListener: (_, callback) => { nodes.get(id).click = callback } })
      return nodes.get(id)
    }
    await vm.runInNewContext(`(async () => { ${source} })()`, {
      aptInstallSnippet, AbortSignal, document: { getElementById: node },
      navigator: { clipboard: { writeText: async (text) => { copied = text } } },
      fetch: async () => ({ status: scenario.status, ok: scenario.status === 200, json: async () => scenario.body }),
    })
    if (scenario.body === config) {
      assert.equal(node('apt-available').hidden, false)
      await node('apt-copy').click()
      assert.equal(copied, aptInstallSnippet(config))
    } else {
      assert.equal(node('apt-available').hidden, true)
      assert.equal(node('apt-commands').textContent, '')
    }
  }
})
