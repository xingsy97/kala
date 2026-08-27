#!/usr/bin/env node
import { randomUUID } from 'node:crypto'

import { io } from 'socket.io-client'

const origin = process.env.RUNLAB_URL ?? process.env.DASHBOARD_URL
if (!origin) throw new Error('set RUNLAB_URL or DASHBOARD_URL to the Agent RunLab origin')

const cases = [
  {
    runtime: 'kernel',
    tool: 'todowrite',
    input: {
      todos: [{
        content: 'Verify Kernel executor tool routing',
        status: 'completed',
        priority: 'low',
      }],
    },
  },
  {
    runtime: 'kernel',
    tool: 'todo_graph',
    input: {
      operations: [{
        op: 'replace',
        nodes: [{
          id: 'kernel-host-tool',
          content: 'Verify Kernel host tool routing',
          status: 'completed',
        }],
        edges: [],
      }],
    },
  },
  {
    runtime: 'copilot',
    tool: 'todowrite',
    input: {
      todos: [{
        content: 'Verify Copilot executor tool routing',
        status: 'completed',
        priority: 'low',
      }],
    },
  },
  {
    runtime: 'copilot',
    tool: 'todo_graph',
    input: {
      operations: [{
        op: 'replace',
        nodes: [{
          id: 'copilot-host-tool',
          content: 'Verify Copilot host tool routing',
          status: 'completed',
        }],
        edges: [],
      }],
    },
  },
]

const bootstrapSessionId = `runtime-tool-acceptance-${randomUUID()}`
const socket = io(`${origin.replace(/\/$/u, '')}/dashboard`, {
  transports: ['websocket'],
  auth: { role: 'dashboard', sessionId: bootstrapSessionId, clientVersion: '1' },
  reconnection: false,
})
const states = new Map()
const createdSessions = []

socket.on('state:changed', (payload) => {
  if (payload?.sessionId && payload.state) states.set(payload.sessionId, payload.state)
})

try {
  await once(socket, 'session:ready', 20_000)
  const runtimesPromise = once(socket, 'server:agent_runtimes', 10_000)
  socket.emit('client:list_sessions', {})
  const runtimes = await runtimesPromise
  for (const runtimeId of ['kernel', 'copilot']) {
    const runtime = runtimes.runtimes?.find((candidate) => candidate.id === runtimeId)
    if (!runtime?.available || runtime.status !== 'ready') {
      throw new Error(`${runtimeId} runtime is not ready: ${runtime?.reason ?? runtime?.status ?? 'missing'}`)
    }
  }

  const executors = await responseEvent(socket, 'client:list_executors', 'server:executors', {})
  const executor = executors.executors?.find((candidate) => candidate.workspaceId)
  if (!executor) throw new Error('no connected workspace Executor is available')

  for (const testCase of cases) {
    const sessionId = `runtime-tool-${testCase.runtime}-${testCase.tool}-${randomUUID()}`
    createdSessions.push(sessionId)
    assertAck(await ack(socket, 'client:create_session', {
      operationId: `operation-create-${randomUUID()}`,
      sessionId,
      agentRuntime: testCase.runtime,
      workspaceId: executor.workspaceId,
      workspaceName: executor.workspaceName,
      tools: [testCase.tool],
    }))
    assertAck(await ack(socket, 'client:set_approval_mode', { sessionId, mode: 'allow_all' }))
    const prompt = [
      `Call the ${testCase.tool} tool exactly once before answering.`,
      `Use exactly this JSON input: ${JSON.stringify(testCase.input)}.`,
      'Do not use any other tool. After the tool succeeds, reply with TOOL_OK.',
    ].join(' ')
    await admitUserMessage(sessionId, prompt)

    const state = await waitForState(sessionId, (candidate) => {
      if (candidate.status === 'error') {
        throw new Error(`${testCase.runtime}/${testCase.tool} entered error state: ${candidate.error ?? 'unknown error'}`)
      }
      return candidate.status === 'done' && findToolResult(candidate, testCase.tool)?.ok === true
    }, 120_000)
    assertSuccessfulToolCall(state, testCase.tool)

    const persistedPromise = onceMatching(
      socket,
      'session:ready',
      (payload) => payload?.sessionId === sessionId,
      15_000,
    )
    socket.emit('subscribe', { sessionId })
    const persisted = await persistedPromise
    assertSuccessfulToolCall(persisted.state, testCase.tool)
    const history = await responseEvent(
      socket,
      'client:load_history',
      'server:history',
      { sessionId },
    )
    if (testCase.runtime === 'copilot' && history.entries?.length !== 0) {
      throw new Error(`Copilot Session was contaminated by ${history.entries.length} Kernel events`)
    }
    if (testCase.runtime === 'kernel' && (history.entries?.length ?? 0) === 0) {
      throw new Error('Kernel Session did not persist Kernel events')
    }
    console.log(JSON.stringify({
      runtime: testCase.runtime,
      tool: testCase.tool,
      status: 'passed',
      cursor: persisted.cursor,
    }))
  }
} finally {
  for (const sessionId of createdSessions.reverse()) {
    await ack(socket, 'client:delete_session', {
      operationId: `operation-delete-${randomUUID()}`,
      sessionId,
    }).catch(() => undefined)
  }
  socket.close()
}

function assertSuccessfulToolCall(state, toolName) {
  const contents = state?.messages?.flatMap((message) => message.content ?? []) ?? []
  const call = contents.find((content) => content.type === 'tool_call' && content.name === toolName)
  if (!call) throw new Error(`${toolName} tool_call was not projected`)
  const result = contents.find((content) => (
    content.type === 'tool_result'
    && content.callId === call.callId
  ))
  if (!result) throw new Error(`${toolName} tool_result was not projected`)
  if (result.ok !== true) throw new Error(`${toolName} failed: ${result.content ?? 'unknown failure'}`)
}

function findToolResult(state, toolName) {
  const contents = state?.messages?.flatMap((message) => message.content ?? []) ?? []
  const call = contents.find((content) => content.type === 'tool_call' && content.name === toolName)
  if (!call) return undefined
  return contents.find((content) => content.type === 'tool_result' && content.callId === call.callId)
}

async function waitForState(sessionId, predicate, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = states.get(sessionId)
    if (state && predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${sessionId}`)
}

function responseEvent(client, request, response, payload) {
  const promise = once(client, response, 10_000)
  client.emit(request, payload)
  return promise
}

function ack(client, event, payload) {
  return client.timeout(15_000).emitWithAck(event, payload)
}

function assertAck(value) {
  if (!value?.ok) throw new Error(`Socket operation failed: ${value?.error ?? 'unknown error'}`)
}

async function admitUserMessage(sessionId, text) {
  const operationId = `operation-message-${randomUUID()}`
  const response = await fetch(`${origin.replace(/\/$/u, '')}/runtime/admission/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, operationId, text, mode: 'steer' }),
    signal: AbortSignal.timeout(15_000),
  })
  const accepted = await response.json()
  if (!response.ok || accepted.accepted !== true) {
    throw new Error(`message admission failed: ${accepted.error ?? response.status}`)
  }
  if (accepted.state === 'committed' || accepted.routeGeneration === 0) return

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const statusResponse = await fetch(
      `${origin.replace(/\/$/u, '')}/runtime/admission/messages/${encodeURIComponent(operationId)}`,
      { signal: AbortSignal.timeout(5_000) },
    )
    const status = await statusResponse.json()
    if (status.state === 'committed') return
    if (status.state === 'failed' || status.state === 'expired') {
      throw new Error(`message admission ${status.state}: ${status.lastError ?? 'unknown error'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`message admission did not commit: ${operationId}`)
}

function once(client, event, timeout) {
  return onceMatching(client, event, () => true, timeout)
}

function onceMatching(client, event, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, listener)
      reject(new Error(`${event} timed out`))
    }, timeout)
    const listener = (value) => {
      if (!predicate(value)) return
      clearTimeout(timer)
      client.off(event, listener)
      resolve(value)
    }
    client.on(event, listener)
    client.once('connect_error', reject)
  })
}
