#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export async function waitForOriginBarrier({ hostUrl, sessionId, callId, timeoutMs = 120_000, pollMs = 250, fetchImpl = fetch }) {
  if (!sessionId || !callId) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${hostUrl}/runtime/sessions/${encodeURIComponent(sessionId)}/tool-result/${encodeURIComponent(callId)}`)
      if (response.ok && (await response.json()).persisted === true) return
    } catch {
      // Host replacement and transient network loss are expected while polling.
    }
    await sleep(pollMs)
  }
  throw new Error(`origin tool result barrier timed out for ${sessionId}:${callId}`)
}

export async function waitForRestartPhase({ hostUrl, attemptId, phase, timeoutMs, pollMs = 500, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${hostUrl}/runtime/restart/status`)
      if (response.ok) {
        const status = await response.json()
        const attempt = status.current?.attemptId === attemptId ? status.current : status.last?.attemptId === attemptId ? status.last : null
        if (attempt?.phase === phase) return { status, attempt }
        if (attempt?.phase === 'failed' || attempt?.phase === 'aborted') throw new Error(`restart ${attempt.phase}: ${attempt.error ?? 'unknown'}`)
      }
    } catch (error) {
      if (error instanceof Error && /^restart (failed|aborted):/u.test(error.message)) throw error
      // ECONNREFUSED is the normal process-replacement window; keep polling.
    }
    await sleep(pollMs)
  }
  throw new Error(`restart ${attemptId} did not reach ${phase}`)
}

export function activateGeneration({ currentLink, generationDir }) {
  const temp = `${currentLink}.next-${process.pid}`
  try { unlinkSync(temp) } catch {}
  symlinkSync(generationDir, temp)
  renameSync(temp, currentLink)
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function main() {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('usage: deploy-finalize.mjs <transaction.json>')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const persist = (patch) => writeFileSync(configPath, `${JSON.stringify(Object.assign(config, patch), null, 2)}\n`, { mode: 0o600 })
  try {
    await waitForOriginBarrier(config)
    if (config.bootstrap) activateGeneration({ currentLink: config.currentLink, generationDir: config.generationDir })
    const request = await fetch(`${config.hostUrl}/runtime/restart`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'checkpoint', reason: config.bootstrap ? 'manual' : 'deploy', timeoutMs: config.restartTimeoutMs }),
    })
    if (!request.ok) throw new Error(`restart request failed: ${request.status}`)
    const attempt = await request.json()
    persist({ phase: 'draining', attemptId: attempt.attemptId })
    if (!config.bootstrap) {
      await waitForRestartPhase({ ...config, attemptId: attempt.attemptId, phase: 'checkpoint_reached', timeoutMs: config.restartTimeoutMs })
      activateGeneration({ currentLink: config.currentLink, generationDir: config.generationDir })
      persist({ phase: 'activated' })
      const commit = await fetch(`${config.hostUrl}/runtime/restart/commit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: attempt.attemptId }),
      })
      if (!commit.ok) throw new Error(`restart activation commit failed: ${commit.status}`)
    }
    const completed = await waitForRestartPhase({ ...config, attemptId: attempt.attemptId, phase: 'completed', timeoutMs: config.statusTimeoutMs })
    const deployedHash = sha256(join(config.generationDir, 'bundle-dashboard-with-runtime.cjs'))
    if (deployedHash !== config.bundleHash) throw new Error(`generation hash mismatch: ${deployedHash}`)
    persist({ phase: 'completed', newPid: completed.status.pid, completedAt: new Date().toISOString() })
  } catch (error) {
    if (config.predecessor) {
      activateGeneration({ currentLink: config.currentLink, generationDir: config.predecessor })
      if (config.phase === 'activated' || config.phase === 'restarting') {
        const recovery = spawnSync('systemctl', ['restart', config.service], { stdio: 'inherit' })
        if (recovery.status !== 0) console.error(`rollback supervisor restart failed with ${recovery.status}`)
      }
    }
    persist({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    if (config.leasePath) rmSync(config.leasePath, { recursive: true, force: true })
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
