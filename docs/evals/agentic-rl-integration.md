# Agentic RL Integration Research Note

Status: research note / proposed direction  
Date: 2026-07-06

This document records the current direction for making `agent-kernel` useful as an
agentic RL rollout harness. It is intentionally not a normative spec yet. The
main correction from earlier sketches is that `agent-kernel` should not invent a
primary `TrajectoryV1` training schema from scratch.

## Summary

The durable contract for `agent-kernel` should remain its append-only JSONL event
log and replayable kernel state. For RL training, however, the primary contract
should be adapter-first: emit or convert rollouts into the native data contracts
expected by mature training systems such as slime, verl, OpenRLHF, or TRL.

The first serious integration target should be slime-style agentic rollout
generation, not a generic JSON trajectory format. slime's coding-agent examples
are closer to this project than ordinary prompt/completion RLHF pipelines because
they explicitly deal with tool calls, sandboxed code execution, verifier rewards,
token-level loss masks, and long-horizon agent traces.

## Context

`agent-kernel` currently has several properties that are useful for RL rollout
infrastructure:

- A replayable kernel reducer and append-only JSONL event log.
- Host / executor separation, with tools executed outside the pure reducer.
- Workspace-root sandboxing and a host-side `agent` builtin for child sessions.
- Tool, approval, compaction, memory, and session events that can be audited.
- A dashboard that can inspect state, events, tool calls, and memory.

These are good control-plane properties. They are not, by themselves, sufficient
training data. RL frameworks need model-token-level samples, logprobs, loss
masks, rewards, rollout grouping, and sometimes framework-specific tensor or
buffer types. A JSONL UI/event trace is valuable for audit and replay, but it is
not a replacement for the training framework's data plane.

## Industrial observations

There is no single accepted industrial "TrajectoryV1 JSON" standard for
agentic RL. The production practice is framework-native and adapter-driven.

### verl

verl's core data movement is tensor-first. Its important abstraction is closer
to `DataProto`: tensor batches plus non-tensor metadata plus `meta_info`. That is
appropriate for distributed PPO/GRPO-style training, but it is not a natural
source format for a browser-visible agent event log.

Implication for this project: do not design `agent-kernel` around a custom JSON
trajectory and then hope verl accepts it. If verl becomes a target, build a
converter that turns completed rollouts into the tensor and metadata layout verl
expects.

### slime

slime is a better first target for long-horizon coding agents. Its extension
points are built around custom rollout generation and reward/verifier hooks, for
example custom generate functions and custom reward-model paths. Agentic
workflows are plugged into data generation instead of being forced through a
universal trajectory JSON first.

The key lesson from slime's coding-agent flow is the split between two worlds:

- The agent harness operates in a message/string/tool/environment world.
- The training sample must preserve the actual sampled model token ids,
  logprobs, and loss masks.

For tool-agent training, only model-sampled output tokens should normally carry
loss. User text, tool observations, environment messages, templates, injected
system text, and replayed context should usually have `loss_mask = 0`. Model
actions get `loss_mask = 1`, subject to the algorithm and training objective.

slime's coding-agent pattern also highlights problems that a serious harness
must handle: prefix drift, compaction, skipped turns, branch splitting, sibling
rollouts sharing a rollout id, verifier execution in a clean sandbox, and reward
assignment over long traces.

### OpenRLHF and TRL

OpenRLHF and TRL are mature and useful, but their common entry points are closer
to prompt/completion/reward-function datasets. That works well for shorter
tasks, preference data, or math/code snippets. It is less expressive for a full
interactive coding agent that may read files, edit files, run tests, fork
sessions, compact context, and call sub-agents.

Implication for this project: keep them as possible downstream adapters, but do
not let their simplest prompt/completion dataset shapes define the internal
architecture.

## Decision direction

`agent-kernel` should become an RL-ready rollout harness, not a training
framework and not the owner of a new universal trajectory standard.

Concretely:

- Keep JSONL event logs as the audit, replay, and debugging source of truth.
- Add a token-capture path around model generation for training samples.
- Build framework adapters that produce the native data expected by slime, verl,
  OpenRLHF, or TRL.
- Start with a slime adapter because it matches agentic coding workflows most
  closely.
- Treat any JSON sidecar as control-plane trace metadata, not as the primary
  training-plane format.

## Proposed architecture

### 1. Event log layer

The current JSONL session log remains the canonical harness trace. It should
record what happened: user messages, LLM calls and responses, tool calls, tool
results, approvals, compaction boundaries, session forks, verifier runs, and
sub-agent relationships.

This layer answers: what did the agent do, can we replay/fork/debug it, and can
we explain a reward later?

### 2. Token capture layer

Training needs the exact model-sampled tokens, not only rendered assistant text.
For each model generation, the adapter must capture at least:

- Token ids for sampled model output.
- Optional logprobs when the backend can provide them.
- The prompt/context tokenization boundary used by the serving backend.
- A stable link back to the JSONL event ids and session id.

This likely requires an OpenAI-compatible or Anthropic-compatible gateway that
can observe tokenized prompts and completions when backed by vLLM, SGLang, or a
similar serving stack. Hosted APIs may not expose enough token-level detail for
all training modes.

### 3. Segment and loss-mask builder

Long agent traces should be converted into trainable segments. Segment creation
must account for:

- Context compaction boundaries.
- Tool observations and environment messages.
- Branches and forks.
- Sub-agent calls.
- Failed or cancelled turns.
- Multi-sample rollouts for the same task.

The default policy should be conservative: only assistant/model-generated tokens
that represent the sampled policy action receive loss. Prompt, user,
environment, tool, verifier, and template tokens receive zero loss unless a
specific training objective says otherwise.

### 4. Verifier and reward layer

For coding tasks, reward should come from clean, isolated verification, not from
the same mutable workspace the agent used while acting. A basic coding verifier
should:

- Materialize a clean copy of the initial task repository.
- Apply the agent-produced patch or final workspace diff.
- Run configured tests, linters, or hidden checks.
- Emit structured reward metadata and human-readable failure details.
- Keep verifier output linked to the rollout id and JSONL session id.

This separation is important because otherwise the agent can overfit to or
tamper with the environment that grades it.

### 5. Framework adapter layer

The adapter layer is where framework-specific contracts belong.

For slime, the likely shape is a `custom_generate` function that invokes
`agent-kernel` to run one task rollout and returns the sample object(s) slime
expects. The adapter should also provide or call a custom reward function that
runs the verifier in a clean sandbox.

For verl, the adapter should convert completed samples into verl-native tensor
batches and metadata, rather than asking the rest of `agent-kernel` to speak
`DataProto` directly.

For TRL/OpenRLHF, the adapter may flatten simpler tasks into prompt/completion
records plus rewards, but this should be treated as a lossy path for shorter
workflows.

## MVP plan

The first implementation should be deliberately narrow:

1. Add an offline rollout exporter that can run a single benchmark task through
   `agent-kernel` and persist the JSONL sidecar.
2. Add token capture for model-generated assistant turns through one supported
   local serving backend.
3. Build a segment/loss-mask builder for single-agent, no-compaction coding
   tasks first.
4. Add a clean-sandbox verifier that scores the final diff.
5. Implement a slime-compatible adapter around that pipeline.
6. Only after that, generalize to compaction, forks, sub-agents, multiple
   sibling samples, and reward splitting.

This keeps the first milestone close to production practice while avoiding a
premature universal schema.

## Non-goals

- Do not implement PPO/GRPO/DAPO inside `agent-kernel`.
- Do not define a universal `TrajectoryV1` as the main interface.
- Do not make JSONL event logs carry token tensors directly.
- Do not couple the pure kernel reducer to any RL framework.
- Do not treat UI replay data as sufficient training data.

## Open research questions

- Which serving path should provide reliable token ids and logprobs: SGLang,
  vLLM, a custom OpenAI-compatible gateway, or another backend?
- How should compaction be represented in training samples without corrupting
  token-prefix consistency?
- How should sub-agent traces be credited: parent-only outcome reward, per-child
  segment reward, or hierarchical credit assignment?
- How should sibling rollouts and rollout ids map to slime and verl grouping
  semantics?
- Which benchmark tasks should be used first: SWE-bench style repo tasks,
  smaller unit-test repair tasks, or synthetic tool-use tasks?
- How much verifier detail should be exposed to the model during training versus
  retained only for audit?
- How should failed tool calls, cancelled turns, and partial rollouts be sampled
  or filtered?

## Current skill support in this repository

`agent-kernel` does not currently have a first-class skill system in the sense
of discoverable instruction packages such as `SKILL.md` bundles with trigger
rules, bundled references, scripts, and optional assets.

What exists today is lower-level infrastructure that could host such a system
later:

- A fixed executor tool registry: `read`, `ls`, `glob`, `grep`, `write`, `edit`,
  `bash`, background shell controls, `todowrite`, `websearch`, and memory tools.
- Host-declared tool schemas in `builtinTools`, including the host-side `agent`
  builtin for child sessions.
- Session, workspace, and global memory tools. Session memory is lifted into
  kernel state; workspace/global memory lives on executor-owned disk.
- Git-hook-like host hooks for `pre_tool_use`, `post_tool_use`, `session_start`,
  and `session_end`.
- A `/compact` slash command in the dashboard composer.

The kernel deliberately keeps planning, durable memory policy, and sub-agent
strategy outside the pure reducer. A future skill system should therefore live
above the kernel, probably as a host/extension layer that can discover skill
packages, inject instructions or references into context, register optional
tools, and use hooks for lifecycle/tool mediation.

## Reference-agent skill mechanisms

The current `docs/references-comparison.md` file mostly compares tools,
extensions, permission, memory, and sub-agent mechanisms. A more precise skill
comparison needs to separate real `SKILL.md` package systems from ordinary tool
registries.

### Shared pattern

Claude Code, Codex, OpenCode, and Pi have converged on a similar mechanism:

1. A skill is a directory containing `SKILL.md`.
2. `SKILL.md` has YAML frontmatter with at least a name and description, plus
   markdown instructions.
3. The agent does not put every full skill body into the prompt up front.
4. Startup/discovery injects only a compact available-skills list into context.
5. The model or user selects a skill.
6. The runtime loads the full `SKILL.md` on demand.
7. Supporting files such as `references/`, `scripts/`, templates, or assets live
   beside `SKILL.md` and are read or executed only when the skill instructions
   ask for them.

This is progressive disclosure: descriptions are always cheap; full skill
instructions and references are paid only when relevant.

### Claude Code

Claude Code skills follow the Agent Skills convention but add product-specific
controls.

- Locations: enterprise-managed skills, personal
  `~/.claude/skills/<name>/SKILL.md`, project
  `.claude/skills/<name>/SKILL.md`, plugin `<plugin>/skills/<name>/SKILL.md`,
  and nested `.claude/skills/` directories in monorepos.
- Invocation: explicit slash command such as `/deploy`, or automatic model
  invocation based on `description` / `when_to_use`.
- Naming: the command name normally comes from the directory path, not the
  frontmatter `name`; plugin skills are namespaced as `plugin-name:skill-name`.
- Loading: skill directories are watched; changes to `SKILL.md` can take effect
  in-session.
- Frontmatter controls include `disable-model-invocation`, `user-invocable`,
  `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`,
  `agent`, `hooks`, `paths`, and `shell`.
- Extra mechanism: dynamic context injection with lines like `` !`git diff` ``;
  Claude runs the command and substitutes output before the model sees the
  skill body.
- Execution model: skills can run inline or in a forked subagent context.
- Compatibility: older `.claude/commands/*.md` command files still work, but
  skills supersede commands because they support directories and supporting
  files.

### Codex

Codex uses skills as the reusable workflow authoring format and plugins as the
installable distribution unit.

- Locations: repo `.agents/skills` from CWD up to repo root, user
  `$HOME/.agents/skills`, admin `/etc/codex/skills`, and system bundled skills.
- Invocation: explicit `$skill-name` mention / skill selector, or implicit model
  selection from the skill description.
- Loading: startup context includes only name, description, and path. The
  initial skills list is budgeted to a small part of the model context; full
  `SKILL.md` is read only after selection.
- Required frontmatter: `name` and `description`.
- Optional sidecar: `agents/openai.yaml` for Codex app UI metadata, implicit
  invocation policy, and declared tool dependencies such as MCP servers.
- Enable/disable: `[[skills.config]]` entries in `~/.codex/config.toml` can
  disable a skill by path.
- Creation/distribution: `$skill-creator` scaffolds skills; `$skill-installer`
  installs curated skills; plugins package one or more skills plus optional app
  mappings, MCP config, hooks, and assets through `.codex-plugin/plugin.json`
  and marketplace metadata.

Codex's important design detail is the split between local skill authoring and
plugin distribution. A raw skill is enough for one repo or user. A plugin is for
sharing, bundling, marketplace install, and app/MCP integration.

### OpenCode

OpenCode exposes skills through an actual `skill` tool rather than relying only
on slash commands or implicit file reads.

- Locations: `.opencode/skills/<name>/SKILL.md`,
  `~/.config/opencode/skills/<name>/SKILL.md`, Claude-compatible
  `.claude/skills` / `~/.claude/skills`, and agent-compatible `.agents/skills` /
  `~/.agents/skills`.
- Discovery: for project paths, OpenCode walks upward from CWD to the git
  worktree root and collects matching skill directories along the way.
- Required frontmatter: `name` and `description`; optional `license`,
  `compatibility`, and string-to-string `metadata`. Unknown fields are ignored.
- Validation: `name` must match the containing directory and follow
  `^[a-z0-9]+(-[a-z0-9]+)*$`; descriptions are capped.
- Runtime exposure: the `skill` tool description contains an XML
  `<available_skills>` list with skill names and descriptions.
- Invocation: the model calls `skill({ name: "git-release" })` to load the full
  skill.
- Permissions: `opencode.json` has pattern-based `permission.skill` rules with
  `allow`, `deny`, and `ask`; permissions can be overridden per agent. The
  `skill` tool itself can also be disabled for an agent.

OpenCode is the cleanest example of skills as a first-class tool: listing is in
the tool description, and loading is a tool call subject to the normal permission
system.

### Pi

Pi has both a broad TypeScript extension API and a separate Agent Skills
implementation.

- Locations: global `~/.pi/agent/skills/` and `~/.agents/skills/`; project
  `.pi/skills/` and `.agents/skills/` from CWD up to git root; package `skills/`
  directories or `pi.skills` entries in `package.json`; explicit settings
  `skills` arrays; repeatable CLI `--skill <path>`.
- Discovery: scans at startup, extracts names and descriptions, and injects
  available skills into the system prompt in XML form.
- Loading: the model is expected to use `read` to load the full `SKILL.md`; users
  can force this through `/skill:name` commands.
- Frontmatter: `name` and `description` are required; `license`,
  `compatibility`, `metadata`, `allowed-tools`, and `disable-model-invocation`
  are supported.
- Validation: Pi warns on most Agent Skills spec violations but still loads the
  skill; missing description is a hard failure. Name collisions warn and keep
  the first skill found.
- Compatibility: Pi can consume skills from Claude Code or Codex directories by
  adding those paths in settings.
- Extensions: TypeScript extensions are more powerful than skills. They can
  register tools, commands, event hooks, custom UI, renderers, and persistent
  state. Skills are prompt/workflow packages; extensions are executable runtime
  plugins.

Pi's design separates lightweight skill instructions from full trusted code
extensions. That split is useful: most workflows should be skills; only runtime
behavior needs extensions.

### clawspring-style minimal agents

The clawspring reference is not a skill system. It has a Python tool dispatch
table and an `Agent` tool for sub-agent spawning. That is useful for minimal
agent loops, but it lacks skill discovery, frontmatter, progressive disclosure,
permissions, supporting files, and package distribution.

### Implication for `agent-kernel`

`agent-kernel` should implement skills above the pure reducer as a host-level
capability. The reducer should only see ordinary messages, tools, events, and
state transitions.

A credible skill implementation for this project should include:

- Skill discovery from project and user directories, probably compatible with
  `.agents/skills/<name>/SKILL.md` first.
- Frontmatter validation for `name` and `description`.
- Progressive disclosure: inject only an available-skills summary into the LLM
  context.
- A `skill` tool, or equivalent explicit host mechanism, that loads a selected
  skill body on demand.
- Permission controls for skill visibility and loading.
- Support for references/scripts/assets relative to the skill directory.
- Optional plugin packaging later, for bundling skills with MCP servers, hooks,
  custom tools, or UI assets.

The first implementation should copy OpenCode/Codex's simple data model rather
than inventing a new format: use `SKILL.md`, `name`, `description`, optional
metadata, compact available-skill listing, and on-demand full load.
