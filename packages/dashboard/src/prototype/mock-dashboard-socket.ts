import { createInitialState, type AgentState, type Message } from '@agent-kernel/kernel'
import {
  KERNEL_AGENT_RUNTIME_CAPABILITIES,
  type AttachedExecutor,
  type ChannelSubscriptionResult,
  type DashboardChannel,
  type EventAppendedEvent,
  type SessionReadyEvent,
  type SessionSummary,
} from '@agent-kernel/shared'

type Handler = (...args: unknown[]) => void

const now = Date.now()
const iso = (offsetMinutes: number): string => new Date(now + offsetMinutes * 60_000).toISOString()

type PrototypeSessionSummary = SessionSummary & { costUsd?: number | null }

type PrototypeClientPayload = {
  channels: DashboardChannel[]
  requestId: string
  generation: number
  sessionId: string
  operation: string
  targetId: string
  planId: string
  preferences: NonNullable<SessionSummary['preferences']>
  label: string
  workspaceId: string
  workspaceName: string
  value?: string
  values?: string[]
  customText?: string
  parentSessionId?: string
}

const sessions: PrototypeSessionSummary[] = [
  {
    sessionId: 'prototype-active',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-180),
    lastEventAt: iso(-1),
    eventCount: 48,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/workspace/product-studio',
    label: 'Long response · pinned prompt · production transcript geometry review',
    firstUserMessage: 'Review the production sidebar hierarchy, preserve the existing workbench, verify responsive behavior at three widths, keep hover actions stable, and provide enough implementation detail that the transcript can be scrolled while the original prompt remains available as a lightweight pinned context anchor.',
    status: 'thinking',
    costUsd: null,
    preferences: { rightPanelTab: 'files', toolCardMode: 'dots' },
  },
  {
    sessionId: 'prototype-attention',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-320),
    lastEventAt: iso(-8),
    eventCount: 5,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/workspace/product-studio',
    label: 'Approval workflow review',
    firstUserMessage: 'Apply the reviewed retry guard and update the focused tests.',
    status: 'awaiting_approval',
    costUsd: 0,
  },
  {
    sessionId: 'prototype-ask-user',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-1_440),
    lastEventAt: iso(-34),
    eventCount: 7,
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    currentCwd: '/workspace/product-studio',
    label: 'Ask user · two decisions',
    firstUserMessage: 'Prepare a safe rollout plan and ask me for the two decisions you need.',
    status: 'executing_tools',
    costUsd: 1.25,
  },
  {
    sessionId: 'prototype-subagents',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-2_880),
    lastEventAt: iso(-95),
    eventCount: 18,
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Sub-agent activity matrix',
    firstUserMessage: 'Run a realistic parallel review across implementation, tests, accessibility, and failure recovery.',
    status: 'executing_tools',
  },
  {
    sessionId: 'prototype-subagent-running',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-22),
    lastEventAt: iso(-4),
    eventCount: 2,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Explore · live responsive evidence',
    firstUserMessage: 'Inspect responsive behavior and collect focused evidence.',
    status: 'executing_tools',
  },
  {
    sessionId: 'prototype-subagent-completed',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-28),
    lastEventAt: iso(-9),
    eventCount: 9,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Task · retry policy verification',
    firstUserMessage: 'Review the retry policy and verify the focused tests.',
    status: 'done',
  },
  {
    sessionId: 'prototype-subagent-failed',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-26),
    lastEventAt: iso(-8),
    eventCount: 6,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Task · unavailable fixture probe',
    firstUserMessage: 'Run the retry integration fixture and report controlled failures.',
    status: 'error',
  },
  {
    sessionId: 'prototype-subagent-cancelled',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-24),
    lastEventAt: iso(-7),
    eventCount: 6,
    parentSessionId: 'prototype-subagents',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    currentCwd: '/workspace/research-lab',
    label: 'Research · optional retry comparison',
    firstUserMessage: 'Collect optional comparison evidence until the parent has enough.',
    status: 'done',
  },
  {
    sessionId: 'prototype-usage',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-10_080),
    lastEventAt: iso(-7_200),
    eventCount: 7,
    workspaceId: 'workspace-windows',
    workspaceName: 'Windows QA',
    currentCwd: '/workspace/research-lab',
    label: 'Usage · billion-token history',
    firstUserMessage: 'Inspect long-running usage statistics.',
    status: 'done',
    costUsd: 0,
  },
  {
    sessionId: 'prototype-chat',
    agentRuntime: 'kernel',
    executionMode: 'chat',
    createdAt: iso(-45),
    lastEventAt: iso(-12),
    eventCount: 2,
    label: 'Completed accessibility audit',
    firstUserMessage: 'Audit accessibility across the production Dashboard.',
    status: 'idle',
    costUsd: 12.34,
  },
]

const executors: AttachedExecutor[] = [
  {
    executorId: 'executor-studio',
    workspaceId: 'workspace-studio',
    workspaceName: 'Product Studio',
    tools: ['read', 'write', 'bash', 'agent'],
    defaultCwd: '/placeholder/product-studio',
    runtime: 'node',
    runtimeVersion: '22.0.0-placeholder',
    hostname: 'studio.placeholder.local',
    os: 'darwin',
    attachedAt: iso(-240),
    clientVersion: 'prototype',
  },
  {
    executorId: 'executor-labs',
    workspaceId: 'workspace-labs',
    workspaceName: 'Research Lab',
    tools: ['read', 'grep', 'agent'],
    defaultCwd: '/placeholder/research-lab',
    runtime: 'node',
    runtimeVersion: '22.0.0-placeholder',
    hostname: 'labs.placeholder.local',
    os: 'linux',
    attachedAt: iso(-180),
    clientVersion: 'prototype',
  },
  {
    executorId: 'executor-windows',
    workspaceId: 'workspace-windows',
    workspaceName: 'Windows QA',
    tools: ['read', 'write', 'bash', 'agent'],
    defaultCwd: 'C:\\placeholder\\windows-qa',
    runtime: 'node',
    runtimeVersion: '22.0.0-placeholder',
    hostname: 'windows-qa.placeholder.local',
    os: 'win32',
    attachedAt: iso(-300),
    clientVersion: 'prototype',
  },
]

const activeMessages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: [
    'Review the production sidebar hierarchy without replacing the existing workbench.',
    'Keep message hover actions stable, align Thinking with the assistant text column, and verify title/time behavior at wide, medium, and narrow widths.',
    'Use realistic production components and protocol events rather than a substitute UI.',
    'Provide enough implementation evidence and validation detail that this transcript becomes long enough to exercise the lightweight pinned prompt while scrolling.',
  ].join('\n') }] },
  {
    role: 'assistant',
    content: [{ type: 'thinking', text: '## Inspecting layout\n\nI will preserve the production workbench and inspect the current Explorer row geometry first.' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'thinking', text: '## Checking interaction geometry\n\nNext I will compare hover metadata, timestamp overlays, and action positions before changing CSS.' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'thinking', text: '## Planning validation\n\nI will add focused unit assertions and browser geometry checks for the final responsive behavior.' }],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I inspected the production layout and kept the workbench intact. The implementation below uses the real Explorer, ChatPanel, Composer, and responsive panel system.' },
      { type: 'tool_call', callId: 'read-explorer', name: 'read', input: { path: 'src/features/explorer/Explorer.tsx' }, intent: 'Inspect the production Explorer hierarchy and row geometry.' },
      { type: 'tool_call', callId: 'read-chat', name: 'read', input: { path: 'src/features/chat/ChatPanel.tsx' }, intent: 'Inspect metadata overlays and Thinking alignment.' },
      { type: 'tool_call', callId: 'run-focused-tests', name: 'bash', input: { command: 'pnpm vitest run Explorer ChatPanel RuntimeMetrics' }, intent: 'Validate focused production behavior.' },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'read-explorer', ok: true, content: 'Explorer hierarchy inspected. Session title, activity time, and hover actions share a container-query driven row.' },
      { type: 'tool_result', callId: 'read-chat', ok: true, content: 'Chat metadata and Thinking clusters inspected. Overlay geometry can avoid hidden layout slots.' },
      { type: 'tool_result', callId: 'run-focused-tests', ok: true, content: 'Focused production tests passed in the prototype fixture.' },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: [
      'The sidebar now follows a three-stage responsive rule. At wide widths, the long title is already capped and truncated while the last-activity value remains visible. At the threshold, the activity value disappears first and the title receives that space. At very narrow widths, the title continues truncating without allowing the hover action overlay to participate in grid sizing.',
      '',
      'Message timestamps use overlays instead of invisible flex children. User actions keep the same x-position before and after hover, while assistant completion timing remains a separate semantic control from the timestamp.',
      '',
      'The context usage indicator uses a static track and a clipped fill whose width equals the measured percentage. Only the fill receives the low-contrast active stripe animation, and reduced-motion removes that animation entirely.',
      '',
      'The remaining transcript is intentionally detailed so scrolling can demonstrate the real pinned prompt. No replacement UI is involved: this is the production App with a local mock transport.',
      '',
      'Validation covers metadata geometry, merged Thinking updates, pinned prompt visibility, three Explorer widths, compact statistics, storage inventory, approval, ask-user decisions, and sub-agent lifecycle states.',
    ].join('\n') }],
  },
]

const askResponses = new Map<string, string[]>()

function askUserPendingCalls(sessionId: string): AgentState['pendingCalls'] {
  const answered = askResponses.get(sessionId)?.length ?? 0
  const calls: AgentState['pendingCalls'] = [
    {
      callId: 'ask-rollout-window',
      name: 'ask_user_choice',
      input: {
        message: 'Which rollout window should the mock plan use?',
        choices: [
          {
            value: 'business-hours',
            label: 'Business hours',
            description: 'Ship while the product and operations teams are online, with immediate monitoring and a staffed rollback path.',
          },
          {
            value: 'maintenance-window',
            label: 'Maintenance window',
            description: 'Use the scheduled low-traffic window so the fictional migration has extra capacity for verification and recovery.',
          },
        ],
        defaultValue: 'business-hours',
      },
      status: 'dispatched',
    },
    {
      callId: 'ask-validation-scope',
      name: 'ask_user_choice',
      input: {
        message: 'Which validation scope should follow the rollout?',
        choices: [
          {
            value: 'focused',
            label: 'Focused component tests',
            description: 'Run the production choice-card and protocol tests first, keeping feedback fast while covering the changed behavior.',
          },
          {
            value: 'browser',
            label: 'Responsive browser matrix',
            description: 'Exercise desktop, narrow sub-agent, and mobile layouts to verify readable descriptions and overflow-safe controls.',
          },
          {
            value: 'prototype',
            label: 'Prototype build verification',
            description: 'Build the isolated prototype and verify its production-component wiring without touching the deployed Dashboard.',
          },
        ],
        multiple: true,
        defaultValues: ['focused', 'browser'],
      },
      status: 'dispatched',
    },
  ]
  return calls.slice(answered)
}

function subAgentMatrixMessages(): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Run a realistic parallel review across implementation, tests, accessibility, and failure recovery.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Starting a mixed lifecycle matrix with long intentions and nested production transcripts.' },
        { type: 'tool_call', callId: 'agent-running', name: 'agent', input: { agent_type: 'Explore', intention: 'Inspect responsive geometry across wide, threshold, and very narrow Explorer widths while collecting exact DOM measurements and nested tool evidence.' } },
        { type: 'tool_call', callId: 'agent-completed', name: 'agent', input: { agent_type: 'Task', intention: 'Run focused production tests and summarize the stable assertions.' } },
        { type: 'tool_call', callId: 'agent-failed', name: 'agent', input: { agent_type: 'Task', intention: 'Probe a deliberately unavailable fictional service and report the controlled failure.' } },
        { type: 'tool_call', callId: 'agent-cancelled', name: 'agent', input: { agent_type: 'Research', intention: 'Collect optional comparison notes until the parent cancels the nonessential work.' } },
        { type: 'tool_call', callId: 'agent-pending', name: 'agent', input: { agent_type: 'Explore', intention: 'Wait for capacity before beginning an additional accessibility pass.' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', callId: 'agent-completed', ok: true, content: '<sub_agent session_id="prototype-subagent-completed" agent_type="Task" intention="Run focused production tests and summarize the stable assertions." status="completed" turns="6" duration_ms="18400"><result>Focused Explorer, ChatPanel, and RuntimeMetrics checks passed.</result></sub_agent>' },
        { type: 'tool_result', callId: 'agent-failed', ok: false, content: '<sub_agent session_id="prototype-subagent-failed" agent_type="Task" intention="Probe a deliberately unavailable fictional service and report the controlled failure." status="failed" turns="3" duration_ms="7200"><error>Fictional service returned a controlled unavailable response.</error></sub_agent>' },
        { type: 'tool_result', callId: 'agent-cancelled', ok: false, content: '<sub_agent session_id="prototype-subagent-cancelled" agent_type="Research" intention="Collect optional comparison notes until the parent cancels the nonessential work." status="cancelled" turns="2" duration_ms="4100"><error>Cancelled by parent after sufficient evidence was collected.</error></sub_agent>' },
      ],
    },
  ]
}

function stateFor(sessionId: string): AgentState {
  const base = createInitialState({ sessionId })
  if (sessionId === 'prototype-subagent-running') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect responsive geometry and collect nested evidence.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'nested-read', name: 'read_file', input: { path: 'src/orders/retry-policy.ts' }, intent: 'Inspect the retry budget calculation before running focused checks.' },
            { type: 'tool_call', callId: 'nested-search', name: 'grep', input: { pattern: 'retry budget', path: 'src/orders' }, intent: 'Find every retry-budget branch that needs responsive evidence.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'nested-read', ok: true, content: 'Read retry-policy.ts: exponential backoff is capped at 4 attempts and records the remaining retry budget.' },
            { type: 'tool_result', callId: 'nested-search', ok: true, content: 'Found 3 retry budget references in retry-policy.ts and retry-policy.test.ts; no unrelated matches.' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'The source and matching tests are understood. Running the focused retry-policy test now.' },
            { type: 'tool_call', callId: 'nested-test', name: 'bash', input: { command: 'pnpm test retry-policy' }, intent: 'Run the focused retry-policy suite and capture the remaining failure evidence.' },
          ],
        },
      ],
      cursor: 5,
      status: 'executing_tools',
      pendingCalls: [{ callId: 'nested-test', name: 'bash', input: { command: 'pnpm test retry-policy' }, intent: 'Run the focused retry-policy suite and capture the remaining failure evidence.', status: 'dispatched' }],
    } as AgentState
  }
  if (sessionId === 'prototype-subagent-completed') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Review the retry policy, apply the bounded-attempt fix, and verify it.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'completed-read', name: 'read_file', input: { path: 'src/orders/retry-policy.ts' }, intent: 'Read the current retry policy before editing.' },
            { type: 'tool_call', callId: 'completed-grep', name: 'grep', input: { pattern: 'retry budget', path: 'src/orders' }, intent: 'Locate focused retry-budget tests and call sites.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'completed-read', ok: true, content: 'The policy allowed one extra attempt after the retry budget reached zero.' },
            { type: 'tool_result', callId: 'completed-grep', ok: true, content: 'Found the policy and 4 focused assertions in src/orders/retry-policy.test.ts.' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'completed-patch', name: 'apply_file_patch', input: { path: 'src/orders/retry-policy.ts', patch: 'Stop retrying when remainingBudget <= 0.' }, intent: 'Apply the bounded-attempt guard without changing backoff timing.' },
            { type: 'tool_call', callId: 'completed-test', name: 'bash', input: { command: 'pnpm test retry-policy' }, intent: 'Verify the retry policy and its edge cases.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'completed-patch', ok: true, content: 'Updated retry-policy.ts with a zero-budget terminal guard; 3 lines changed.' },
            { type: 'tool_result', callId: 'completed-test', ok: true, content: 'retry-policy: 12 tests passed, including zero budget and maximum-attempt coverage.' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Completed the bounded retry fix and verified all 12 focused tests.' }] },
      ],
      cursor: 9,
      status: 'done',
      pendingCalls: [],
    } as AgentState
  }
  if (sessionId === 'prototype-subagent-failed') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Run the retry integration fixture and report a controlled failure.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'failed-read', name: 'read_file', input: { path: 'src/orders/retry-policy.integration.test.ts' }, intent: 'Inspect the fictional integration fixture and expected endpoint.' },
            { type: 'tool_call', callId: 'failed-test', name: 'bash', input: { command: 'pnpm test retry-policy.integration' }, intent: 'Run the integration fixture and preserve the exact failure summary.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'failed-read', ok: true, content: 'Fixture expects the placeholder endpoint http://orders.invalid.test/retry to return 200.' },
            { type: 'tool_result', callId: 'failed-test', ok: false, content: 'FAILED: retry-policy.integration timed out after 5s because the fictional orders fixture was unavailable; no files were changed.' },
          ],
        },
      ],
      cursor: 5,
      status: 'error',
      pendingCalls: [],
    } as AgentState
  }
  if (sessionId === 'prototype-subagent-cancelled') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Collect optional retry-policy comparison evidence until the parent has enough.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: 'cancelled-read', name: 'read_file', input: { path: 'docs/retry-guidelines.md' }, intent: 'Read the documented retry constraints for comparison.' },
            { type: 'tool_call', callId: 'cancelled-grep', name: 'grep', input: { pattern: 'maximum attempts', path: 'docs' }, intent: 'Find the documented maximum-attempt guidance.' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', callId: 'cancelled-read', ok: true, content: 'Guidelines recommend bounded retries, jittered backoff, and explicit terminal errors.' },
            { type: 'tool_result', callId: 'cancelled-grep', ok: true, content: 'Found 2 relevant maximum-attempt references; both agree with the implemented four-attempt cap.' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'The useful comparison evidence is recorded. Remaining optional research was cancelled by the parent.' }] },
      ],
      cursor: 6,
      status: 'done',
      pendingCalls: [],
    } as AgentState
  }
  if (sessionId === 'prototype-active') {
    return { ...base, messages: activeMessages, cursor: 8, status: 'thinking', pendingCalls: [] } as AgentState
  }
  if (sessionId === 'prototype-attention') {
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Apply the reviewed retry guard and update the focused tests.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'The patch is ready and requires approval before the fictional file is changed.' }] },
      ],
      cursor: 2,
      status: 'awaiting_approval',
      pendingCalls: [{
        callId: 'approval-retry-guard',
        name: 'apply_file_patch',
        input: {
          path: 'src/payments/retry-policy.ts',
          intent: 'Apply the reviewed retry guard and update focused tests',
          patch: '*** Update File: src/payments/retry-policy.ts\n@@ retryPayment\n- return retry(request)\n+ if (attempt >= maxAttempts) return terminalFailure(request)\n+ return retry(request)',
        },
        status: 'awaiting_approval',
      }],
    } as AgentState
  }
  if (sessionId === 'prototype-ask-user') {
    const pendingCalls = askUserPendingCalls(sessionId)
    return {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Prepare a safe rollout plan and ask me for the two decisions you need.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'I need two decisions. The production AskUserChoiceCard will advance to the second question after the first response.' }] },
      ],
      cursor: 2 + (askResponses.get(sessionId)?.length ?? 0),
      status: pendingCalls.length > 0 ? 'executing_tools' : 'done',
      pendingCalls,
    } as AgentState
  }
  if (sessionId === 'prototype-subagents') {
    return {
      ...base,
      messages: subAgentMatrixMessages(),
      cursor: 7,
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'agent-running', name: 'agent', input: {}, status: 'dispatched' },
        { callId: 'agent-pending', name: 'agent', input: {}, status: 'pending_approval' },
      ],
    } as AgentState
  }
  return {
    ...base,
    messages: [
      { role: 'user', content: [{ type: 'text', text: sessions.find((session) => session.sessionId === sessionId)?.firstUserMessage ?? 'Placeholder request.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'This is clearly marked placeholder content rendered by the production ChatPanel.' }] },
    ],
    cursor: 2,
    status: 'done',
    pendingCalls: [],
  } as AgentState
}

function historyFor(sessionId: string): EventAppendedEvent[] {
  const messages = stateFor(sessionId).messages.filter((message) => message.role !== 'system')
  let seq = 0
  const entries: EventAppendedEvent[] = []
  for (const message of messages) {
    seq += 1
    if (message.role === 'user') {
      entries.push({ sessionId, seq, ts: iso(-12 + seq), event: { kind: 'user_message', content: message.content }, effects: [] })
    } else if (message.role === 'assistant') {
      entries.push({ sessionId, seq, ts: iso(-12 + seq), event: { kind: 'llm_response', message }, effects: [] })
    } else if (message.role === 'tool') {
      for (const content of message.content) {
        if (content.type !== 'tool_result') continue
        seq += 1
        entries.push({ sessionId, seq, ts: iso(-12 + seq), event: { kind: 'tool_result', callId: content.callId, ok: content.ok, content: content.content }, effects: [] })
      }
    }
  }
  return entries
}

function readyFor(sessionId: string): SessionReadyEvent {
  const summary = sessions.find((candidate) => candidate.sessionId === sessionId)
  const state = stateFor(sessionId)
  return {
    sessionId,
    agentRuntime: 'kernel',
    executionMode: 'chat',
    agentRuntimeCapabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
    cursor: state.cursor,
    state,
    config: { systemPrompt: 'Prototype placeholder system prompt.', tools: [] },
    contextSnapshot: {
      model: { ref: 'placeholder-model', id: 'placeholder-model', provider: 'mock' },
      contextWindow: { tokens: 1_000_000, source: 'model_registry' },
      usage: { inputTokens: sessionId === 'prototype-active' ? 350_000 : 12_345, totalTokens: sessionId === 'prototype-active' ? 350_000 : 12_345 },
      breakdown: { system: 2_400, transcript: sessionId === 'prototype-active' ? 341_000 : 8_000, tools: 5_000, memory: 1_000, attachments: 600, pendingUserInput: 0 },
      estimator: { total: { kind: 'heuristic', confidence: 'estimated' }, breakdown: { kind: 'heuristic', confidence: 'estimated' }, version: 'prototype-placeholder-v1' },
      updatedAt: Date.now(),
    },
    reason: 'load',
    ...(summary?.parentSessionId ? { parentSessionId: summary.parentSessionId, parentCursor: 7, parentCallId: 'agent-running', agentType: 'Explore' } : {}),
    ...(summary?.workspaceId ? { workspaceId: summary.workspaceId, workspaceName: summary.workspaceName } : {}),
    selectedModel: 'placeholder-model',
  }
}

class PrototypeDashboardSocket {
  connected = true
  active = true
  id = 'prototype-dashboard-socket'
  io = { on: () => this.io, off: () => this.io }
  private handlers = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler): this {
    const handlers = this.handlers.get(event) ?? new Set<Handler>()
    handlers.add(handler)
    this.handlers.set(event, handlers)
    return this
  }

  off(event: string, handler?: Handler): this {
    if (!handler) this.handlers.delete(event)
    else this.handlers.get(event)?.delete(handler)
    return this
  }

  connect(): this {
    this.connected = true
    queueMicrotask(() => this.serverEmit('connect'))
    return this
  }

  close(): this {
    this.connected = false
    return this
  }

  disconnect(): this {
    this.connected = false
    return this
  }

  timeout(): { emit: (event: string, ...args: unknown[]) => void; emitWithAck: (event: string, payload: unknown) => Promise<unknown> } {
    return {
      emit: (event, ...args) => {
        const callback = args.at(-1)
        if (event === 'client:connection_ping' && typeof callback === 'function') callback(null, Date.now())
        else if (event === 'client:executor_ping' && typeof callback === 'function') callback(null, { rttMs: 7 })
        else this.emit(event, ...args)
      },
      emitWithAck: (event, payload) => new Promise((resolve) => {
        this.emit(event, payload, resolve)
      }),
    }
  }

  emit(event: string, ...args: unknown[]): this {
    const payload = args[0] as PrototypeClientPayload
    const ack = typeof args.at(-1) === 'function' ? args.at(-1) as Handler : undefined

    if (event === 'client:subscribe_channels' || event === 'client:restore_subscriptions' || event === 'client:refresh_channels') {
      const channels = payload.channels as DashboardChannel[]
      const result: ChannelSubscriptionResult = {
        requestId: payload.requestId,
        generation: payload.generation,
        accepted: channels,
        rejected: [],
        cursors: Object.fromEntries(channels.map((channel) => [channel, channel.startsWith('session:') ? stateFor(channel.slice(8)).cursor : 0])),
      }
      ack?.(result)
      window.setTimeout(() => this.publishChannels(channels), 0)
      return this
    }
    if (event === 'client:unsubscribe_channels') {
      ack?.({ requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} })
      return this
    }
    if (event === 'client:list_executors') {
      queueMicrotask(() => this.serverEmit('server:executors', { executors }))
      return this
    }
    if (event === 'client:list_sessions') {
      queueMicrotask(() => this.serverEmit('server:sessions', { sessions }))
      return this
    }
    if (event === 'client:load_history') {
      const entries = historyFor(payload.sessionId)
      queueMicrotask(() => this.serverEmit('server:history', { sessionId: payload.sessionId, entries }))
      return this
    }
    if (event === 'client:get_session_storage') {
      const billionFixture = payload.sessionId === 'prototype-usage' || payload.sessionId === 'prototype-active'
      ack?.({
        ok: true,
        value: {
          session: { sessionId: payload.sessionId, directBytes: 128_000, treeBytes: 512_000, descendantCount: 1, categories: {}, treeCategories: {} },
          descendants: [{ sessionId: 'prototype-subagent-running', parentSessionId: payload.sessionId, directBytes: 384_000, treeBytes: 384_000, descendantCount: 0, categories: {}, treeCategories: {} }],
          tokenUsage: {
            direct: { currentContextTokens: 12_350, cumulativeInputTokens: 1_250_000, cumulativeOutputTokens: 12_345, cacheCreationTokens: 0, cacheReadTokens: billionFixture ? 2_400_000_000 : 0, sessionCount: 1 },
            tree: { currentContextTokens: 1_250_000, cumulativeInputTokens: billionFixture ? 2_400_000_000 : 2_400_000, cumulativeOutputTokens: 12_345_678, cacheCreationTokens: 0, cacheReadTokens: 0, sessionCount: 2 },
          },
          state: { measuredAt: iso(0) },
        },
      })
      return this
    }
    if (event === 'client:get_global_storage') {
      ack?.({
        ok: true,
        value: {
          totalBytes: 18_874_368,
          totalFiles: 248,
          categories: {
            jsonl: { bytes: 8_388_608, files: 72 },
            snapshot: { bytes: 3_145_728, files: 41 },
            summary: { bytes: 1_048_576, files: 19 },
            context: { bytes: 2_097_152, files: 28 },
            artifacts: { bytes: 3_670_016, files: 82 },
            'orphan-artifacts': { bytes: 524_288, files: 5 },
            corrupt: { bytes: 1_024, files: 1 },
          },
          largestSessionTrees: [
            { sessionId: 'prototype-subagents', sessionLabel: 'Sub-agent activity matrix', workspaceId: 'workspace-labs', workspaceName: 'Research Lab', directBytes: 2_097_152, treeBytes: 6_291_456, descendantCount: 5, categories: {}, treeCategories: {} },
            { sessionId: 'prototype-active', sessionLabel: 'Long response · pinned prompt · production transcript geometry review', workspaceId: 'workspace-studio', workspaceName: 'Product Studio', directBytes: 3_145_728, treeBytes: 3_670_016, descendantCount: 0, categories: {}, treeCategories: {} },
            { sessionId: 'prototype-usage', sessionLabel: 'Usage · billion-token history', workspaceId: 'workspace-windows', workspaceName: 'Windows QA', directBytes: 1_048_576, treeBytes: 1_572_864, descendantCount: 0, categories: {}, treeCategories: {} },
          ],
          orphanCandidates: [
            { id: 'mock-artifacts-unattached-001', category: 'orphan-artifacts', bytes: 524_288, files: 5 },
            { id: 'mock-corrupt-record-001', category: 'corrupt', bytes: 1_024, files: 1 },
          ],
          state: { measuredAt: iso(0), generation: 3, stale: false, scan: { status: 'idle' } },
        },
      })
      return this
    }
    if (event === 'client:prepare_storage_cleanup') {
      ack?.({
        ok: true,
        value: {
          planId: '00000000-0000-4000-8000-000000000000',
          operation: payload.operation,
          targetId: payload.targetId,
          sessionIds: [],
          estimatedBytes: 524_288,
          itemCount: 6,
          expiresAt: iso(5),
        },
      })
      return this
    }
    if (event === 'client:execute_storage_cleanup') {
      ack?.({ ok: true, value: { planId: payload.planId, operation: 'orphan-artifacts', targetId: 'mock-artifacts-unattached-001', logicalDeletion: true, bytesQuarantined: 524_288, completedAt: iso(0) } })
      return this
    }
    if (event === 'client:update_preferences') {
      const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId)
      if (session) session.preferences = { ...session.preferences, ...payload.preferences }
      ack?.({ ok: true })
      queueMicrotask(() => this.serverEmit('server:control_update', { kind: 'session_meta_changed', sessionId: payload.sessionId, preferences: payload.preferences }))
      return this
    }
    if (event === 'client:rename_session') {
      const session = sessions.find((candidate) => candidate.sessionId === payload.sessionId)
      if (session) session.label = payload.label
      ack?.({ ok: true, value: payload.label })
      queueMicrotask(() => this.serverEmit('server:control_update', { kind: 'session_meta_changed', sessionId: payload.sessionId, label: payload.label }))
      return this
    }
    if (event === 'client:rename_workspace') {
      for (const session of sessions) if (session.workspaceId === payload.workspaceId) session.workspaceName = payload.workspaceName
      const executor = executors.find((candidate) => candidate.workspaceId === payload.workspaceId)
      if (executor) executor.workspaceName = payload.workspaceName
      ack?.({ ok: true, value: payload.workspaceName })
      queueMicrotask(() => this.serverEmit('server:control_update', { kind: 'workspace_meta_changed', workspaceId: payload.workspaceId, workspaceName: payload.workspaceName }))
      return this
    }
    if (event === 'client:delete_session') {
      const index = sessions.findIndex((candidate) => candidate.sessionId === payload.sessionId)
      if (index >= 0) sessions.splice(index, 1)
      ack?.({ ok: true })
      queueMicrotask(() => this.serverEmit('server:session_deleted', { sessionId: payload.sessionId }))
      return this
    }
    if (event === 'client:ask_user_choice') {
      const responses = askResponses.get(payload.sessionId) ?? []
      responses.push(payload.value ?? payload.values?.join(',') ?? payload.customText ?? 'response')
      askResponses.set(payload.sessionId, responses)
      ack?.({ ok: true })
      queueMicrotask(() => this.serverEmit('state:changed', {
        sessionId: payload.sessionId,
        cursor: stateFor(payload.sessionId).cursor,
        state: stateFor(payload.sessionId),
      }))
      return this
    }
    if (event === 'sub_agent:list') {
      const parentSessionId = payload.parentSessionId ?? payload.sessionId
      ack?.({
        sessionId: parentSessionId,
        children: parentSessionId === 'prototype-subagents' ? [{
          parentSessionId,
          parentCallId: 'agent-running',
          childSessionId: 'prototype-subagent-running',
          agentType: 'Explore',
          status: 'running',
          startedAt: iso(-3),
        }] : [],
      })
      return this
    }
    if (event === 'agent_types:list') {
      ack?.({ agentTypes: [{ id: 'Explore', label: 'Explore', description: 'Placeholder explorer' }] })
      return this
    }
    if (event.startsWith('client:') && ack) ack({ ok: true })
    return this
  }

  private publishChannels(channels: readonly DashboardChannel[]): void {
    if (channels.includes('global')) {
      this.serverEmit('server:executors', { executors })
      this.serverEmit('server:sessions', { sessions })
      this.serverEmit('server:agent_runtimes', {
        runtimes: [{
          id: 'kernel',
          label: 'Kala Agent',
          description: 'Local placeholder runtime',
          available: true,
          status: 'ready',
          version: 'prototype',
          capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
          models: [{ id: 'placeholder-model', label: 'Placeholder Model', provider: 'mock' }],
        }],
      })
    }
    for (const channel of channels) {
      if (!channel.startsWith('session:')) continue
      const sessionId = channel.slice('session:'.length)
      if (!sessions.some((session) => session.sessionId === sessionId)) continue
      this.serverEmit('session:ready', readyFor(sessionId))
    }
  }

  private serverEmit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

export function createPrototypeDashboardSocket(): unknown {
  return new PrototypeDashboardSocket()
}
