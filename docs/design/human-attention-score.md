# Human Attention Score

## Motivation

Vibe coding can gradually move from assisted work to unattended delegation. The
operator may keep sending broad continuation prompts while the agent performs
more tool calls, edits more files, and approaches higher-risk actions such as
deploys or restarts. The product needs a session-level indicator that answers a
specific operational question:

> Is the human providing enough effective attention for this session's current
> autonomous activity and risk?

This is not a productivity score, politeness score, or global user-activity
metric. It is a risk indicator for one session.

## Design Principles

1. **Session scoped**

   Each score belongs to exactly one session. A user can be highly engaged in
   one session and absent in another. No global roll-up is part of this feature.

2. **Message-indexed timeline**

   The primary artifact is a curve where `x = message cursor` and `y = score`.
   The latest point is the compact indicator; the full timeline explains how
   attention changed as the conversation progressed.

3. **Quality of attention, not amount of activity**

   The score measures evidence of intent, constraints, review, correction, risk
   awareness, and continuity. Frequent approvals or clicks do not imply high
   attention unless they are paired with real review evidence.

4. **Risk-aware context**

   The same message can mean different things depending on session risk.
   `continue` after read-only exploration is low risk. `continue` after many
   edits, commits, and a pending deploy is high risk.

5. **Tone-insensitive**

   The evaluator must not penalize rudeness or emotional language. A blunt
   correction with specific technical constraints is high-quality attention.

6. **Explainable**

   Every low or high score must have compact reasons that point to evidence,
   such as "18 tool calls since last substantive review" or "Human corrected an
   incorrect deployment assumption".

7. **Non-blocking by default**

   The indicator warns and guides review. It should not interrupt normal work.
   High-risk actions may later use the score as a double-confirm signal.

8. **LLM-ready, deterministic first**

   The first implementation uses deterministic semantic heuristics so the UI is
   fast and always available. A later LLM evaluator can replace only the
   semantic judgement layer; final score composition remains deterministic.

## Data Model

The session exposes a timeline of points:

```typescript
type HumanAttentionTimeline = {
  sessionId: string
  points: readonly HumanAttentionPoint[]
  latest: HumanAttentionPoint | null
}

type HumanAttentionPoint = {
  sessionId: string
  messageCursor: number
  score: number // 0..100
  level: 'engaged' | 'watching' | 'drifting' | 'absent'
  confidence: number // 0..1
  dimensions: {
    inputQuality: number
    reviewDepth: number
    correctionQuality: number
    riskAwareness: number
    continuity: number
    riskExposure: number
  }
  reasons: readonly HumanAttentionReason[]
  evaluatedAt: string
  evaluator: 'heuristic' | 'llm'
}
```

`messageCursor` is the session event sequence. This makes chart points stable
across reconnects and replay.

## Scoring Rules

The score is easier to reason about as three forces:

```text
score = SemanticQuality + ReviewBonus - RiskPenalty - StalenessPenalty
```

The first implementation computes these from the session event timeline.

### Semantic Quality

Recent human messages and durable session anchors are scored for:

- **Intent quality**: explicit goal, scope, and acceptance criteria.
- **Constraint quality**: boundaries such as "do not deploy", "one commit per
  task", "do not write hostnames into repo".
- **Correction quality**: precise correction of agent assumptions or behavior.
- **Risk awareness**: references to tests, schema, deployment, data loss,
  running sessions, compatibility, or rollback.
- **Continuity**: reference to earlier requirements and enforcement of prior
  decisions.

Short messages are not automatically low quality. `不要部署` is short and high
signal. `继续` is short and usually low signal.

### Session Anchors

Some human instructions remain relevant beyond the recent window. Examples:

- no deployment without instruction
- one task per commit
- run tests before deploy
- do not write private hostnames into repo
- preserve current UI behavior

Anchors decay more slowly than ordinary messages, so an early high-quality
instruction does not disappear immediately. However, anchors cannot fully offset
large accumulated risk without fresh review.

### Risk Exposure

Risk exposure comes from agent activity since the last substantive human review.
Activity classes use different weights:

- read-only exploration: low
- tool calls that execute shell commands: medium
- file edits: medium-high
- commits/builds: high
- deploy/delete/schema/restart/force operations: very high

The score should drop slowly during read-only audit and faster during broad code
changes or deployment preparation.

### Review Evidence

Review evidence raises confidence and offsets risk:

- specific critique of output, screenshot, diff, or behavior
- correction of wrong environment/session assumptions
- approval paired with reason or constraint
- request for tests, risk summary, or exact change list

Plain repeated approvals are weak evidence and can still produce a low score.

### Levels

```typescript
if (score >= 75) level = 'engaged'
else if (score >= 50) level = 'watching'
else if (score >= 30) level = 'drifting'
else level = 'absent'
```

## Timeline Rules

The first implementation computes a point at each human message and at major
agent milestones. The chart uses all points, and the compact indicator displays
the latest point.

The evaluator uses a sliding recent window plus session anchors:

- recent window: roughly the last 24 session events
- anchors: durable high-signal constraints discovered earlier in the session
- risk since last substantive review: events after the last meaningful human
  review or correction

## UI Design

### Compact Indicator

The indicator appears in the current session header/control area near context
usage:

```text
Attention 68
```

Colors are restrained:

- `engaged`: green
- `watching`: sky/neutral
- `drifting`: amber
- `absent`: red

Empty state uses `Attention --` with a tooltip explaining that there is not
enough session activity yet.

### Popover

Clicking the indicator opens a session-scoped panel with:

- latest score and level
- line chart: x-axis message cursor, y-axis score 0..100
- compact dimension bars
- latest reasons
- suggested review actions

Point hover shows message cursor, score, level, and reasons for that point.

### Low Score Banner

When the latest level is `absent` and there is evidence of meaningful risk or
repeated low-signal delegation, a compact banner appears above the composer:

```text
Attention is low. Review recent changes before broad instructions.
```

It should be visible but not modal. A fresh low-risk exploration request should
not show this banner merely because it lacks review language; `absent` only
becomes user-facing when it is risk-adjusted.

### Suggested Actions

Initial actions:

- ask for risk summary: prefill or send a review prompt later
- review recent changes: later integration with changed-file/diff surfaces
- continue anyway: dismisses the banner for the current latest point

## LLM Evaluation Extension

The LLM evaluator should only replace semantic judgement. It should receive a
compact evidence packet, not the full transcript, and return structured scores
for the semantic dimensions. It must be explicitly instructed not to judge tone,
personality, or politeness. The deterministic scorer still combines semantic
quality with risk exposure and review staleness.

## Simulated Behavior Checks

- Strong constraints plus periodic correction should stay `engaged` even during
  heavy tool activity.
- Repeated `continue` messages during broad edits should drift toward `absent`.
- Read-only code audit with little user interaction should degrade slowly, not
  alarm immediately.
- A short but specific correction should recover the score quickly.
- Repeated approvals without review should not count as strong attention.
