# Bang Shell command: design and usage

Status: implemented on `feature/bang-shell-command-20261002`; this document describes the current implementation, not a future isolation design.

## What it does

Bang Shell lets an operator run one foreground shell command directly from a Session Composer. Enter `!` as the **first character** of a draft, followed by the command:

```text
!git status --short
```

The Composer changes to the amber **Shell · workspace** mode. Submitting sends explicit `shell` intent to the Host. The Host removes the leading `!`, waits until the item is dispatchable in the Session queue, and invokes the Executor's `bash` tool with the Session's current working directory. The formatted result is persisted as user text in the Session, after which normal agent processing continues.

This is an explicit operator action. It is not a prompt convention interpreted by the model.

## Explicit intent and a literal leading `!`

Two fields determine meaning: the text and its intent.

- Shell execution requires `intent: "shell"` **and** a `!` in byte/character position zero. Shell intent without that prefix is rejected.
- In the Dashboard, typing `!` into an empty ordinary draft selects shell intent automatically.
- To send text such as `!important` to the agent instead, select the **Exit shell mode and keep as text** (`×`) control. It preserves the leading `!` and submits text intent.
- Leading whitespace is also a literal escape: ` !pwd` is ordinary text because `!` is not the first character. Rely on the explicit exit control when whitespace is semantically important rather than adding accidental whitespace.
- The per-Session unsent draft remembers the literal-text override. Starting a new non-bang draft resets intent to text.

This distinction is deliberate: a literal leading bang must remain possible, and the Host must not infer execution from message text alone.

## Workspace binding and execution boundary

A shell command is accepted only when its Session is authoritatively bound to a workspace. A Session without `workspaceId` receives `Shell commands require a Session bound to a workspace`. The Executor for that workspace must also be available when the command is dispatched.

The command runs through the existing Executor `bash` tool at the Session's current `cwd`. It can read, write, delete, start processes, or otherwise change anything allowed by that Executor and operating-system identity. Bang Shell does **not** add a sandbox, container, or permission boundary. In particular, this design makes no bubblewrap isolation claim. Any isolation is whatever the configured deployment and Executor already provide.

Attachments and structured message content are not accepted with a shell command. The command body is limited to 16 KiB UTF-8. The Host limits each displayed stdout and stderr stream to 64 KiB and marks truncation; the Executor can apply additional limits.

## STEER and QUEUE

Bang Shell uses the same durable per-Session message queue as operator messages.

- **QUEUE** appends the command. If a turn or earlier item is active, the command waits. It runs only after it reaches the idle queue head.
- **STEER** gives the command front priority and asks an active turn to stop at its supported boundary. It stays behind an already claimed queue head, because a claimed effect cannot safely be reordered. Multiple STEER items preserve their own arrival order ahead of ordinary QUEUE items.
- When the Session is already resting, a QUEUE submission can begin immediately; this does not give it permission to bypass an already claimed item.

The shell process is Host-owned queue work, not a model-selected tool call. Its formatted result is then admitted to the same Session as user text, so the agent can respond to the result.

## Cards, results, and cancellation

The pending command card exposes these queue states:

- `queued`: durably waiting in the Session queue;
- `running`: the Host has claimed the item and is waiting for the Executor call;
- `completed`: the Executor returned success with exit code zero (or a compatible older result without a numeric exit code);
- `nonzero`: the Executor returned normally with a nonzero numeric exit code;
- `failed`: the Executor/tool call reported failure.

After completion, a separate **Shell command** result card shows `Completed`, `Completed with nonzero exit`, or `Failed`, plus command identity, operation ID, command, exit status, duration when available, stdout, and stderr. Process output is untrusted data, not instructions.

There is currently no per-card cancel button. The Session's generic **Stop** action clears queued Session work and sends cancellation for in-flight Executor calls. Cancellation is therefore Session-wide and best effort across the Host/Executor boundary: it can suppress admission of a late result, but it cannot roll back filesystem, network, child-process, or other effects that happened before cancellation. Do not treat Stop as transactional process isolation or cleanup.

## Delivery and replay behavior

The Dashboard supplies an operation ID. The durable queue and transcript use stable derived IDs for the Executor call and result. A retry with the same operation ID and command is de-duplicated; reuse of that ID for a different command is rejected. This protects transport retry and Host restart paths, but does not make arbitrary shell effects exactly-once if execution occurred and its durable receipt is unavailable.

## Current verification status

On 2026-10-02, the focused Bang Shell unit test and four matching Host integration cases passed; the complete Composer and ChatPanel component test files also passed in this workspace. These runs validate the current branch state but are not release or deployment evidence.

Automated coverage present in the branch includes:

- first-character parsing, size/error handling, stable identities, result formatting, and final-state classification;
- Composer shell affordance, explicit literal-text exit, leading-whitespace behavior, workspace-offline handling, draft restoration/persistence, and STEER/QUEUE selection;
- Host integration for workspace binding, waiting behind an active turn, `queued → running → nonzero`, result persistence, a following STEER item not overtaking a claimed shell, literal leading-bang text, and external-runtime Stop cancellation signaling;
- transcript shell status and result-card rendering in Dashboard tests.

Those are automated unit/component/in-process integration scenarios. This document does not claim production deployment testing, hostile-command containment, cross-platform shell parity, reliable cleanup of arbitrary descendant processes, or end-to-end proof across every Executor/runtime implementation.
