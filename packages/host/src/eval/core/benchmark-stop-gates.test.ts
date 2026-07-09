import { describe, expect, it } from 'vitest'

import { benchmarkStopReason } from './benchmark-stop-gates.js'

describe('benchmarkStopReason', () => {
  it('stops when max agent runs is reached', () => {
    expect(benchmarkStopReason(
      { maxAgentRuns: 2 },
      { attemptedAgentRuns: 2, errors: 0, contractFailures: 0 },
    )).toBe('max_agent_runs:2')
  })

  it('stops when error threshold is reached', () => {
    expect(benchmarkStopReason(
      { stopAfterErrors: 1 },
      { attemptedAgentRuns: 1, errors: 1, contractFailures: 0 },
    )).toBe('stop_after_errors:1')
  })

  it('stops when contract failure threshold is reached', () => {
    expect(benchmarkStopReason(
      { stopAfterContractFailures: 1 },
      { attemptedAgentRuns: 1, errors: 0, contractFailures: 1 },
    )).toBe('stop_after_contract_failures:1')
  })

  it('prefers max agent runs over other stop reasons for deterministic reporting', () => {
    expect(benchmarkStopReason(
      { maxAgentRuns: 2, stopAfterErrors: 1, stopAfterContractFailures: 1 },
      { attemptedAgentRuns: 2, errors: 1, contractFailures: 1 },
    )).toBe('max_agent_runs:2')
  })

  it('does not stop before thresholds are reached', () => {
    expect(benchmarkStopReason(
      { maxAgentRuns: 3, stopAfterErrors: 2, stopAfterContractFailures: 2 },
      { attemptedAgentRuns: 2, errors: 1, contractFailures: 1 },
    )).toBeUndefined()
  })
})
