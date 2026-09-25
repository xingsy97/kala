import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { requiredReleaseEvidence } from './rc-evidence.mjs'

const reconcile = join(import.meta.dirname, 'reconcile-github-release-assets.mjs')
const verifyPromotion = join(import.meta.dirname, 'verify-promotion-candidate.mjs')
const digest = (value) => createHash('sha256').update(value).digest('hex')

test('gitless Private Cloud runtime context includes tracked release bootstrap inputs', () => {
  const dockerfile = readFileSync(join(import.meta.dirname, '../../deploy/private-cloud/images/Dockerfile.runtime-service'), 'utf8')
  for (const directory of ['docs', 'deploy/dedicated-systemd', 'scripts/deploy', 'scripts/release']) {
    assert.match(dockerfile, new RegExp(`^COPY ${directory} ${directory}$`, 'mu'))
  }
  assert.match(dockerfile, /docs\/\.tracked-release-docs/u)
})

test('release reconciliation deletes unrelated remote assets and proves exact local closure', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'release-reconcile-'))
  try {
    const release = join(temporary, 'release')
    const bin = join(temporary, 'bin')
    mkdirSync(release)
    mkdirSync(bin)
    writeFileSync(join(release, 'manifest.json'), '{}\n')
    writeFileSync(join(release, 'SHA256SUMS'), 'sums\n')
    const state = join(temporary, 'assets.json')
    const log = join(temporary, 'gh.log')
    writeFileSync(state, JSON.stringify(['manifest.json', 'stale-debug.zip']))
    const fakeGh = join(bin, 'gh')
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); let assets = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') process.stdout.write(JSON.stringify({ assets: assets.map(name => ({ name })) }));
else if (args[0] === 'release' && args[1] === 'delete-asset') assets = assets.filter(name => name !== args[3]);
else if (args[0] === 'release' && args[1] === 'upload') for (const file of args.slice(3, -1)) { const name = path.basename(file); if (!assets.includes(name)) assets.push(name); }
else process.exit(2);
fs.writeFileSync(process.env.GH_STATE, JSON.stringify(assets));
`)
    chmodSync(fakeGh, 0o755)
    const result = spawnSync(process.execPath, [reconcile, '--tag', 'v1.2.3-rc.1', '--directory', release], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STATE: state, GH_LOG: log },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).sort(), ['SHA256SUMS', 'manifest.json'])
    assert.match(readFileSync(log, 'utf8'), /delete-asset.*stale-debug\.zip/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('promotion verifier binds the closed current draft to all four accepted native hashes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'promotion-candidate-'))
  try {
    const candidate = join(temporary, 'candidate')
    const evidence = join(temporary, 'evidence')
    mkdirSync(candidate)
    mkdirSync(evidence)
    const tag = 'v1.2.3-rc.1'
    const revision = 'a'.repeat(40)
    const targets = [...requiredReleaseEvidence.portable.targets]
    const assets = targets.map((target) => `agent-kernel-host-${target}`)
    for (const [index, name] of assets.entries()) writeFileSync(join(candidate, name), `native-${index}\n`)
    writeFileSync(join(candidate, 'RELEASE_NOTES.md'), '# Notes\n')
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ version: tag.slice(1), source: { revision }, nativeTargets: targets, assets }, null, 2) + '\n')
    writeFileSync(join(candidate, 'SHA256SUMS.sigstore.json'), '{}\n')
    writeFileSync(join(candidate, 'rc-evidence.json'), '{"ok":true}\n')
    writeChecksums(candidate, [...assets, 'manifest.json', 'RELEASE_NOTES.md'])
    for (const [index, target] of targets.entries()) {
      const checks = Object.fromEntries(requiredReleaseEvidence.portable.checks.map((name) => [name, true]))
      writeFileSync(join(evidence, `${target}.rc-evidence.json`), JSON.stringify({
        schemaVersion: 1, category: 'portable', tag, version: tag.slice(1), revision, target,
        artifact: { name: assets[index], sha256: digest(readFileSync(join(candidate, assets[index]))) },
        ok: true, checks, generatedAt: '2026-01-01T00:00:00.000Z',
      }))
    }
    const args = [verifyPromotion, '--directory', candidate, '--evidence', evidence, '--aggregate', join(candidate, 'rc-evidence.json'), '--tag', tag, '--revision', revision]
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0)

    writeFileSync(join(candidate, 'stale-debug.zip'), 'stale')
    let result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /inventory is not closed/u)
    unlinkSync(join(candidate, 'stale-debug.zip'))

    writeFileSync(join(candidate, assets[0]), 'replaced-after-acceptance\n')
    writeChecksums(candidate, [...assets, 'manifest.json', 'RELEASE_NOTES.md'])
    result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /differs from its validated acceptance evidence/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

function writeChecksums(directory, names) {
  writeFileSync(join(directory, 'SHA256SUMS'), names.map((name) => `${digest(readFileSync(join(directory, name)))}  ${name}`).join('\n') + '\n')
}
