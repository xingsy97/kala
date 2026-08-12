import { randomUUID } from 'node:crypto'

import { sh } from './deploy-plan.mjs'

export function createGenerationPlan({ remoteBin, service, hostUrl, files, bundleHash, sessionId, callId, restartTimeoutMs = 3_600_000, statusTimeoutMs = 3_720_000, deployId = randomUUID() }) {
  const root = `${remoteBin}/deploy`
  const releasesDir = `${root}/releases`
  const generationDir = `${releasesDir}/${deployId}`
  const currentLink = `${root}/current`
  const transactionsDir = `${root}/transactions`
  const transactionPath = `${transactionsDir}/${deployId}.json`
  const workerPath = `${root}/deploy-finalize.mjs`
  return {
    deployId, root, releasesDir, generationDir, currentLink, transactionsDir, transactionPath, workerPath,
    remoteBin, service, hostUrl, files, bundleHash, sessionId, callId, restartTimeoutMs, statusTimeoutMs,
  }
}

export function prepareGenerationScript(plan) {
  const names = plan.files.map(sh).join(' ')
  return [
    'set -euo pipefail',
    `ROOT=${sh(plan.root)}`,
    `RELEASES=${sh(plan.releasesDir)}`,
    `GEN=${sh(plan.generationDir)}`,
    `CURRENT=${sh(plan.currentLink)}`,
    `LEGACY=${sh(plan.remoteBin)}`,
    `TXDIR=${sh(plan.transactionsDir)}`,
    'mkdir -p "$ROOT"',
    'mkdir "$ROOT/deploy.active" 2>/dev/null || { echo "another deployment is active" >&2; exit 75; }',
    'mkdir -p "$RELEASES" "$GEN" "$TXDIR"',
    'if [ ! -L "$CURRENT" ]; then PREV="$RELEASES/bootstrap-$(date +%Y%m%d%H%M%S)"; mkdir -p "$PREV"; for f in ' + names + '; do [ ! -f "$LEGACY/$f" ] || cp -p "$LEGACY/$f" "$PREV/$f"; done; ln -s "$PREV" "$CURRENT.next"; mv -Tf "$CURRENT.next" "$CURRENT"; touch "$ROOT/bootstrap-required"; fi',
  ].join('\n')
}

export function verifyGenerationScript(plan) {
  return [
    'set -euo pipefail',
    `GEN=${sh(plan.generationDir)}`,
    'cd "$GEN"',
    'sha256sum -c SHA256SUMS --ignore-missing',
    `test "$(sha256sum bundle-dashboard-with-runtime.cjs | cut -d' ' -f1)" = ${sh(plan.bundleHash)}`,
    'chmod 755 bundle-dashboard-with-runtime.cjs agent-kernel-executor.cjs run.sh 2>/dev/null || true',
  ].join('\n')
}

export function systemdDropInScript(plan) {
  const dropIn = `/etc/systemd/system/${plan.service}.service.d/10-generation.conf`
  return [
    'set -euo pipefail',
    `mkdir -p ${sh(dropIn.slice(0, dropIn.lastIndexOf('/')))}`,
    `cat > ${sh(dropIn)} <<'EOF'`,
    '[Service]',
    'ExecStart=',
    `ExecStart=/usr/bin/node ${plan.currentLink}/bundle-dashboard-with-runtime.cjs --port 13000`,
    'EOF',
    'systemctl daemon-reload',
    `test "$(systemctl show -p Restart --value ${sh(plan.service)})" = always`,
    `test "$(systemctl show -p KillMode --value ${sh(plan.service)})" = control-group`,
  ].join('\n')
}

export function transactionJson(plan) {
  return JSON.stringify({
    deployId: plan.deployId,
    phase: 'staged',
    hostUrl: plan.hostUrl,
    service: plan.service,
    generationDir: plan.generationDir,
    currentLink: plan.currentLink,
    predecessor: null,
    bundleHash: plan.bundleHash,
    sessionId: plan.sessionId || undefined,
    callId: plan.callId || undefined,
    leasePath: `${plan.root}/deploy.active`,
    restartTimeoutMs: plan.restartTimeoutMs,
    statusTimeoutMs: plan.statusTimeoutMs,
  }, null, 2)
}

export function launchFinalizeScript(plan) {
  return [
    'set -euo pipefail',
    `TX=${sh(plan.transactionPath)}`,
    `CURRENT=${sh(plan.currentLink)}`,
    'PREV=$(readlink -f "$CURRENT")',
    `node -e ${sh("const fs=require('fs');const p=process.argv[1];const marker=process.argv[3];const x=JSON.parse(fs.readFileSync(p));x.predecessor=process.argv[2];x.bootstrap=fs.existsSync(marker);if(x.bootstrap)fs.rmSync(marker);fs.writeFileSync(p,JSON.stringify(x,null,2)+'\\n',{mode:0o600})")} "$TX" "$PREV" ${sh(`${plan.root}/bootstrap-required`)}`,
    `systemd-run --unit=${sh(`agent-runlab-deploy-${plan.deployId}`)} --collect --property=Type=exec /usr/bin/node ${sh(plan.workerPath)} "$TX"`,
  ].join('\n')
}
