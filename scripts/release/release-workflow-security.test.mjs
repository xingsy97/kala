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

test('Private Cloud images pin a patched multi-platform Node base and exclude build tooling at runtime', () => {
  const digest = 'sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c'
  for (const name of ['runtime-service', 'runtime-ingress-gateway', 'dashboard']) {
    const dockerfile = readFileSync(join(import.meta.dirname, `../../deploy/private-cloud/images/Dockerfile.${name}`), 'utf8')
    assert.equal(dockerfile.match(new RegExp(`FROM node@${digest}`, 'gu'))?.length, 2)
    assert.doesNotMatch(dockerfile, /^COPY --from=build --chown=runlab:runlab \/app \/app$/mu)
  }
  for (const name of ['runtime-service', 'runtime-ingress-gateway']) {
    const dockerfile = readFileSync(join(import.meta.dirname, `../../deploy/private-cloud/images/Dockerfile.${name}`), 'utf8')
    assert.match(dockerfile, /pnpm deploy --legacy --filter @agent-kernel\/[^ ]+ --prod \/out\//u)
  }
})

test('Private Cloud scanner preserves failure while collecting all three image reports', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/private-cloud-release.yml'), 'utf8')
  for (const component of ['runtime', 'ingress', 'dashboard']) {
    assert.match(workflow, new RegExp(`scan ${component} [^\n]+ \\|\\| failed=1`, 'u'))
  }
  assert.match(workflow, /exit "\$failed"/u)
  assert.match(workflow, /grype "\$image"[^\n]+\|\| return 1/u)
  assert.match(workflow, /trivy image [^\n]+\|\| return 1/u)
})

test('release workflow publishes archived metadata and verifies the signed 27-asset set', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8')
  assert.equal(workflow.match(/extract-release-metadata\.mjs release\/kala-release-metadata\.tar\.gz/g)?.length, 2)
  assert.match(workflow, /Verify exact signed 27-asset inventory[\s\S]*pnpm run verify:release-assets -- --require-signed/u)
  assert.match(workflow, /Verify exact signed 27-asset inventory[\s\S]*cosign verify-blob[\s\S]*certificate-oidc-issuer/u)
  assert.match(workflow, /subject-path:[\s\S]*release\/kala-release-metadata\.tar\.gz/u)
  assert.doesNotMatch(workflow, /notes-file release\/RELEASE_NOTES\.md/u)
  assert.doesNotMatch(workflow, /release\/sbom\.cdx\.json/u)
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

test('promotion verifier binds the closed current draft to all three accepted native hashes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'promotion-candidate-'))
  try {
    const candidate = join(temporary, 'candidate')
    const evidence = join(temporary, 'evidence')
    mkdirSync(candidate)
    mkdirSync(evidence)
    const tag = 'v1.2.3-rc.1'
    const revision = 'a'.repeat(40)
    const targets = [...requiredReleaseEvidence.portable.targets]
    const nativeAssets = ['kala-host', 'kala-executor', 'kala-dedicated-ingress', 'kala-dedicated-deploy-supervisor']
      .flatMap((name) => targets.map((target) => `${name}-${target}`))
    const assets = [
      ...nativeAssets,
      'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
      'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz', 'kala-release-metadata.tar.gz',
      'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
    ]
    for (const [index, name] of assets.entries()) writeFileSync(join(candidate, name), `asset-${index}\n`)
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ version: tag.slice(1), source: { revision }, nativeTargets: targets, assets }, null, 2) + '\n')
    writeFileSync(join(candidate, 'SHA256SUMS.sigstore.json'), '{}\n')
    const aggregate = join(temporary, 'rc-evidence.json')
    writeFileSync(aggregate, '{"ok":true}\n')
    writeChecksums(candidate, [...assets, 'manifest.json'])
    for (const target of targets) {
      const name = `kala-host-${target}`
      const checks = Object.fromEntries(requiredReleaseEvidence.portable.checks.map((check) => [check, true]))
      writeFileSync(join(evidence, `${target}.rc-evidence.json`), JSON.stringify({
        schemaVersion: 1, category: 'portable', tag, version: tag.slice(1), revision, target,
        artifact: { name, sha256: digest(readFileSync(join(candidate, name))) },
        ok: true, checks, generatedAt: '2026-01-01T00:00:00.000Z',
      }))
    }
    const args = [verifyPromotion, '--directory', candidate, '--evidence', evidence, '--aggregate', aggregate, '--tag', tag, '--revision', revision]
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0)

    writeFileSync(join(candidate, 'stale-debug.zip'), 'stale')
    let result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /inventory is not closed/u)
    unlinkSync(join(candidate, 'stale-debug.zip'))

    writeFileSync(join(candidate, assets[0]), 'replaced-after-acceptance\n')
    writeChecksums(candidate, [...assets, 'manifest.json'])
    result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /differs from its validated acceptance evidence/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

function writeChecksums(directory, names) {
  writeFileSync(join(directory, 'SHA256SUMS'), names.map((name) => `${digest(readFileSync(join(directory, name)))}  ${name}`).join('\n') + '\n')
}
