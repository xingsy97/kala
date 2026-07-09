export type BenchmarkStopGateConfig = {
  maxAgentRuns?: number
  stopAfterErrors?: number
  stopAfterContractFailures?: number
}

export type BenchmarkStopGateStats = {
  attemptedAgentRuns: number
  errors: number
  contractFailures: number
}

export function benchmarkStopReason(
  config: BenchmarkStopGateConfig,
  stats: BenchmarkStopGateStats,
): string | undefined {
  if (config.maxAgentRuns !== undefined && stats.attemptedAgentRuns >= config.maxAgentRuns) {
    return `max_agent_runs:${config.maxAgentRuns}`
  }
  if (config.stopAfterErrors !== undefined && stats.errors >= config.stopAfterErrors) {
    return `stop_after_errors:${config.stopAfterErrors}`
  }
  if (config.stopAfterContractFailures !== undefined && stats.contractFailures >= config.stopAfterContractFailures) {
    return `stop_after_contract_failures:${config.stopAfterContractFailures}`
  }
  return undefined
}
