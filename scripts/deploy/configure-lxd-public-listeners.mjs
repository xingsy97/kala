#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const managedPrefix = 'kala-public-'

export function parsePublicListeners(raw) {
  const values = String(raw ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  if (values.length === 0) throw new Error('KALA_PUBLIC_LISTEN must contain at least one address')
  const listeners = values.map((value) => {
    const ipv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(value)
    const ipv4 = /^([^:]+):(\d+)$/u.exec(value)
    const host = ipv6?.[1] ?? ipv4?.[1]
    const port = Number(ipv6?.[2] ?? ipv4?.[2])
    if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || (!ipv6 && !validIpv4(host))) {
      throw new Error(`KALA_PUBLIC_LISTEN contains an invalid literal address: ${value}`)
    }
    if (ipv6) {
      try { new URL(`http://[${host}]`) } catch { throw new Error(`KALA_PUBLIC_LISTEN contains an invalid IPv6 address: ${value}`) }
    }
    return { host, port, endpoint: `tcp:${ipv6 ? `[${host}]` : host}:${port}` }
  })
  if (new Set(listeners.map((listener) => listener.endpoint)).size !== listeners.length) {
    throw new Error('KALA_PUBLIC_LISTEN must not contain duplicate addresses')
  }
  return listeners
}

export function planLxdPublicListeners(existingDevices, rawListeners, connect = 'tcp:127.0.0.1:13000') {
  const listeners = parsePublicListeners(rawListeners)
  const desired = new Map(listeners.map((listener) => {
    const digest = createHash('sha256').update(listener.endpoint).digest('hex').slice(0, 12)
    return [`${managedPrefix}${digest}`, { type: 'proxy', listen: listener.endpoint, connect }]
  }))
  const matchingExisting = new Set(Object.values(existingDevices)
    .filter((device) => device?.type === 'proxy' && typeof device.listen === 'string' && device.connect === connect)
    .map((device) => device.listen))
  const add = [...desired].filter(([, device]) => !matchingExisting.has(device.listen))
  const remove = Object.keys(existingDevices).filter((name) => name.startsWith(managedPrefix) && !desired.has(name))
  return { add, remove }
}

function main() {
  const container = option('--lxd')
  if (!container || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(container)) {
    throw new Error('--lxd requires a valid container name')
  }
  const rawListeners = process.env.KALA_PUBLIC_LISTEN
  const connect = option('--connect') ?? 'tcp:127.0.0.1:13000'
  if (!/^tcp:(?:\\[[^\]]+\]|[^:]+):[0-9]+$/u.test(connect)) throw new Error('--connect must be a tcp host:port endpoint')
  const existing = JSON.parse(run('lxc', ['query', `/1.0/instances/${encodeURIComponent(container)}`])).expanded_devices ?? {}
  const plan = planLxdPublicListeners(existing, rawListeners, connect)
  for (const [name, device] of plan.add) {
    run('lxc', ['config', 'device', 'add', container, name, 'proxy', `listen=${device.listen}`, `connect=${device.connect}`])
  }
  for (const name of plan.remove) run('lxc', ['config', 'device', 'remove', container, name])
  process.stdout.write(`${JSON.stringify({ ok: true, container, added: plan.add.map(([name]) => name), removed: plan.remove })}\n`)
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function validIpv4(value) {
  const octets = value.split('.')
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255)
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim()}`)
  return result.stdout
}

if (process.argv[1]?.endsWith('configure-lxd-public-listeners.mjs')) {
  try { main() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}
