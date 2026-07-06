#!/usr/bin/env node

import { spawn } from 'node:child_process'

const DEFAULT_INTERVAL_MS = 180_000
const DEFAULT_KILL_GRACE_MS = 5_000

const args = process.argv.slice(2)
let intervalMs = Number(process.env.AK_DEV_RESTART_MS ?? DEFAULT_INTERVAL_MS)
let killGraceMs = DEFAULT_KILL_GRACE_MS
const separator = args.indexOf('--')

for (let i = 0; i < (separator === -1 ? args.length : separator); i++) {
  const arg = args[i]
  if (arg === '--interval-ms') {
    intervalMs = Number(args[++i])
  } else if (arg === '--kill-grace-ms') {
    killGraceMs = Number(args[++i])
  }
}

if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
  throw new Error(`invalid --interval-ms: ${intervalMs}`)
}
if (!Number.isFinite(killGraceMs) || killGraceMs < 100) {
  throw new Error(`invalid --kill-grace-ms: ${killGraceMs}`)
}
if (separator === -1 || separator === args.length - 1) {
  throw new Error('usage: restart-every.mjs [--interval-ms N] -- <command> [args...]')
}

const command = args[separator + 1]
const commandArgs = args.slice(separator + 2).filter((arg) => arg !== '--')
let child = null
let restartTimer = null
let killTimer = null
let stopping = false
let restarting = false

function clearTimers() {
  if (restartTimer) clearTimeout(restartTimer)
  if (killTimer) clearTimeout(killTimer)
  restartTimer = null
  killTimer = null
}

function start() {
  clearTimers()
  restarting = false
  child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env: process.env,
  })
  console.error(`[dev-supervisor] started pid=${child.pid}; next restart in ${Math.round(intervalMs / 1000)}s`)
  restartTimer = setTimeout(() => {
    console.error('[dev-supervisor] scheduled restart')
    restart()
  }, intervalMs)
  child.on('exit', (code, signal) => {
    const wasRestarting = restarting
    child = null
    clearTimers()
    if (stopping) return
    const delay = wasRestarting ? 250 : 1_000
    console.error(`[dev-supervisor] child exited code=${code ?? 'null'} signal=${signal ?? 'null'}; restarting in ${delay}ms`)
    setTimeout(start, delay)
  })
}

function restart() {
  if (!child) {
    start()
    return
  }
  restarting = true
  child.kill('SIGTERM')
  killTimer = setTimeout(() => {
    if (child) child.kill('SIGKILL')
  }, killGraceMs)
}

function stop(signal) {
  stopping = true
  clearTimers()
  if (!child) process.exit(0)
  child.once('exit', () => process.exit(0))
  child.kill(signal)
  setTimeout(() => process.exit(0), killGraceMs).unref()
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

start()
