#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const outputPath = resolve(root, 'formal/kernel/KernelContract.tla')
const kernelPath = resolve(root, 'packages/kernel/dist/index.js')
const check = process.argv.includes('--check')

let kernel
try {
  kernel = await import(pathToFileURL(kernelPath).href)
} catch {
  fail('Kernel build is missing; run pnpm --filter @agent-kernel/kernel build first')
}

const { agentStatuses, agentEventKinds, transitionContract } = kernel
if (!Array.isArray(agentStatuses) || !Array.isArray(agentEventKinds) || !transitionContract) {
  fail('compiled Kernel does not export the enumerable transition contract')
}

const rendered = renderContract(agentStatuses, agentEventKinds, transitionContract)
if (check) {
  let current
  try {
    current = readFileSync(outputPath, 'utf8')
  } catch {
    fail('formal/kernel/KernelContract.tla is missing')
  }
  if (current !== rendered) {
    fail('formal/kernel/KernelContract.tla is stale; regenerate it with node scripts/formal/generate-kernel-contract.mjs')
  }
  process.stdout.write('PASS Kernel TypeScript/TLA+ transition contract conformance\n')
} else {
  writeFileSync(outputPath, rendered)
  process.stdout.write('Generated formal/kernel/KernelContract.tla\n')
}

function renderContract(statuses, eventKinds, contract) {
  const lines = [
    '-------------------------- MODULE KernelContract --------------------------',
    '\\* Generated from packages/kernel/src/core.ts. Do not edit by hand.',
    '',
    ...setDefinition('Statuses', statuses),
    '',
    ...setDefinition('EventKinds', eventKinds),
    '',
    'LegalEvents(status) ==',
  ]

  statuses.forEach((status, statusIndex) => {
    const legal = eventKinds.filter((kind) => contract[status]?.[kind] === 'handled')
    lines.push(`  ${statusIndex === 0 ? 'CASE' : '  []'} status = ${quote(status)} -> {`)
    legal.forEach((kind, index) => {
      lines.push(`         ${quote(kind)}${index === legal.length - 1 ? '' : ','}`)
    })
    lines.push('       }')
  })

  lines.push('', '=============================================================================', '')
  return lines.join('\n')
}

function setDefinition(name, values) {
  return [
    `${name} == {`,
    ...values.map((value, index) => `  ${quote(value)}${index === values.length - 1 ? '' : ','}`),
    '}',
  ]
}

function quote(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_]+$/u.test(value)) fail(`invalid contract identifier: ${String(value)}`)
  return JSON.stringify(value)
}

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`)
  process.exit(1)
}
