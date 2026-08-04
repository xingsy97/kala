#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const stepDefinitions = {
  recall: [],
  update: ['recall'],
  test: ['update'],
  policy: ['update'],
  package: ['test', 'policy'],
  verify: ['package'],
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) await main(process.argv[2])

async function main(stepId) {
  if (!(stepId in stepDefinitions)) fail('unknown step: ' + String(stepId))
  const state = await loadState()
  if (state.completed.includes(stepId)) fail('step already completed: ' + stepId)
  const missing = stepDefinitions[stepId].filter((required) => !state.completed.includes(required))
  if (missing.length) fail('blocked by prerequisites: ' + missing.join(','))
  await check(stepId)
  const completed = [...state.completed, stepId]
  await mkdir('evidence', { recursive: true })
  await writeFile('evidence/' + stepId + '.json', JSON.stringify({ schemaVersion: 1, stepId, status: 'completed', completedOrder: completed.length }, null, 2) + '\n')
  await writeFile('.execution-state.json', JSON.stringify({ schemaVersion: 1, completed }, null, 2) + '\n')
  process.stdout.write(stepId + ' completed\n')
}

async function check(stepId) {
  if (stepId === 'recall') {
    for (const path of ['memory/workspace-release/01-intake.md', 'memory/workspace-release/02-compaction-summary.md', 'memory/workspace-release/03-correction-and-forgetting.md']) await readFile(path, 'utf8')
  } else if (stepId === 'update') {
    const response = JSON.parse(await readFile('response.json', 'utf8'))
    if (response.schemaVersion !== 1 || !Array.isArray(response.memoryAnswers) || response.memoryAnswers.length === 0) fail('response memory answers are not ready')
  } else if (stepId === 'test') {
    const result = spawnSync(process.execPath, ['--test', 'tests/contracts.test.mjs'], { encoding: 'utf8' })
    if (result.status !== 0) fail(result.stderr || result.stdout || 'public tests failed')
  } else if (stepId === 'policy') {
    const result = spawnSync('git', ['diff', '--exit-code', 'HEAD', '--', 'memory', 'incident', 'scripts', 'tests', 'package.json'], { encoding: 'utf8' })
    if (result.status !== 0) fail('protected task inputs changed')
  } else if (stepId === 'package') {
    const response = JSON.parse(await readFile('response.json', 'utf8'))
    if (!response.plan || !Array.isArray(response.plan.nodes)) fail('plan is not packageable')
  } else if (stepId === 'verify') {
    const response = JSON.parse(await readFile('response.json', 'utf8'))
    if (response.plan?.replans?.length < 1) fail('path-drift replan is missing')
  }
}
async function loadState() { try { const value = JSON.parse(await readFile('.execution-state.json', 'utf8')); return { completed: Array.isArray(value.completed) ? value.completed : [] } } catch { return { completed: [] } } }
function fail(message) { process.stderr.write(message + '\n'); process.exit(2) }
