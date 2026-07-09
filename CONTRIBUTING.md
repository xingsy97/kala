# Contributing to agent-kernel

Thanks for reading this. `agent-kernel` is a pedagogical reference implementation, so contribution guidelines lean toward *clarity and readability* over feature velocity.

---

## Ground rules

1. **Specs are normative, code follows.** If your change contradicts a doc, update the doc in the *same* PR. If the spec is wrong, fix the spec first, then the code.
2. **The kernel is holy ground.** Any PR that grows [`packages/kernel/src/`](packages/kernel/src/) needs justification against [ADR 0001](docs/adr/0001-pure-reducer.md) and [ADR 0005](docs/adr/0005-kernel-boundary.md). "It's convenient" is not enough — the kernel is meant to be readable in one sitting.
3. **Prefer tightening the spec over loosening it.** Adding an escape hatch is a design smell.

---

## Before you open a PR

- [ ] `pnpm -r typecheck` clean, no `any`
- [ ] `pnpm -r test` passes with coverage meeting [`docs/testing.md`](docs/testing.md) targets
- [ ] `pnpm -r build` succeeds — every package emits `dist/` with `.d.ts`
- [ ] Doc changes are in the same PR as the code changes they describe
- [ ] Commit message explains the *why*, not the *what* (the diff already shows the what)

---

## Scope of what's welcome

**Very welcome:**
- Bug fixes in the kernel FSM with a failing test that reproduces the bug
- Doc improvements — typos, unclear passages, missing rationale, better examples
- New LLM adapters (OpenAI, DeepSeek, Bedrock, local via ollama) — as long as they conform to the `LLMAdapter` interface
- New Executor tools — as long as they're generally useful, have a JSON schema, and follow the pattern in [`docs/tools.md`](docs/tools.md)
- Better dashboard UX

**Consider before opening:**
- New wire events — coordinate with a maintainer first, protocol changes cascade
- Larger deferred items in [`docs/ROADMAP.md`](docs/ROADMAP.md) — open an issue for discussion
- Adding runtime deps to the kernel — needs a strong justification

**Not welcome:**
- Adding planning / memory / subagents to the kernel (see [ADR 0005](docs/adr/0005-kernel-boundary.md))
- Introducing a separate relay process for v1 (see [ADR 0006](docs/adr/0006-no-relay-process.md))
- Swapping Socket.IO for a different transport without discussion (see [ADR 0003](docs/adr/0003-socket-io.md))
- Making kernel functions async (kills purity)

---

## Development setup

```bash
git clone https://github.com/<owner>/agent-kernel
cd agent-kernel
pnpm install
pnpm -r build
pnpm -r test
```

Requirements:
- Node ≥ 20
- pnpm ≥ 8

For the Dashboard, you'll also need a browser and a running Host instance — see the [top-level README's Quick tour](README.md#quick-tour) for the three-terminal recipe.

---

## Repo layout

See the [README](README.md#repository-layout).

Each package has its own README. Read those first when working on a package.

---

## Commit and PR style

- **Commits**: one logical change per commit. Squash noise before pushing.
- **PR titles**: `<scope>: <verb-phrase>`, e.g. `kernel: fix cursor off-by-one after reject event`.
- **PR bodies**: what changed, why, what tests were added. Link to the ADR or spec section your change touches.

---

## Filing bugs

Include:
- Package + version
- Node version
- Minimal reproduction (ideally a failing test)
- Actual vs. expected

Bugs in the kernel are easier to reproduce than bugs in the host loop — for kernel bugs, please try to reduce to a `step()` call sequence in a Vitest file.

---

## Design discussion

The best way to influence a big design decision is to draft an ADR (see the format in [`docs/adr/0000-index.md`](docs/adr/0000-index.md)) and open a PR against `docs/adr/`. This forces the discussion to converge on written trade-offs rather than drifting in issue comments.
