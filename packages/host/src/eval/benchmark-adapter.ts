// BenchmarkAdapter contract.
//
// Extracted once SWE-bench and Terminal-Bench were both in tree (task #78).
// Per docs/meta/principles.md D2, abstraction lands with the second concrete
// consumer and a clear third planned (WebArena)  -  not before. The interface
// captures ONLY what both adapters actually share today:
//
//   - `kind` string used by run-registry entries
//   - a layout helper deriving rootDir / progressPath / summaryPath
//   - resolve  -  prepare  -  runAgent  -  runVerifier  -  importResults lifecycle
//   - explainScore that forces each adapter to state what its
//     `resolved` / `accuracy` mean in the benchmark's OFFICIAL terms
//
// Semantic differences (SWE-bench Docker harness vs Terminal-Bench
// run-tests.sh + parser; SweBenchInstance vs TerminalBenchTask; what
// `resolved` counts) are preserved via the type parameters. Do not flatten
// them.

export type BenchmarkKind = 'swe-bench' | 'terminal-bench'

export type BenchmarkRunLayoutBase = {
  runId: string
  rootDir: string
  progressPath: string
  summaryPath: string
}

export type BenchmarkScoreExplanation = {
  /** One-line human summary, e.g. "12 / 15 resolved (official SWE-bench harness)". */
  headline: string
  /** Named metrics for details panels; values already formatted for display. */
  details: Record<string, string | number>
  /** The exact term the benchmark's official docs use ("resolved", "reward", ...). */
  officialTerm: string
}

export interface BenchmarkAdapter<
  Task,
  ResolveInput,
  PreparedRun,
  PrepareInput,
  AgentInput,
  AgentArtifacts,
  VerifierInput,
  VerifierArtifacts,
  ImportInput,
  Summary,
> {
  readonly kind: BenchmarkKind
  layout(rootDir: string, runId: string): BenchmarkRunLayoutBase
  resolveTasks(input: ResolveInput): Promise<readonly Task[]>
  prepareRun(input: PrepareInput): Promise<PreparedRun>
  runAgent(input: AgentInput): Promise<AgentArtifacts>
  runVerifier(input: VerifierInput): Promise<VerifierArtifacts>
  importResults(input: ImportInput): Promise<Summary>
  explainScore(summary: Summary): BenchmarkScoreExplanation
}

// Convenience alias for map-based lookup where the specific type parameters
// are not statically known at the call site.
export type AnyBenchmarkAdapter = BenchmarkAdapter<
  unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown
>
