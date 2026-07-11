# Principles
  
  - Kernel stays a pure reducer.
  - Host owns orchestration, context policy, LLM calls, persistence, and artifacts.
  - Executor owns local tool execution and local process integration.
  - Dashboard observes, explains, and controls through host APIs; it does not mutate kernel state directly.
  - Event logs should be replayable, resumable, and forkable.
  - Large evidence belongs in artifacts, not repeated inline in every log entry.
  