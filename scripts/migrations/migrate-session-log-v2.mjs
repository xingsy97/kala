#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/migrations/migrate-session-log-v2.mjs <sessions-dir>')
  process.exit(2)
}

let migrated = 0
let skipped = 0
let totalBefore = 0
let totalAfter = 0

for (const file of await readdir(target)) {
  if (!file.endsWith('.jsonl')) continue
  const path = join(target, file)
  const before = (await stat(path)).size
  totalBefore += before
  const result = await migrateFile(path)
  if (result.migrated) {
    migrated += 1
    totalAfter += result.afterBytes
    console.log(`migrated ${file}: ${before} -> ${result.afterBytes} bytes`)
  } else {
    skipped += 1
    totalAfter += before
    console.log(`skipped ${file}: ${result.reason}`)
  }
}

console.log(JSON.stringify({ migrated, skipped, totalBefore, totalAfter }, null, 2))

async function migrateFile(path) {
  const tmp = `${path}.v2.tmp`
  const old = `${path}.v1.delete`
  const out = createWriteStream(tmp, { encoding: 'utf8' })
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let lineNo = 0
  let sawHeader = false
  let alreadyV2 = false
  try {
    for await (const line of rl) {
      lineNo += 1
      if (line.trim().length === 0) continue
      const entry = JSON.parse(line)
      if (!sawHeader) {
        sawHeader = true
        if (entry.kind !== 'header') throw new Error(`${path} missing header`)
        if (entry.formatVersion === 2) {
          alreadyV2 = true
          break
        }
        entry.formatVersion = 2
        out.write(`${JSON.stringify(entry)}\n`)
        continue
      }
      if (entry.kind === 'event') {
        await rewriteEvent(path, entry)
      }
      out.write(`${JSON.stringify(entry)}\n`)
    }
  } finally {
    out.end()
    await new Promise((resolve, reject) => {
      out.on('finish', resolve)
      out.on('error', reject)
    })
  }
  if (alreadyV2) {
    await rm(tmp, { force: true })
    return { migrated: false, reason: 'already v2' }
  }
  if (!sawHeader) {
    await rm(tmp, { force: true })
    throw new Error(`empty log: ${path}`)
  }
  await rename(path, old)
  await rename(tmp, path)
  await rm(old, { force: true })
  return { migrated: true, afterBytes: (await stat(path)).size, lineNo }
}

async function rewriteEvent(logPath, entry) {
  const fullEffects = Array.isArray(entry.effects) ? entry.effects : []
  if (fullEffects.some((effect) => effect?.kind === 'call_llm')) {
    entry.effectsArtifact = await writeArtifact(logPath, 'effects', entry.seq, fullEffects)
  }
  entry.effects = fullEffects.map(slimEffect)
  if (entry.llmTrace) {
    const trace = entry.llmTrace
    entry.llmTraceArtifact = await writeArtifact(logPath, 'llm-traces', entry.seq, trace)
    entry.llmTrace = summarizeLlmTrace(trace)
  }
}

function summarizeLlmTrace(trace) {
  return pickDefined({
    provider: trace.provider,
    model: trace.model,
    request: {
      url: trace.request?.url,
      headers: trace.request?.headers ?? {},
    },
    response: trace.response
      ? pickDefined({
          status: trace.response.status,
          streamEventTypes: trace.response.streamEventTypes,
          metrics: trace.response.metrics,
        })
      : undefined,
    gatewayRequestId: trace.gatewayRequestId,
    weightVersion: trace.weightVersion,
  })
}

function slimEffect(effect) {
  if (!effect || typeof effect !== 'object') return effect
  if (effect.kind === 'call_llm') return { kind: 'call_llm', messages: [], tools: [] }
  if (effect.kind === 'call_tool') {
    return pickDefined({ kind: 'call_tool', callId: effect.callId, name: effect.name, input: effect.input ?? {}, cwd: effect.cwd })
  }
  if (effect.kind === 'request_approval') {
    return { kind: 'request_approval', callId: effect.callId, name: effect.name, input: effect.input ?? {} }
  }
  return effect
}

function pickDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

async function writeArtifact(logPath, kind, seq, value) {
  const sessionSlug = basename(logPath, '.jsonl')
  const dir = join(dirname(logPath), 'artifacts', sessionSlug, kind)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${String(seq).padStart(8, '0')}.json`)
  const json = JSON.stringify(value)
  await writeFile(path, `${json}\n`, 'utf8')
  return {
    path: relative(dirname(logPath), path),
    bytes: Buffer.byteLength(json) + 1,
    sha256: createHash('sha256').update(json).update('\n').digest('hex'),
  }
}
