# Kernel TLA+ model

This finite model checks the asynchronous control flow around the pure
TypeScript reducer. It abstracts payload text and host I/O while retaining the
state phases, approval boundary, dispatched-call correlation, effects, ignored
events, and cursor advancement. The unbounded cursor is represented by a
two-value parity bit so TLC can exhaust the state space while still requiring
every modeled step to advance it.

`KernelContract.tla` mirrors the production transition contract.
`Kernel.tla` defines the abstract behavior and fairness assumptions.
`Kernel.cfg` asks TLC to check:

- state and pending-call type safety;
- approval safety for every emitted `call_tool`;
- deadlock freedom;
- progress from LLM, approval, and tool waiting states when the corresponding
  environment action is weakly fair.

`KernelContract.tla` is generated from the compiled TypeScript transition
matrix. After changing statuses, events, or handlers:

```bash
pnpm --filter @agent-kernel/kernel build
node scripts/formal/generate-kernel-contract.mjs
```

CI runs the same generator with `--check` and fails if the committed contract
does not match production.

Run the pinned TLC version from the repository root:

```bash
curl -sSfL -o /tmp/tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  /tmp/tla2tools.jar" \
  | sha256sum -c -
java -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC \
  -config formal/kernel/Kernel.cfg formal/kernel/Kernel.tla
```

The progress properties are conditional. They do not claim that a provider,
user, or tool must respond; weak fairness represents that external assumption.
