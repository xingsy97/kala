#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import ts from 'typescript'

const allowedAny = new Map([
  ['packages/eval-analyzer/src/grader-runner.ts', 1],
  ['packages/eval-analyzer/src/runner.ts', 1],
  ['packages/eval-orchestrator/bin/eval-cli.ts', 1],
  ['packages/dashboard/src/features/admin/AdminCenter.tsx', 1],
  ['packages/perf-harness/src/fixtures/local-stack.ts', 2],
])

const allowedDoubleAssertions = new Map([
  ['adapters/benchmarks/swe-bench/src/index.ts', 1],
  ['packages/dashboard/src/features/chat/ComposerFlipContainer.tsx', 2],
  ['packages/dashboard/src/features/explorer/Explorer.tsx', 1],
  ['packages/dashboard/src/lib/desktop-bridge.ts', 1],
  ['packages/dashboard/src/lib/desktop-notifications.ts', 1],
  ['packages/dashboard/src/lib/pwa.ts', 1],
  ['packages/dashboard/src/lib/viewTransition.ts', 1],
  ['packages/dashboard/src/socket-rpc.ts', 1],
  ['packages/dashboard/src/sw.ts', 1],
  ['packages/host/src/connection/executor.ts', 10],
  ['packages/host/src/rl/verifier-swebench.ts', 1],
  ['packages/host/src/server.ts', 2],
  ['packages/host/src/tenant-runtime/dedicated-admission-ledger.ts', 2],
  ['packages/host/src/tenant-runtime/dedicated-runtime-readiness.ts', 5],
  ['packages/perf-harness/bin/probe-fade.ts', 4],
  ['packages/perf-harness/src/probes/browser-session.ts', 1],
  ['packages/perf-harness/src/probes/dom-churn.ts', 4],
  ['packages/perf-harness/src/probes/frame-timing.ts', 2],
  ['packages/shared/src/schema/dashboard-inbound.ts', 2],
  ['packages/shared/src/schema/dashboard-outbound.ts', 2],
])

const listed = spawnSync(
  'git',
  ['ls-files', '-z', '--', 'packages/**/*.ts', 'packages/**/*.tsx', 'adapters/**/*.ts', 'adapters/**/*.tsx'],
  { encoding: 'utf8' },
)
if (listed.status !== 0) {
  process.stderr.write('FAIL unable to enumerate tracked TypeScript files\n')
  process.exit(1)
}

const failures = []
const scannedPaths = new Set()
const isTest = (path) =>
  /\.(?:test|spec)\.[cm]?tsx?$/u.test(path)
  || /(?:^|\/)(?:__tests__|test|tests)\//u.test(path)

for (const path of listed.stdout.split('\0').filter(Boolean)) {
  if (isTest(path)) continue
  scannedPaths.add(path)
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let anyCount = 0
  let doubleAssertionCount = 0
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount += 1
    if (
      ts.isAsExpression(node)
      && ts.isAsExpression(node.expression)
      && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      doubleAssertionCount += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (anyCount !== (allowedAny.get(path) ?? 0)) {
    failures.push(`${path} contains ${anyCount} explicit any types; allowed baseline is ${allowedAny.get(path) ?? 0}`)
  }
  if (doubleAssertionCount !== (allowedDoubleAssertions.get(path) ?? 0)) {
    failures.push(`${path} contains ${doubleAssertionCount} double assertions; allowed baseline is ${allowedDoubleAssertions.get(path) ?? 0}`)
  }
  if (/@ts-(?:ignore|nocheck|expect-error)\b/u.test(source)) {
    failures.push(`${path} contains a forbidden TypeScript suppression directive`)
  }
}

for (const path of new Set([...allowedAny.keys(), ...allowedDoubleAssertions.keys()])) {
  if (!scannedPaths.has(path)) failures.push(`${path} is allowlisted but is not a tracked production TypeScript file`)
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write('PASS TypeScript safety baseline\n')
