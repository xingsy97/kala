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

const now = Date.parse('2026-10-02T08:00:00.000Z')
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
  path?: string
  query?: string
  limit?: number
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
    label: 'Refine the dashboard layout',
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
    label: 'Update retry guard tests',
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
    label: 'Plan a safe retry rollout',
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
    label: 'Review responsive behavior',
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
    label: 'Inspect responsive layouts',
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
    label: 'Verify the retry policy',
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
    label: 'Test retry integration',
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
    label: 'Compare retry guidance',
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
    label: 'Inspect usage history',
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
    label: 'Audit dashboard accessibility',
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
      { type: 'tool_call', callId: 'overview-graph', name: 'todo_graph', input: { operations: [{ operation: 'replace', nodes: ['baseline', 'protocol', 'dashboard', 'docs', 'unit', 'integration', 'responsive', 'accessibility', 'operations', 'browser', 'supply', 'release'] }] }, intent: 'Plan the implementation and validation work as a dependency graph.' },
      { type: 'tool_call', callId: 'run-focused-tests', name: 'bash', input: { command: 'pnpm vitest run Explorer ChatPanel RuntimeMetrics' }, intent: 'Validate focused production behavior.' },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'read-explorer', ok: true, content: 'Explorer hierarchy inspected. Session title, activity time, and hover actions share a container-query driven row.' },
      { type: 'tool_result', callId: 'read-chat', ok: true, content: 'Chat metadata and Thinking clusters inspected. Overlay geometry can avoid hidden layout slots.' },
      { type: 'tool_result', callId: 'overview-graph', ok: true, content: JSON.stringify({
        version: 1,
        revision: 7,
        nodes: [
          { id: 'baseline', content: 'Map product constraints', status: 'completed', priority: 'high' },
          { id: 'protocol', content: 'Refine runtime contract', status: 'in_progress', priority: 'high' },
          { id: 'dashboard', content: 'Build responsive workspace', status: 'in_progress', priority: 'high' },
          { id: 'docs', content: 'Document operator workflow', status: 'in_progress', priority: 'medium' },
          { id: 'unit', content: 'Verify state invariants', status: 'pending', priority: 'high' },
          { id: 'integration', content: 'Exercise runtime recovery', status: 'pending', priority: 'high' },
          { id: 'responsive', content: 'Run viewport matrix', status: 'pending', priority: 'high' },
          { id: 'accessibility', content: 'Audit keyboard and screen reader UX', status: 'pending', priority: 'medium' },
          { id: 'operations', content: 'Review deployment runbook', status: 'pending', priority: 'medium' },
          { id: 'browser', content: 'Complete browser acceptance', status: 'pending', priority: 'high' },
          { id: 'supply', content: 'Verify release evidence', status: 'pending', priority: 'high' },
          { id: 'release', content: 'Approve production release', status: 'pending', priority: 'high' },
        ],
        edges: [
          { from: 'baseline', to: 'protocol' },
          { from: 'baseline', to: 'dashboard' },
          { from: 'baseline', to: 'docs' },
          { from: 'protocol', to: 'unit' },
          { from: 'protocol', to: 'integration' },
          { from: 'dashboard', to: 'responsive' },
          { from: 'dashboard', to: 'accessibility' },
          { from: 'docs', to: 'operations' },
          { from: 'integration', to: 'browser' },
          { from: 'responsive', to: 'browser' },
          { from: 'accessibility', to: 'browser' },
          { from: 'unit', to: 'supply' },
          { from: 'operations', to: 'supply' },
          { from: 'browser', to: 'release' },
          { from: 'supply', to: 'release' },
        ],
        summary: { total: 12, completed: 1, active: 3, ready: 0, blocked: 8, cancelled: 0 },
        ready: [],
        blocked: [
          { id: 'unit', waitingOn: ['protocol'] },
          { id: 'integration', waitingOn: ['protocol'] },
          { id: 'responsive', waitingOn: ['dashboard'] },
          { id: 'accessibility', waitingOn: ['dashboard'] },
          { id: 'operations', waitingOn: ['docs'] },
          { id: 'browser', waitingOn: ['integration', 'responsive', 'accessibility'] },
          { id: 'supply', waitingOn: ['unit', 'operations'] },
          { id: 'release', waitingOn: ['browser', 'supply'] },
        ],
        changed: ['protocol', 'dashboard', 'docs'],
      }) },
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
  {
    role: 'user',
    content: [{ type: 'text', text: 'Keep the final verification focused on the production workbench and preserve the existing interaction hierarchy.' }],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'The focused checks are green. I am delegating one independent review before closing the plan.' },
      { type: 'tool_call', callId: 'overview-agent', name: 'agent', input: { agent_type: 'Explore', intention: 'Review the responsive implementation independently and summarize the strongest evidence.' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'overview-agent', ok: true, content: '<sub_agent session_id="prototype-subagent-completed" agent_type="Explore" intention="Review the responsive implementation independently and summarize the strongest evidence." status="completed" turns="4" duration_ms="12600"><result>Responsive hierarchy, tool activity, and pinned prompt behavior are consistent across the focused viewport matrix.</result></sub_agent>' },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'The independent review confirms the layout contract. I am checking the browser matrix and release evidence before closing the graph.' },
      { type: 'tool_call', callId: 'review-layout-source', name: 'read', input: { path: 'src/features/chat/ChatPanel.tsx' }, intent: 'Confirm the final production transcript and tool-dot layout source.' },
      { type: 'tool_call', callId: 'review-layout-search', name: 'grep', input: { pattern: 'overflow|container', path: 'src/features' }, intent: 'Check the responsive layout guards across the changed feature surfaces.' },
      { type: 'tool_call', callId: 'review-browser-matrix', name: 'bash', input: { command: 'pnpm test:browser -- responsive' }, intent: 'Verify desktop, tablet, and mobile production geometry.' },
      { type: 'tool_call', callId: 'review-accessibility', name: 'bash', input: { command: 'pnpm test:accessibility -- dashboard' }, intent: 'Verify keyboard navigation, labels, focus order, and reduced-motion behavior.' },
      { type: 'tool_call', callId: 'review-production-build', name: 'bash', input: { command: 'pnpm --filter @agent-kernel/dashboard build' }, intent: 'Build the production Dashboard with the verified responsive components.' },
      { type: 'tool_call', callId: 'review-privacy-gate', name: 'bash', input: { command: 'pnpm privacy:check' }, intent: 'Verify that public product evidence contains only fictional fixture data.' },
      { type: 'tool_call', callId: 'review-release-evidence', name: 'read', input: { path: 'release/evidence/verification.json' }, intent: 'Confirm the release evidence records the focused checks.' },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool_result', callId: 'review-layout-source', ok: true, content: 'The production ChatPanel keeps tool summaries compact while preserving accessible detail on demand.' },
      { type: 'tool_result', callId: 'review-layout-search', ok: true, content: 'Responsive guards cover the transcript, Composer, Explorer, and right-panel boundaries.' },
      { type: 'tool_result', callId: 'review-browser-matrix', ok: true, content: 'Desktop, tablet, and mobile acceptance passed with no horizontal overflow.' },
      { type: 'tool_result', callId: 'review-accessibility', ok: true, content: 'Keyboard, labels, focus order, contrast, and reduced-motion checks passed.' },
      { type: 'tool_result', callId: 'review-production-build', ok: true, content: 'The production Dashboard build completed with the verified component graph.' },
      { type: 'tool_result', callId: 'review-privacy-gate', ok: true, content: 'Privacy verification found only fictional prototype identifiers and public product content.' },
      { type: 'tool_result', callId: 'review-release-evidence', ok: true, content: 'Verification receipt includes unit, browser, accessibility, and supply-chain evidence.' },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'The implementation, independent review, responsive matrix, and release evidence are complete. The final release gate is ready for the operator.' }],
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
        { type: 'text', text: 'I will map and verify the production surfaces first, then coordinate independent reviews while keeping every lifecycle visible.' },
        { type: 'tool_call', callId: 'agent-read-contract', name: 'read', input: { path: 'src/features/chat/SubAgentCard.tsx' }, intent: 'Inspect the production sub-agent lifecycle contract before delegation.' },
        { type: 'tool_call', callId: 'agent-search-statuses', name: 'grep', input: { pattern: 'running|completed|failed|cancelled|pending', path: 'src/features/chat' }, intent: 'Confirm every delegated lifecycle has a production rendering path.' },
        { type: 'tool_call', callId: 'agent-test-matrix', name: 'bash', input: { command: 'pnpm vitest run SubAgentCard' }, intent: 'Verify the focused lifecycle matrix before launching delegated work.' },
        { type: 'tool_call', callId: 'agent-check-layout', name: 'bash', input: { command: 'pnpm verify:subagent-scroll' }, intent: 'Verify nested activity remains usable at compact viewport widths.' },
        { type: 'tool_call', callId: 'agent-read-protocol', name: 'read', input: { path: 'docs/host/sub-agent-design.md' }, intent: 'Confirm parent-child lifecycle and cancellation semantics.' },
        { type: 'tool_call', callId: 'agent-build-dashboard', name: 'bash', input: { command: 'pnpm --filter @agent-kernel/dashboard build' }, intent: 'Build the production delegated-work surfaces.' },
        { type: 'tool_call', callId: 'agent-privacy-check', name: 'bash', input: { command: 'pnpm privacy:check' }, intent: 'Verify the lifecycle fixture contains no private data.' },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', callId: 'agent-read-contract', ok: true, content: 'The production card supports running, completed, failed, cancelled, idle, and pending delegated work.' },
        { type: 'tool_result', callId: 'agent-search-statuses', ok: true, content: 'Every lifecycle maps to a visible label, timing state, and inspectable nested transcript.' },
        { type: 'tool_result', callId: 'agent-test-matrix', ok: true, content: 'The focused sub-agent lifecycle matrix passed.' },
        { type: 'tool_result', callId: 'agent-check-layout', ok: true, content: 'Nested activity remained readable and scrollable across the compact viewport matrix.' },
        { type: 'tool_result', callId: 'agent-read-protocol', ok: true, content: 'Parent-child ownership, completion, failure, cancellation, and pending states are explicit.' },
        { type: 'tool_result', callId: 'agent-build-dashboard', ok: true, content: 'The production Dashboard build completed.' },
        { type: 'tool_result', callId: 'agent-privacy-check', ok: true, content: 'The fixture contains only fictional product data.' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'Keep every delegated lifecycle visible together so I can compare running, completed, failed, cancelled, and pending work.' }] },
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

function messageCursor(messages: readonly Message[]): number {
  return messages.reduce((cursor, message) => cursor + 1 + (message.role === 'tool'
    ? message.content.filter((content) => content.type === 'tool_result').length
    : 0), 0)
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
    return { ...base, messages: activeMessages, cursor: messageCursor(activeMessages), status: 'thinking', pendingCalls: [] } as AgentState
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
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Prepare the production rollout for the retry-policy change. Inspect the current runbook and tests, identify the safe window, and stop for decisions that require an operator.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will gather the rollout, recovery, and verification evidence before asking for decisions that belong to you.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Keep rollout timing and validation depth as explicit operator-owned choices.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'I will inspect the deployment contract and focused recovery tests before asking for operator-owned choices.' },
          { type: 'tool_call', callId: 'ask-read-runbook', name: 'read', input: { path: 'docs/operations/retry-policy-rollout.md' }, intent: 'Read the rollout and rollback contract.' },
          { type: 'tool_call', callId: 'ask-search-checkpoints', name: 'grep', input: { pattern: 'checkpoint|rollback|observation', path: 'docs/operations' }, intent: 'Locate every operator-owned rollout checkpoint.' },
          { type: 'tool_call', callId: 'ask-run-tests', name: 'bash', input: { command: 'pnpm test retry-policy recovery' }, intent: 'Verify retry behavior and recovery before choosing a window.' },
          { type: 'tool_call', callId: 'ask-build-dashboard', name: 'bash', input: { command: 'pnpm --filter @agent-kernel/dashboard build' }, intent: 'Build the production decision workflow before presenting choices.' },
          { type: 'tool_call', callId: 'ask-check-accessibility', name: 'bash', input: { command: 'pnpm test:accessibility -- ask-user' }, intent: 'Verify choice labels, descriptions, focus order, and keyboard submission.' },
          { type: 'tool_call', callId: 'ask-read-evidence', name: 'read', input: { path: 'release/evidence/verification.json' }, intent: 'Confirm the rollout evidence is bound to the reviewed revision.' },
          { type: 'tool_call', callId: 'ask-privacy-check', name: 'bash', input: { command: 'pnpm privacy:check' }, intent: 'Verify the operator decision fixture contains no private data.' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', callId: 'ask-read-runbook', ok: true, content: 'Runbook requires a staffed rollback window, two healthy checkpoints, and ten minutes of error-rate observation.' },
          { type: 'tool_result', callId: 'ask-search-checkpoints', ok: true, content: 'Found the readiness, cutover, observation, and rollback decision boundaries.' },
          { type: 'tool_result', callId: 'ask-run-tests', ok: true, content: 'retry-policy and recovery: 28 focused tests passed; rollback fixture restored the previous route generation.' },
          { type: 'tool_result', callId: 'ask-build-dashboard', ok: true, content: 'The production Dashboard decision workflow built successfully.' },
          { type: 'tool_result', callId: 'ask-check-accessibility', ok: true, content: 'Choice descriptions, focus order, and keyboard submission checks passed.' },
          { type: 'tool_result', callId: 'ask-read-evidence', ok: true, content: 'Release evidence contains the focused recovery and browser receipts.' },
          { type: 'tool_result', callId: 'ask-privacy-check', ok: true, content: 'The fixture contains only fictional product data.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The implementation and rollback evidence are ready. I need the operator to choose the rollout window and validation depth before proceeding.' }] },
    ]
    return {
      ...base,
      messages,
      cursor: messageCursor(messages) + (askResponses.get(sessionId)?.length ?? 0),
      status: pendingCalls.length > 0 ? 'executing_tools' : 'done',
      pendingCalls,
    } as AgentState
  }
  if (sessionId === 'prototype-subagents') {
    const messages = subAgentMatrixMessages()
    return {
      ...base,
      messages,
      cursor: messageCursor(messages),
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
  const contextInputTokens = sessionId === 'prototype-subagents'
    ? 260_000
    : sessionId === 'prototype-active'
      ? 220_000
      : sessionId === 'prototype-ask-user'
        ? 180_000
        : 12_345
  return {
    sessionId,
    agentRuntime: 'kernel',
    executionMode: 'chat',
    agentRuntimeCapabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
    cursor: state.cursor,
    state,
    config: { systemPrompt: 'Prototype placeholder system prompt.', tools: [] },
    contextSnapshot: {
      model: { ref: 'openai:gpt-5.6', id: 'gpt-5.6', provider: 'openai' },
      contextWindow: { tokens: 1_000_000, source: 'model_registry' },
      usage: { inputTokens: contextInputTokens, totalTokens: contextInputTokens },
      breakdown: { system: 2_400, transcript: Math.max(8_000, contextInputTokens - 9_000), tools: 5_000, memory: 1_000, attachments: 600, pendingUserInput: 0 },
      estimator: { total: { kind: 'heuristic', confidence: 'estimated' }, breakdown: { kind: 'heuristic', confidence: 'estimated' }, version: 'prototype-placeholder-v1' },
      updatedAt: Date.now(),
    },
    reason: 'load',
    ...(summary?.parentSessionId ? { parentSessionId: summary.parentSessionId, parentCursor: 7, parentCallId: 'agent-running', agentType: 'Explore' } : {}),
    ...(summary?.workspaceId ? { workspaceId: summary.workspaceId, workspaceName: summary.workspaceName } : {}),
    selectedModel: 'openai:gpt-5.6',
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
    if (event === 'client:list_dirs') {
      const session = sessions.find((candidate) => candidate.workspaceId === payload.workspaceId)
      const root = session?.currentCwd ?? '/workspace'
      const path = payload.path ?? root
      const entries = path === root
        ? [
            { name: '.github', path: `${root}/.github`, type: 'directory' as const },
            { name: 'deploy', path: `${root}/deploy`, type: 'directory' as const },
            { name: 'docs', path: `${root}/docs`, type: 'directory' as const },
            { name: 'packages', path: `${root}/packages`, type: 'directory' as const },
            { name: 'scripts', path: `${root}/scripts`, type: 'directory' as const },
            { name: 'tests', path: `${root}/tests`, type: 'directory' as const },
            { name: 'package.json', path: `${root}/package.json`, type: 'file' as const, size: 4_812 },
            { name: 'pnpm-workspace.yaml', path: `${root}/pnpm-workspace.yaml`, type: 'file' as const, size: 1_284 },
            { name: 'README.md', path: `${root}/README.md`, type: 'file' as const, size: 12_640 },
          ]
        : path === `${root}/packages`
          ? [
              { name: 'dashboard', path: `${path}/dashboard`, type: 'directory' as const },
              { name: 'executor', path: `${path}/executor`, type: 'directory' as const },
              { name: 'host', path: `${path}/host`, type: 'directory' as const },
              { name: 'protocol', path: `${path}/protocol`, type: 'directory' as const },
            ]
        : [
            { name: 'src', path: `${path}/src`, type: 'directory' as const },
            { name: 'package.json', path: `${path}/package.json`, type: 'file' as const, size: 2_418 },
            { name: 'tsconfig.json', path: `${path}/tsconfig.json`, type: 'file' as const, size: 912 },
          ]
      const result = { requestId: payload.requestId, workspaceId: payload.workspaceId, path, roots: [root], entries }
      ack?.(result)
      queueMicrotask(() => this.serverEmit('server:dir_list', result))
      return this
    }
    if (event === 'client:list_files') {
      const session = sessions.find((candidate) => candidate.workspaceId === payload.workspaceId)
      const root = session?.currentCwd ?? '/workspace'
      queueMicrotask(() => this.serverEmit('server:file_list', {
        requestId: payload.requestId,
        workspaceId: payload.workspaceId,
        files: [
          { path: `${root}/packages/dashboard/src/app.tsx`, size: 128_406 },
          { path: `${root}/packages/dashboard/src/features/chat/Composer.tsx`, size: 54_812 },
          { path: `${root}/packages/host/src/runtime.ts`, size: 38_240 },
          { path: `${root}/packages/executor/src/executor.ts`, size: 24_116 },
          { path: `${root}/packages/protocol/src/events.ts`, size: 18_904 },
          { path: `${root}/docs/architecture/overview.md`, size: 22_731 },
          { path: `${root}/scripts/release/build-release-assets.mjs`, size: 16_508 },
          { path: `${root}/package.json`, size: 4_812 },
        ],
      }))
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
            { sessionId: 'prototype-subagents', sessionLabel: 'Review responsive behavior', workspaceId: 'workspace-labs', workspaceName: 'Research Lab', directBytes: 2_097_152, treeBytes: 6_291_456, descendantCount: 5, categories: {}, treeCategories: {} },
            { sessionId: 'prototype-active', sessionLabel: 'Refine the dashboard layout', workspaceId: 'workspace-studio', workspaceName: 'Product Studio', directBytes: 3_145_728, treeBytes: 3_670_016, descendantCount: 0, categories: {}, treeCategories: {} },
            { sessionId: 'prototype-usage', sessionLabel: 'Inspect usage history', workspaceId: 'workspace-windows', workspaceName: 'Windows QA', directBytes: 1_048_576, treeBytes: 1_572_864, descendantCount: 0, categories: {}, treeCategories: {} },
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
          models: [{
            ref: 'openai:gpt-5.6',
            id: 'gpt-5.6',
            label: 'GPT 5.6',
            provider: 'Anthropic',
            providerId: 'anthropic',
          }],
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
