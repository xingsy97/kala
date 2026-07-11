# Skills Design

Status: proposed / first implementation target
Date: 2026-07-06

`agent-kernel` should implement skills with the OpenCode-style runtime model: a
skill is loaded through an explicit `skill({ name })` tool call. This keeps skill
selection observable, replayable, and permissionable instead of relying on a
hidden runtime loader.

## Goals

- Support reusable agent workflows without adding policy to the pure kernel.
- Make skill loading visible as a normal tool call in transcripts and JSONL.
- Keep context usage low by exposing only skill names and descriptions until a
  skill is selected.
- Use the existing tool-call lifecycle, approval machinery, dashboard timeline,
  and executor-independent host builtin pattern.
- Stay compatible with the common Agent Skills layout: `.agents/skills/<name>/SKILL.md`.

## Non-goals

- No plugin marketplace in the first implementation.
- No dynamic shell interpolation inside `SKILL.md` in the first implementation.
- No automatic execution of scripts from a skill. Scripts are just files the
  model may inspect or execute through existing tools after the skill explains
  them.
- No kernel-level skill state. The kernel sees ordinary tool calls and tool
  results only.

## Skill Format

The first implementation supports directory skills:

```text
.agents/skills/<name>/SKILL.md
~/.agents/skills/<name>/SKILL.md
```

`SKILL.md` starts with YAML-like frontmatter and then markdown instructions:

```markdown
---
name: code-review
description: Use when reviewing a diff or pull request for bugs, regressions, missing tests, and security risks.
---

## Instructions

Review the current diff. Findings first, ordered by severity.
```

The initial field set is intentionally small:

| Field | Required | Rule |
|---|---:|---|
| `name` | yes | Must match `^[a-z0-9]+(-[a-z0-9]+)*$` and match the containing directory name. |
| `description` | yes | 1 to 1024 characters. Used as the model's routing signal. |

Unknown frontmatter fields are ignored for now so existing Agent Skills content
can still load if it has valid `name` and `description`.

## Discovery

At host startup, the host scans:

1. Project root: `<workspace>/.agents/skills/*/SKILL.md` when a workspace root
   can be inferred from the host process CWD.
2. User global: `~/.agents/skills/*/SKILL.md`.

Later versions can expand this to parent-directory walking, admin paths, plugin
bundles, live watching, and per-workspace executor roots.

Invalid skills are skipped. Duplicate names keep the first discovered skill and
skip later duplicates.

## Agent-Side Runtime

The host declares a `skill` builtin tool to the model. The tool description
contains the compact available-skill index:

```xml
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Use when reviewing a diff or pull request...</description>
  </skill>
</available_skills>
```

The model selects a skill by emitting an ordinary tool call:

```json
{
  "name": "skill",
  "arguments": {
    "name": "code-review"
  }
}
```

The host handles `skill` like the existing host-side `agent` builtin:

1. Validate `input.name`.
2. Look up the discovered skill by name.
3. Read the full `SKILL.md` from disk.
4. Reject oversized files above 256 KiB instead of injecting an unbounded body
   into the next LLM request.
5. Return the markdown content as the tool result.
6. Let the ordinary kernel flow call the LLM again with that tool result in
   context.

This means skill usage is visible in the same places as any other tool call:
transcript, pending tool state, timeline effects, JSONL replay, and dashboard
tool history.

## Frontend Design

The dashboard should make `skill` visibly different from executor tools.

In the Inspector Tools tab:

- The registry row for `skill` shows a `skill` badge.
- The detail panel labels it as `Skill loader`.
- Its approval status remains visible separately (`auto` or `gated`).
- Recent calls work like any other tool and show successful or failed skill
  loads.

The transcript can keep rendering `skill` through the generic tool renderer for
the first implementation. A later renderer can summarize `Loaded skill:
<name>` from the tool input.

## Why OpenCode-Style

OpenCode's `skill({ name })` model is the right fit for `agent-kernel` because
it uses a normal tool call as the control signal. That gives us:

- Deterministic runtime behavior. The host never guesses from natural language.
- Compatibility with any model/provider that supports tool calls.
- Replay and audit from the existing JSONL event log.
- Clear future permission rules such as `allow`, `ask`, and `deny` per skill.
- Clean RL traces where loading a skill is an explicit model action.

Codex and Claude Code also support automatic skill use, but their public product
surface hides more of the loader. For this project, hidden loaders are the wrong
first step because they are harder to debug and harder to replay.

## Future Work

- `permission.skill` rules with `allow`, `ask`, and `deny`.
- Parent-directory walking up to git root.
- Workspace-root discovery from attached executors instead of only host CWD.
- `disable-model-invocation`, `allowed-tools`, `paths`, and other frontmatter.
- Live reload of changed `SKILL.md` files.
- Plugin bundles that package skills with MCP config, hooks, or custom tools.
