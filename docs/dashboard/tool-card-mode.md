# Tool Card Mode

`Tool Card Mode` is a per-session dashboard preference controlling only the
collapsed presentation of tool calls. It does not change transcript grouping,
tool execution, approvals, or expanded request/result content.

## Modes

- `dots` (default): one status dot per tool call, with a tooltip containing the
  tool name, primary target, status, and structured change summary when present.
- `standard`: the existing textual card header with tool name, target, lifecycle
  badges, and structured summary.

Clicking either collapsed presentation opens the same detailed activity view. A
dot click opens the group and selects that call. Pending approvals remain
expanded regardless of mode so a display preference cannot hide required user
action.

## Ownership and persistence

The value lives in `SessionPreferences`, alongside the selected model. The host
persists explicit values as append-only session metadata and includes preferences
in session summaries so Session Info can inspect and update any listed session.
Missing values resolve to `dots`; old sessions therefore receive the new default
without rewriting their logs. Existing control-plane metadata updates synchronize
changes across connected dashboards.

Session Info is the only configuration surface. It displays the effective mode
and saves changes together with the other editable session metadata.
