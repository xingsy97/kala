# Roadmap · What NOT to do

The following items are explicitly out of scope, even if they look easy. This list aligns with section F of [../../meta/principles.md](../../meta/principles.md).

- **No standalone sandbox-executor layer**: the existing `packages/executor` `runCommand` is sufficient for Terminal-Bench. Extracting a new layer adds complexity without payoff.
- **No infrastructure-only components (HDFS / K8s / MQ)**: those belong in an infrastructure product; they are outside this project's scope.
- **No new `docs/planning/enhancement/13-XX.md`**: 12 design documents is already the ceiling. Additional design documents dilute the signal — readers open the code, not more markdown.
- **No "mock now, real later" features**: every feature must actually run. Introducing a mock breaks that guarantee immediately.
- **No OSWorld-class desktop/computer-use benchmarks**: not in the first four; too GUI/VM-heavy and outside the executor + browser + tool-protocol thread.
