#!/usr/bin/env node
import { ControlPlaneClient } from '@agent-kernel/eval-sdk'
import { EvaluationGrader } from '../src/grader-runner.js'

const grader = new EvaluationGrader({
  controlPlane: new ControlPlaneClient({ baseUrl: option('--url') ?? process.env.AGENT_EVAL_URL ?? 'http://127.0.0.1:13100' }),
  executorId: option('--executor-id') ?? process.env.AGENT_EVAL_GRADER_ID ?? 'grader-local',
  leaseMs: integer(option('--lease-ms') ?? process.env.AGENT_EVAL_GRADER_LEASE_MS ?? '30000'),
})
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort(new Error(signal)))
await grader.start(controller.signal)

function option(name: string): string | undefined { for (let index = 2; index < process.argv.length; index += 1) { if (process.argv[index] === name) return process.argv[index + 1]; if (process.argv[index]?.startsWith(name + '=')) return process.argv[index]!.slice(name.length + 1) } }
function integer(value: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('lease must be a positive integer'); return parsed }
