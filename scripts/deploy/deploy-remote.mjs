#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildDeployPlan, releaseFiles, RETIRED_RELEASE_ASSETS, rsyncUploadArgs, sh } from './deploy-plan.mjs'
import { createGenerationPlan, launchFinalizeScript, prepareGenerationScript, systemdDropInScript, transactionJson, verifyGenerationScript } from './generation-plan.mjs'
import { assertSafeDeploymentInvocation } from './self-host-guard.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const rawArgs = process.argv.slice(2)
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  process.stdout.write(`Kala transactional deployment

Usage:
  pnpm run deploy:remote -- --lxd <container> [options]
  pnpm run deploy:remote -- --ssh <target> --host-url <url> --remote-bin <dir> --service <unit> [options]

LXD example:
  pnpm run deploy:remote -- --lxd agent-runlab-host

Options:
  --lxd <container>          Deploy through the local LXD transport
  --ssh <target>             Deploy through SSH/rsync
  --host-url <url>           Host URL reachable from the deployment target
                             (LXD default: http://127.0.0.1:13000)
  --remote-bin <dir>         Target installation root
                             (LXD default: /home/ubuntu/.bin)
  --service <unit>           systemd Host service
                             (LXD default: agent-runlab-host)
  --skip-build               Reuse release assets, but still verify them
  --dry-run                  Print the selected target without side effects
  -h, --help                 Show this help without requiring a target

Safety:
  Both transports stage and verify an immutable generation, then hand
  activation to an external systemd finalizer. Do not replace this command
  with direct live-file overwrites or direct service restart.

  A Session hosted by the target may invoke this command through an external
  Executor that has the repository and target access. After "accepted" is
  returned, let the Tool call finish: polling from that same Tool call blocks
  its durable result and therefore blocks the self-deployment checkpoint.
`)
  process.exit(0)
}
const dryRun = rawArgs.includes('--dry-run')
const effectiveArgs = rawArgs.filter((arg) => arg !== '--dry-run')
const lxdContainer = optionValueLocal(effectiveArgs, '--lxd') ?? process.env.AK_DEPLOY_LXD
const supervisorInstalled = /^(?:1|true|yes|on)$/iu.test(process.env.AGENT_RUNLAB_DEPLOY_SUPERVISOR_INSTALLED ?? '')
assertSafeDeploymentInvocation({ env: process.env, supervisorInstalled })
if (lxdContainer) {
  const lxdPlan = {
    mode: 'lxd',
    container: lxdContainer,
    remoteBin: optionValueLocal(effectiveArgs, '--remote-bin') ?? process.env.AK_DEPLOY_REMOTE_BIN ?? '/home/ubuntu/.bin',
    service: optionValueLocal(effectiveArgs, '--service') ?? process.env.AK_DEPLOY_SERVICE ?? 'agent-runlab-host',
    skipBuild: effectiveArgs.includes('--skip-build'),
    retiredAssets: RETIRED_RELEASE_ASSETS,
  }
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...lxdPlan }, null, 2))
    console.log('dry run complete: no build, LXD transfer, install, restart, or cleanup was executed')
    process.exit(0)
  }
  deployLxd(lxdPlan)
  process.exit(0)
}
// Transactional deployment is always asynchronously finalized outside the Host
// cgroup. Keep legacy flags accepted, but they no longer alter safety semantics.
const cleanedArgs = effectiveArgs.filter((arg) => arg !== '--async' && arg !== '--no-wait')
const plan = buildDeployPlan({ args: cleanedArgs, env: process.env, root })

const {
  releaseDir,
  sshTarget,
  hostUrl,
  remoteBin,
  restartTimeoutMs,
  statusTimeoutMs,
  files,
  service,
  sudo,
} = plan

console.log(`deploy target: ${sshTarget}`)
console.log(`remote bin: ${remoteBin}`)
console.log(`host url: ${hostUrl}`)
if (!service) throw new Error('--service is required for transactional remote deployment')
if (dryRun) {
  console.log(`release files: ${files.join(', ')}`)
  console.log('dry run complete: no build, SSH command, upload, activation, restart, or rollback was executed')
  process.exit(0)
}
const remote = (command, options = {}) => run('ssh', [sshTarget, command], options)
assertPortableTarget(JSON.parse(remote(`curl -fsS --max-time 5 ${sh(`${hostUrl.replace(/\/$/u, '')}/runtime/capabilities`)}`, { capture: true }).stdout))
if (!effectiveArgs.includes('--skip-build')) stage('build release assets', () => run('node', ['scripts/release/build-release-assets.mjs', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab']))
stage('verify release assets', () => run('node', ['scripts/release/verify-release-assets.mjs']))
const sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8')
const bundleHash = sums.match(/^([a-f0-9]{64})\s+bundle-dashboard-with-runtime\.cjs$/m)?.[1]
if (!bundleHash) throw new Error('bundle hash is missing from SHA256SUMS')
const generation = createGenerationPlan({
  remoteBin, service, hostUrl, files, bundleHash, restartTimeoutMs, statusTimeoutMs,
  sessionId: process.env.AGENT_RUNLAB_SESSION_ID, callId: process.env.AGENT_RUNLAB_CALL_ID,
})
const txLocal = join('/tmp', `agent-runlab-deploy-${generation.deployId}.json`)
writeFileSync(txLocal, `${transactionJson(generation)}\n`, { mode: 0o600 })
let remoteHandedOff = false
try {
  stage('prepare immutable remote generation', () => remote(prepareGenerationScript(generation)))
  stage('transfer remote generation', () => {
    const args = rsyncUploadArgs({ releaseDir, files, sshTarget, uploadDir: generation.generationDir })
    run('rsync', args)
    run('scp', [join(root, 'scripts/deploy/deploy-finalize.mjs'), `${sshTarget}:${generation.workerPath}`])
    run('scp', [txLocal, `${sshTarget}:${generation.transactionPath}`])
  })
  stage('verify immutable remote generation', () => remote(verifyGenerationScript(generation)))
  stage('install generation supervisor contract', () => remote(`${sudo ? 'sudo -n ' : ''}bash -lc ${sh(systemdDropInScript(generation))}`))
  stage('handoff remote deployment finalization', () => remote(`${sudo ? 'sudo -n ' : ''}bash -lc ${sh(launchFinalizeScript(generation))}`))
  remoteHandedOff = true
  console.log(JSON.stringify({ accepted: true, deployId: generation.deployId, transaction: generation.transactionPath, bundleHash }, null, 2))
} finally {
  if (!remoteHandedOff) {
    try { remote(`rm -rf ${sh(`${generation.root}/deploy.active`)} ${sh(generation.generationDir)}`) } catch {}
  }
  rmSync(txLocal, { force: true })
}

function stage(label, action) {
  const startedAt = Date.now()
  console.log(`${label}...`)
  action()
  console.log(`${label}: completed in ${formatDuration(Date.now() - startedAt)}`)
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.status !== 0) {
    const stderr = options.capture ? `\n${result.stderr}` : ''
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${stderr}`)
  }
  return result
}

function deployLxd({ container, remoteBin, service, skipBuild }) {
  const releaseDir = join(root, 'release')
  const hostUrl = optionValueLocal(effectiveArgs, '--host-url') ?? process.env.AK_DEPLOY_HOST_URL ?? 'http://127.0.0.1:13000'
  const capabilities = run('lxc', ['exec', container, '--', 'curl', '-fsS', '--max-time', '5', `${hostUrl.replace(/\/$/u, '')}/runtime/capabilities`], { capture: true })
  assertPortableTarget(JSON.parse(capabilities.stdout))
  if (!skipBuild) stage('build release assets', () => run('node', ['scripts/release/build-release-assets.mjs', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab']))
  stage('verify release assets', () => run('node', ['scripts/release/verify-release-assets.mjs']))
  const sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8')
  const files = releaseFiles(releaseDir)
  const bundleHash = sums.match(/^([a-f0-9]{64})\s+bundle-dashboard-with-runtime\.cjs$/m)?.[1]
  if (!bundleHash) throw new Error('bundle hash is missing from SHA256SUMS')
  for (const file of files) if (!existsSync(join(releaseDir, file))) throw new Error(`missing release asset: ${file}`)
  const plan = createGenerationPlan({
    remoteBin, service, hostUrl, files, bundleHash,
    sessionId: process.env.AGENT_RUNLAB_SESSION_ID,
    callId: process.env.AGENT_RUNLAB_CALL_ID,
  })
  const txLocal = join('/tmp', `agent-runlab-deploy-${plan.deployId}.json`)
  writeFileSync(txLocal, `${transactionJson(plan)}\n`, { mode: 0o600 })
  let handedOff = false
  try {
    stage('prepare immutable LXD generation', () => lxcExec(container, prepareGenerationScript(plan)))
    stage('transfer LXD generation', () => {
      for (const file of files) run('lxc', ['file', 'push', join(releaseDir, file), `${container}${plan.generationDir}/${file}`])
      run('lxc', ['file', 'push', join(root, 'scripts/deploy/deploy-finalize.mjs'), `${container}${plan.workerPath}`])
      run('lxc', ['file', 'push', txLocal, `${container}${plan.transactionPath}`])
    })
    stage('verify immutable LXD generation', () => lxcExec(container, verifyGenerationScript(plan)))
    stage('install generation supervisor contract', () => lxcExec(container, systemdDropInScript(plan)))
    stage('handoff LXD deployment finalization', () => lxcExec(container, launchFinalizeScript(plan)))
    handedOff = true
    console.log(JSON.stringify({ accepted: true, deployId: plan.deployId, transaction: plan.transactionPath, bundleHash }, null, 2))
    console.log('deployment finalizer accepted the transaction; it will wait for this Tool result before checkpoint restart')
  } finally {
    if (!handedOff) {
      try { lxcExec(container, `rm -rf ${sh(`${plan.root}/deploy.active`)} ${sh(plan.generationDir)}`) } catch {}
    }
    rmSync(txLocal, { force: true })
  }
}

export function assertPortableTarget(capabilities) {
  if (capabilities?.deployment?.architecture === 'platform' || capabilities?.product === 'dedicated' || capabilities?.product === 'private-cloud') {
    throw new Error('LEGACY_DEPLOYMENT_FORBIDDEN: platform topology must be updated through deploy:dedicated and the Deploy Supervisor protocol')
  }
  if (capabilities?.deployment?.architecture !== 'portable' && capabilities?.product !== 'portable') {
    throw new Error('cannot verify target as a portable deployment; refusing legacy deploy:remote')
  }
}

function lxcExec(container, command) { run('lxc', ['exec', container, '--', 'bash', '-lc', command]) }
function optionValueLocal(args, name) { for (let i = 0; i < args.length; i++) { if (args[i] === name) return args[i + 1]; if (args[i]?.startsWith(`${name}=`)) return args[i].slice(name.length + 1) } return undefined }
