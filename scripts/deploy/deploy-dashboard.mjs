#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2); if (args[0] === '--') args.shift()
if (!args.length || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`Agent RunLab independent Dashboard deployment\n\nUsage:\n  pnpm run deploy:dashboard -- stage [--local | --lxd <container> | --ssh <target>] [options]\n  pnpm run deploy:dashboard -- status <deployment-or-operation-id> [transport]\n  pnpm run deploy:dashboard -- wait <deployment-or-operation-id> [transport] [--timeout-ms <ms>]\n  pnpm run deploy:dashboard -- inspect [transport]\n  pnpm run deploy:dashboard -- rollback <release-id> [transport] [--release-digest <sha256>]\n\nStage options:\n  --release-dir <path>       Platform release directory; default: release\n  --release-id <id>          Immutable Dashboard release id\n  --operation-id <id>        Stable idempotency id\n  --deployment-id <id>       Stable deployment id\n  --skip-build               Reuse and verify existing release assets\n\nA Dashboard deployment never restarts Ingress, Runtime slots, Sessions, or Executors.\n`)
  process.exit(0)
}
const command = args[0]
const transport = createTransport(args)
const deployRoot = targetPath(option('--deploy-root') ?? '/var/lib/agent-runlab/deploy/dashboard')
if (command === 'stage') stage()
else if (command === 'status') status(identity(positional(0)))
else if (command === 'wait') await wait(identity(positional(0)))
else if (command === 'inspect') inspect()
else if (command === 'rollback') rollback(identity(positional(0)))
else throw new Error('unknown deploy:dashboard command: ' + command)

function stage() {
  const operationId = identity(option('--operation-id') ?? `operation-dashboard-${randomUUID()}`)
  const replay = findRequest(operationId) ?? findReceipt(operationId)
  if (replay) { printAccepted(replay, true); return }
  const releaseDir = resolve(option('--release-dir') ?? join(repositoryRoot, 'release'))
  if (!args.includes('--skip-build')) run(process.execPath, ['scripts/release/build-release-assets.mjs', '--no-native', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab'])
  const release = inspectRelease(releaseDir)
  const releaseId = identity(option('--release-id') ?? `dashboard-${release.manifest.assetDigest.slice(0, 20)}`)
  const deploymentId = identity(option('--deployment-id') ?? `deployment-dashboard-${randomUUID()}`)
  const state = readJson(join(deployRoot, 'route-state.json'))
  const staged = join(deployRoot, 'submissions', operationId)
  transport.stage(releaseDir, staged, [
    { source: 'agent-kernel-dashboard-dist.tar.gz', target: 'dashboard.tar.gz' },
    { source: 'dashboard-release.json', target: 'manifest.json' },
  ])
  const request = { schemaVersion: 1, action: 'deploy', operationId, deploymentId, requestedAt: new Date().toISOString(), expectedGeneration: state.generation, releaseId, releaseDigest: release.manifestSha256, manifestSha256: release.manifestSha256, archiveSha256: release.archiveSha256, stagedReleaseDir: staged }
  submit(request); printAccepted(request, false)
}
function rollback(releaseId) {
  const operationId = identity(option('--operation-id') ?? `operation-dashboard-rollback-${randomUUID()}`)
  const deploymentId = identity(option('--deployment-id') ?? `deployment-dashboard-rollback-${randomUUID()}`)
  const state = readJson(join(deployRoot, 'route-state.json'))
  const manifestBytes = transport.read(join(deployRoot, 'releases', releaseId, 'manifest.json'))
  const digest = sha(manifestBytes)
  const explicit = option('--release-digest'); if (explicit && explicit !== digest) throw new Error('rollback release digest mismatch')
  const request = { schemaVersion: 1, action: 'rollback', operationId, deploymentId, requestedAt: new Date().toISOString(), expectedGeneration: state.generation, releaseId, releaseDigest: digest, manifestSha256: digest }
  submit(request); printAccepted(request, false)
}
function status(value) { const receipt = findReceipt(value); if (!receipt) throw new Error('dashboard deployment receipt not found: ' + value); process.stdout.write(JSON.stringify(receipt, null, 2) + '\n') }
async function wait(value) {
  const deadline = Date.now() + positive(option('--timeout-ms'), 300_000); let revision = -1
  while (Date.now() < deadline) { const receipt = findReceipt(value); if (receipt) { if (receipt.receiptRevision !== revision) { process.stdout.write(JSON.stringify({ deploymentId: receipt.deploymentId, phase: receipt.phase, receiptRevision: receipt.receiptRevision, updatedAt: receipt.updatedAt }) + '\n'); revision = receipt.receiptRevision } if (['completed', 'failed'].includes(receipt.phase)) { process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); if (receipt.phase !== 'completed') process.exitCode = 1; return } } await new Promise((r) => setTimeout(r, positive(option('--poll-ms'), 500))) }
  throw new Error('dashboard deployment wait deadline exceeded')
}
function inspect() { const state = readJson(join(deployRoot, 'route-state.json')); const receipts = transport.list(join(deployRoot, 'receipts')).filter((x) => x.endsWith('.json')).map((x) => readJson(join(deployRoot, 'receipts', x))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); process.stdout.write(JSON.stringify({ topology: 'independent-dashboard', dashboard: state, deployment: receipts[0] ?? null }, null, 2) + '\n') }
function submit(request) { const path = join(deployRoot, 'requests', `${request.operationId}.json`); const created = transport.atomic(path, Buffer.from(JSON.stringify(request, null, 2) + '\n')); if (!created) { const current = findRequest(request.operationId); if (!current || JSON.stringify(intent(current)) !== JSON.stringify(intent(request))) throw new Error('operationId conflicts with an existing Dashboard request') } }
function intent(x) { return { action: x.action, operationId: x.operationId, deploymentId: x.deploymentId, expectedGeneration: x.expectedGeneration, releaseId: x.releaseId, releaseDigest: x.releaseDigest, manifestSha256: x.manifestSha256, archiveSha256: x.archiveSha256, stagedReleaseDir: x.stagedReleaseDir } }
function findRequest(value) { const names = transport.list(join(deployRoot, 'requests')).filter((x) => x === `${value}.json` || x.startsWith(`${value}.json.accepted`)); return names[0] ? readJson(join(deployRoot, 'requests', names[0])) : undefined }
function findReceipt(value) { const direct = join(deployRoot, 'receipts', `${value}.json`); if (transport.exists(direct)) return readJson(direct); for (const name of transport.list(join(deployRoot, 'receipts')).filter((x) => x.endsWith('.json'))) { const receipt = readJson(join(deployRoot, 'receipts', name)); if (receipt.operationId === value) return receipt } }
function printAccepted(x, replayed) { process.stdout.write(JSON.stringify({ accepted: true, replayed, operationId: x.operationId, deploymentId: x.deploymentId, releaseId: x.releaseId, releaseDigest: x.releaseDigest, expectedGeneration: x.expectedGeneration }, null, 2) + '\n') }
function inspectRelease(root) {
  const archive = join(root, 'agent-kernel-dashboard-dist.tar.gz'), manifestPath = join(root, 'dashboard-release.json')
  const manifestBytes = readFileSync(manifestPath), archiveBytes = readFileSync(archive), manifest = JSON.parse(String(manifestBytes))
  if (manifest.schemaVersion !== 1 || manifest.product !== 'agent-runlab-dashboard' || !Array.isArray(manifest.files) || !manifest.files.some((x) => x.path === 'index.html')) throw new Error('invalid Dashboard release manifest')
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }); if (listing.status !== 0) throw new Error('Dashboard archive is unreadable')
  const paths = listing.stdout.split('\n').filter((x) => x && x !== './' && !x.endsWith('/')).map((x) => x.replace(/^\.\//u, '')).sort()
  const expected = manifest.files.map((x) => x.path).sort(); if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error('Dashboard archive file set does not match manifest')
  return { manifest, manifestSha256: sha(manifestBytes), archiveSha256: sha(archiveBytes) }
}
function createTransport(values) { const lxd = option('--lxd'), ssh = option('--ssh'); if (lxd && ssh) throw new Error('choose one transport'); if (lxd) return shellTransport('lxd', lxd); if (ssh) return shellTransport('ssh', ssh); return localTransport() }
function localTransport() { return { read: (p) => readFileSync(p), exists: existsSync, list: (p) => existsSync(p) ? readdirSync(p) : [], atomic: atomicLocal, stage: (source, target, files) => stageLocal(source, target, files) } }
function shellTransport(kind, target) {
  if (!(kind === 'lxd' ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u : /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/u).test(target)) throw new Error('invalid transport target')
  const shell = (script, input) => { const command = kind === 'lxd' ? 'lxc' : 'ssh'; const commandArgs = kind === 'lxd' ? ['exec', target, '--', 'bash', '-lc', script] : [target, 'bash', '-lc', quote(script)]; const result = spawnSync(command, commandArgs, { input, encoding: input ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024 }); if (result.status !== 0) throw new Error(kind + ' command failed: ' + String(result.stderr)); return result.stdout }
  return { read: (p) => Buffer.from(shell('cat -- ' + quote(p))), exists: (p) => { try { shell('test -e ' + quote(p)); return true } catch { return false } }, list: (p) => { try { return String(shell('find ' + quote(p) + ' -mindepth 1 -maxdepth 1 -printf %f\\n')).trim().split('\n').filter(Boolean) } catch { return [] } }, atomic: (p, b) => String(shell(atomicScript(p), b)).trim() === 'created', stage: (source, destination, files) => { if (transportPath(shell, destination)) throw new Error('immutable Dashboard submission already exists'); const incoming = `${destination}.incoming-${randomBytes(10).toString('hex')}`; shell('mkdir -m 0700 -- ' + quote(incoming)); try { for (const file of files) { if (kind === 'lxd') run('lxc', ['file', 'push', join(source, file.source), `${target}${join(incoming, file.target)}`]); else run('scp', [join(source, file.source), `${target}:${join(incoming, file.target)}`]) } shell('find ' + quote(incoming) + ' -type f -exec chmod 0440 {} + && sync -f ' + quote(incoming) + ' && mv -Tn -- ' + quote(incoming) + ' ' + quote(destination)) } catch (e) { shell('rm -rf -- ' + quote(incoming)); throw e } } }
}
function stageLocal(source, target, files) { if (existsSync(target)) throw new Error('immutable Dashboard submission already exists'); const incoming = `${target}.incoming-${randomBytes(10).toString('hex')}`; mkdirSync(incoming, { recursive: false, mode: 0o700 }); try { for (const file of files) { const bytes = readFileSync(join(source, file.source)); const fd = openSync(join(incoming, file.target), 'wx', 0o440); try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) } } const directory = openSync(incoming, 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } renameSync(incoming, target) } finally { rmSync(incoming, { recursive: true, force: true }) } }
function atomicLocal(path, bytes) { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp-${randomBytes(8).toString('hex')}`; const file = openSync(temp, 'wx', 0o640); try { writeFileSync(file, bytes); fsyncSync(file) } finally { closeSync(file) } try { linkSync(temp, path) } catch (error) { if (error.code === 'EEXIST') return false; throw error } finally { unlinkSync(temp) } const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } return true }
function atomicScript(path) { return `set -e; p=${quote(path)}; d=$(dirname -- \"$p\"); mkdir -p -- \"$d\"; t=\"$p.tmp-${randomBytes(8).toString('hex')}\"; trap 'rm -f -- \"$t\"' EXIT; cat > \"$t\"; chmod 0640 \"$t\"; sync -f \"$t\"; if ln \"$t\" \"$p\" 2>/dev/null; then rm -f \"$t\"; sync -f \"$d\"; echo created; else echo exists; fi` }
function transportPath(shell, path) { try { shell('test -e ' + quote(path)); return true } catch { return false } }
function readJson(path) { return JSON.parse(String(transport.read(path))) }
function positional(index) { const values = []; for (let i = 1; i < args.length; i++) { if (args[i].startsWith('--')) { if (takesValue(args[i])) i++; continue } values.push(args[i]) } return values[index] }
function option(name) { for (let i = 0; i < args.length; i++) { if (args[i] === name) return args[i + 1]; if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1) } }
function takesValue(value) { return ['--lxd', '--ssh', '--deploy-root', '--release-dir', '--release-id', '--release-digest', '--operation-id', '--deployment-id', '--timeout-ms', '--poll-ms'].some((x) => value === x || value.startsWith(x + '=')) }
function identity(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error('invalid identity'); return value }
function targetPath(value) { const path = resolve(value); if (['/', '/var', '/var/lib'].includes(path)) throw new Error('unsafe deploy root'); return path }
function positive(value, fallback) { const n = Number(value ?? fallback); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('expected positive integer'); return n }
function sha(value) { return createHash('sha256').update(value).digest('hex') }
function quote(value) { return `'${String(value).replaceAll(`'`, `'\''`)}'` }
function run(command, commandArgs) { const result = spawnSync(command, commandArgs, { cwd: repositoryRoot, stdio: 'inherit' }); if (result.status !== 0) throw new Error(command + ' failed') }
