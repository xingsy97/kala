import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseEnhancementCli, runEnhancementCli } from '../ops-cli.js'
import type { LLMAdapter } from '../llm/adapter.js'
import { policyGatewayAdapter } from '../llm/policy-gateway.js'
import { loadTaskPoolFile } from './task-pool.js'
import { validateTokenCapture, writeTokenCaptureArtifact } from './token-capture.js'
import { buildTrajectory, validateSlimeSampleReadiness } from './trajectory-builder.js'
import { runRlRollout } from './rollout-runner.js'

describe('Agentic RL implementation gate primitives', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-rl-gate-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('validates curated task pools and rejects non-training records in training mode', async () => {
    const taskPath = join(dir, 'tasks.jsonl')
    await writeFile(taskPath, `${JSON.stringify(task({ taskId: 'task-ok' }))}\n`, 'utf8')

    const result = await loadTaskPoolFile(taskPath, { trainingMode: true, workspaceRoot: dir })

    expect(result.taskCount).toBe(1)
    expect(result.trainingAllowedCount).toBe(1)

    const blockedPath = join(dir, 'blocked.jsonl')
    await writeFile(blockedPath, `${JSON.stringify(task({ taskId: 'task-blocked', trainingAllowed: false }))}\n`, 'utf8')
    await expect(loadTaskPoolFile(blockedPath, { trainingMode: true })).rejects.toThrow('training mode rejects blocked tasks')
  })

  it('loads pretty-printed task pool JSON files', async () => {
    const taskPath = join(dir, 'pretty-task-pool.json')
    await writeFile(taskPath, JSON.stringify({ schemaVersion: 'agent.rl.task_pool.v1', createdAt: new Date().toISOString(), tasks: [task({ taskId: 'pretty-json-task' })] }, null, 2), 'utf8')

    const result = await loadTaskPoolFile(taskPath, { trainingMode: true, workspaceRoot: dir })

    expect(result.taskCount).toBe(1)
    expect(result.tasks[0]?.taskId).toBe('pretty-json-task')
  })

  it('rejects path traversal in task workspace refs', async () => {
    const taskPath = join(dir, 'tasks.jsonl')
    await writeFile(taskPath, `${JSON.stringify(task({ workdir: '../escape' }))}\n`, 'utf8')

    await expect(loadTaskPoolFile(taskPath, { workspaceRoot: dir })).rejects.toThrow('escapes workspace root')
  })

  it('validates token capture alignment and writes redacted artifacts', async () => {
    const result = await writeTokenCaptureArtifact({
      rootDir: dir,
      requireLogprobs: true,
      capture: captureFixture(),
    })

    expect(result.validation).toMatchObject({ status: 'ready', outputTokenCount: 4, trainableTokenCount: 4 })
    expect(result.artifact.kind).toBe('rl_token_capture')

    const bad = validateTokenCapture({ ...result.capture, responseMask: [1] }, { requireLogprobs: true })
    expect(bad.status).toBe('blocked')
    expect(bad.blockedReason).toContain('responseMask length')
  })

  it('builds trajectory and validates slime sample readiness from token capture plus reward', async () => {
    const capture = await writeTokenCaptureArtifact({ rootDir: dir, capture: captureFixture() })
    const rewardPath = join(dir, 'reward.json')
    await writeFile(rewardPath, `${JSON.stringify(rewardFixture(), null, 2)}\n`, 'utf8')

    const trajectory = await buildTrajectory({
      rootDir: dir,
      rolloutId: 'rollout-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      tokenCapturePaths: [join(dir, capture.artifact.uri)],
      rewardPath,
    })

    expect(trajectory.trajectory.readiness).toBe('reward-verified')
    expect(trajectory.trajectory.turns[0]).toMatchObject({ responseTokenCount: 4, role: 'assistant_policy_output' })

    const validation = await validateSlimeSampleReadiness({
      rootDir: dir,
      trajectoryPath: join(dir, trajectory.artifact.uri),
      rewardPath,
      requireLogprobs: true,
    })

    expect(validation.validation.status).toBe('ready')
    expect(validation.validation.readiness).toBe('slime-sample-ready')
    expect(validation.validation.checks).toMatchObject({ lossMaskAligned: true, logprobsAligned: true })
  })

  it('parses top-level rl CLI commands and writes fixture artifacts', async () => {
    const parsed = parseEnhancementCli([
      'rl',
      'write-token-capture-fixture',
      '--root-dir', dir,
      '--rollout-id', 'rollout-cli',
      '--session-id', 'session-cli',
      '--call-id', 'call-cli',
      '--require-logprobs',
    ])
    expect(parsed.kind).toBe('rl-write-token-capture-fixture')

    const oldLog = console.log
    const logs: string[] = []
    console.log = (value?: unknown) => { logs.push(String(value)) }
    try {
      await runEnhancementCli(parsed)
    } finally {
      console.log = oldLog
    }

    const output = JSON.parse(logs[0]!) as { artifact: { uri: string } }
    const artifact = JSON.parse(await readFile(join(dir, output.artifact.uri), 'utf8')) as { outputIds: number[] }
    expect(artifact.outputIds).toHaveLength(4)
  })

  it('runs a local rollout smoke through the host loop and reaches slime sample readiness', async () => {
    const result = await runRlRollout({
      rootDir: dir,
      task: task({ taskId: 'task-smoke' }),
      rolloutId: 'rollout-smoke',
      llm: captureWritingAdapter(dir, 'rollout-smoke'),
      requireLogprobs: true,
    })

    expect(result.result.status).toBe('completed')
    expect(result.result.readiness).toBe('slime-sample-ready')
    expect(result.result.tokenCaptureRefs).toHaveLength(1)
    expect(result.result.rewardRef).toBeTruthy()
    expect(result.result.trajectoryRef).toBeTruthy()
    expect(result.result.sampleValidationRef).toBeTruthy()
  })

  it('runs rollout through policy gateway against a fake SGLang HTTP endpoint', async () => {
    const fake = await startFakeSglang()
    try {
      const adapter = policyGatewayAdapter({
        baseUrl: fake.url,
        artifactRoot: dir,
        model: 'fake-sglang-policy',
        rolloutId: 'rollout-fake-sglang',
        sessionId: 'session-fake-sglang',
        routeKey: 'rollout-fake-sglang',
        weightVersion: 'actor-step-1',
        requireLogprobs: true,
      })

      const result = await runRlRollout({
        rootDir: dir,
        task: task({ taskId: 'task-fake-sglang' }),
        rolloutId: 'rollout-fake-sglang',
        sessionId: 'session-fake-sglang',
        llm: adapter,
        requireLogprobs: true,
      })

      expect(result.result.readiness).toBe('slime-sample-ready')
      expect(result.result.tokenCaptureRefs).toHaveLength(1)
      const capture = JSON.parse(await readFile(join(dir, result.result.tokenCaptureRefs[0]!.uri), 'utf8'))
      expect(capture).toMatchObject({
        model: 'fake-sglang-policy',
        promptIds: [101, 102, 103],
        outputIds: [201, 202],
        outputLogProbs: [-0.11, -0.22],
        routeKey: 'rollout-fake-sglang',
        weightVersion: 'actor-step-1',
      })
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]?.headers['x-smg-routing-key']).toBe('rollout-fake-sglang')
    } finally {
      await fake.close()
    }
  })

  it('blocks rollout readiness when no policy token capture is produced', async () => {
    const result = await runRlRollout({
      rootDir: dir,
      task: task({ taskId: 'task-blocked-capture' }),
      rolloutId: 'rollout-no-capture',
      llm: textAdapter(),
      requireLogprobs: true,
    })

    expect(result.result.status).toBe('blocked')
    expect(result.result.readiness).toBe('blocked')
    expect(result.result.blockedReason).toContain('no policy token capture')
  })

  it('runs rollout smoke from CLI and inspects the produced readiness artifact', async () => {
    const taskPath = join(dir, 'tasks.jsonl')
    await writeFile(taskPath, `${JSON.stringify(task({ taskId: 'task-cli-smoke' }))}\n`, 'utf8')
    const oldLog = console.log
    const logs: string[] = []
    console.log = (value?: unknown) => { logs.push(String(value)) }
    try {
      await runEnhancementCli(parseEnhancementCli([
        'rl', 'run-rollout-smoke',
        '--root-dir', dir,
        '--task-file', taskPath,
        '--rollout-id', 'rollout-cli-smoke',
        '--fixture-policy',
        '--require-logprobs',
      ]))
      const output = JSON.parse(logs.at(-1)!) as { artifact: { uri: string }; result: { readiness: string } }
      expect(output.result.readiness).toBe('slime-sample-ready')
      await runEnhancementCli(parseEnhancementCli([
        'rl', 'inspect-rollout',
        '--root-dir', dir,
        '--rollout', join(dir, output.artifact.uri),
      ]))
      const inspected = JSON.parse(logs.at(-1)!) as { readiness: string; tokenCaptureCount: number }
      expect(inspected).toMatchObject({ readiness: 'slime-sample-ready', tokenCaptureCount: 1 })
    } finally {
      console.log = oldLog
    }
  })
})

function task(input: { taskId?: string; trainingAllowed?: boolean; workdir?: string } = {}) {
  return {
    schemaVersion: 'agent.rl.task.v1',
    taskId: input.taskId ?? 'task-1',
    source: { kind: 'local-fixture' },
    prompt: 'Create hello.txt',
    workspace: { kind: 'empty-tempdir', workdir: input.workdir ?? 'work' },
    verifier: { kind: 'command', command: ['test', '-f', 'hello.txt'], timeoutMs: 1000 },
    governance: {
      trainingAllowed: input.trainingAllowed ?? true,
      redactionStatus: 'not_required',
      retentionClass: 'training_allowed',
    },
  }
}

function captureFixture() {
  return {
    rolloutId: 'rollout-1',
    sessionId: 'session-1',
    callId: 'call-1',
    provider: 'policy-gateway' as const,
    backend: 'sglang' as const,
    model: 'fake-policy',
    tokenizer: { nameOrPath: 'fake-policy', chatTemplate: 'fake-template' },
    promptIds: [1, 2, 3],
    outputIds: [4, 5, 6, 7],
    outputLogProbs: [-0.1, -0.2, -0.3, -0.4],
    responseMask: [1, 1, 1, 1] as const,
    usage: { promptTokens: 3, completionTokens: 4 },
  }
}

function rewardFixture() {
  return {
    schemaVersion: 'agent.reward.v1',
    rolloutId: 'rollout-1',
    taskId: 'task-1',
    verifierKind: 'command',
    reward: 1,
    label: 'resolved',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:01.000Z',
    durationMs: 1000,
  }
}

function captureWritingAdapter(rootDir: string, rolloutId: string): LLMAdapter {
  return {
    name: 'test-capture-writer',
    async call() {
      await writeTokenCaptureArtifact({ rootDir, requireLogprobs: true, capture: { ...captureFixture(), rolloutId, sessionId: 'rl-test-session', callId: 'call-live' } })
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 3, outputTokens: 4 },
      }
    },
  }
}

function textAdapter(): LLMAdapter {
  return {
    name: 'test-text-only',
    async call() {
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
    },
  }
}

async function startFakeSglang(): Promise<{ url: string; requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }>; close: () => Promise<void> }> {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        text: 'done',
        output_ids: [201, 202],
        meta_info: {
          finish_reason: { type: 'stop' },
          prompt_tokens: 3,
          completion_tokens: 2,
          input_token_logprobs: [[null, 101, null], [-0.01, 102, null], [-0.02, 103, null]],
          output_token_logprobs: [[-0.11, 201, null], [-0.22, 202, null]],
        },
      }))
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake SGLang server did not bind TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}
