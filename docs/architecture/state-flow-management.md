# State Flow Management

**Status**: accepted implementation plan
**Scope**: Kernel protocol state, Host asynchronous workflows, and Dashboard session projection

## 1. Objective

State transitions must be explicit, serializable where durability matters, and
testable without executing their side effects. The system uses one common shape
across layers without forcing every layer into one runtime library:

```text
event -> pure transition -> next state + declarative commands -> command runner -> result event
```

The Kernel remains a zero-runtime-dependency pure reducer. Host workflows use
small serialized actors around pure transitions. Dashboard socket events update
one atomic session projection reducer.

## 2. State Ownership

| Layer | Owns | Does not own |
|---|---|---|
| Kernel | Agent protocol state, legal events, deterministic effects | IO, timers, retries, sockets, provider details |
| Host | Async workflow lifecycle, command execution, persistence, stale-result rejection | UI projection state |
| Dashboard | Connection and session view projection, transient streaming presentation | Authoritative agent protocol state |

State is stored once per owner. Other layers receive facts or projections and
must not create a competing authoritative copy.

## 3. Kernel Design

### 3.1 Preserve the pure dispatch-table FSM

`step(state, event, config)` remains synchronous and deterministic. XState or
another actor runtime is not introduced into the Kernel. This preserves replay,
forking, portability, and the dependency rule in ADR 0001 and ADR 0010.

### 3.2 Make protocol phases discriminated

`AgentState` is represented as a union keyed by `status`. Phase-specific fields
become type-level constraints:

- `idle`, `thinking`, `done`: no pending calls and no error.
- `awaiting_approval`: at least one awaiting call; other calls may already be dispatched.
- `executing_tools`: dispatched calls only.
- `error`: no pending calls and a required error string.

Common transcript, usage, cursor, cwd, and approval mode fields remain shared.
Constructors and transition helpers produce valid variants instead of casting
flat objects at call sites. Runtime schemas retain boundary validation.

### 3.3 Report transition disposition

Every `StepResult` includes a diagnostic disposition:

```typescript
type TransitionDisposition =
  | { outcome: 'applied'; from: AgentStatus; to: AgentStatus; event: AgentEvent['kind'] }
  | { outcome: 'ignored'; from: AgentStatus; to: AgentStatus; event: AgentEvent['kind']; reason: 'event_not_legal_in_state' }
  | { outcome: 'rejected'; from: AgentStatus; to: AgentStatus; event: AgentEvent['kind']; reason: string }
```

Illegal state/event pairs retain the existing replay behavior: cursor advances,
all other state is unchanged, and no effects are emitted. The difference is
that the no-op is observable in tests, logs, and the debugger. Invalid payloads
handled by a legal transition are `rejected`, not silently treated as success.

### 3.4 Invariants

After every transition:

1. `next.cursor === previous.cursor + 1`.
2. Input state and event are not mutated.
3. Resting and thinking states have no pending calls.
4. `awaiting_approval` has an awaiting call.
5. `executing_tools` contains only dispatched calls.
6. `error` has a non-empty error; non-error states do not.
7. Every emitted `call_tool` or `request_approval` corresponds to one pending call.

## 4. Host Workflow Actors

### 4.1 Runtime shape

Host workflows use a small local actor abstraction:

```typescript
transition(state, event) -> { state, commands }
actor.send(event)
```

`send` serializes transitions through one mailbox. Commands execute outside the
transition. Their completion feeds a new event back into the mailbox. There is
no general-purpose actor dependency and no hidden global scheduler.

### 4.2 Attempt identity

Every long-running operation has an `attemptId`. Timer, Promise, socket, and
executor results carry that id. The reducer ignores results whose attempt id is
not current. This prevents an old timeout or completion from mutating a newer
operation.

### 4.3 Workflows

The first migrations cover workflows with meaningful async races:

| Workflow | State/event boundary | Commands |
|---|---|---|
| Host restart | request, checkpoint reached, timeout, spawn, fail, abort | begin/end drain, wait checkpoints, persist, close, spawn |
| Context compaction | request, preflight result, summary result, apply result, fail | estimate, summarize, dispatch replacement |
| Tool lifecycle | dispatch, approval, result, cancel, executor detach/reconnect | executor call/cancel, timeout, result dispatch |

Migration may retain existing public classes and protocol messages, but mutable
phase changes must pass through the workflow transition and stale async results
must be rejected by identity.

## 5. Dashboard Session Projection

### 5.1 Atomic projection state

Connection status, authoritative state snapshot, config, context snapshot,
timeline, compact status, queue, error, parent metadata, selected model,
hydration identity, and bound socket live in one `SessionViewState`. Socket
handlers dispatch typed projection actions. Related fields update in one reducer
transition.

Streaming text remains a separate high-frequency presentation channel backed by
the existing animation-frame buffer. It is reset through an explicit projection
action when authoritative events end streaming.

### 5.2 Authority rules

1. `session:ready` atomically establishes the baseline.
2. `event:appended` folds the pure Kernel transition and appends timeline data.
3. `state:changed` is an authoritative correction and replaces state/context together.
4. `server:history` merges by sequence and never replaces a newer live entry.
5. Events from an obsolete socket or another session are ignored.
6. Cache writes are projections of the reducer result, not parallel mutations.

## 6. Testing Strategy

### 6.1 Example tests

Each legal transition, command, socket action, and stale-attempt case keeps a
focused deterministic test. Existing behavior tests remain regression gates.

### 6.2 Property and model tests

Use `fast-check` in test-only dependencies for generated event sequences:

- Kernel never throws and always preserves invariants.
- `fold` equals iterative `step`.
- replay/fork remain deterministic.
- duplicate, missing, and out-of-order tool results do not corrupt pending calls.
- stale Host attempt events cannot change the current workflow.
- Dashboard event sequences cannot combine fields from different sessions or regress cursor/timeline order.

Failures must print the minimized event sequence so the case can be promoted to
a permanent example test.

### 6.3 Transition coverage

The exported Kernel transition description is used to verify every legal cell
has a positive test and every absent cell produces `ignored`. Documentation and
debugger diagrams derive from this description rather than a second handwritten
legality table.

## 7. Migration and Acceptance

Each stage is independently committed after its package tests and type checks
pass. Protocol wire shapes and persisted session logs remain readable throughout
the migration. Acceptance requires:

1. Existing sessions replay to the same user-visible transcript and effects.
2. Kernel, Host, and Dashboard full test suites pass.
3. Build and release bundle succeed.
4. No duplicate source of truth remains for migrated state.
5. Stale async completions have explicit regression tests.
6. The worktree contains only intentional committed changes.

## 8. Non-goals

- Introducing XState, Redux, or another global state runtime.
- Moving Host IO policy into the Kernel.
- Persisting Dashboard presentation state in session logs.
- Treating all component-local UI toggles as state machines.
- Changing provider, executor, or dashboard wire protocol merely to support the refactor.
