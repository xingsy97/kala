import { setTimeout as delay } from 'node:timers/promises'

import { WorkerRegistrationSchema, type AgentVariantSpec, type SandboxPolicy, type WorkerReadiness, type WorkerRegistration } from '@agent-kernel/eval-protocol'
import { ControlPlaneClient, type ReferencedHashSigner } from '@agent-kernel/eval-sdk'

import type { CredentialResolver } from './credentials.js'
import { WorkerLeaseClient } from './lease-client.js'
import type { WorkerRuntimeRegistry } from './registry.js'
import { TrialRunner } from './trial-runner.js'

export class EvaluationWorker {
  readonly registration: WorkerRegistration
  private readonly leases: WorkerLeaseClient
  private readonly runner: TrialRunner

  constructor(private readonly options: {
    controlPlane: ControlPlaneClient
    registry: WorkerRuntimeRegistry
    credentials: CredentialResolver
    workerId: string
    workerVersion: string
    cpu: number
    memoryMb: number
    diskMb: number
    gpu: number
    maxTrials: number
    leaseMs: number
    artifactRoot: string
    workerDataDir: string
    signingProvider: ReferencedHashSigner
    cancellationGraceMs?: number
    onTrialError?: (error: unknown, trialId: string) => void
    readinessPolicies?: { sandboxes: readonly SandboxPolicy[]; agents: readonly AgentVariantSpec[] }
  }) {
    const capabilities = options.registry.capabilities()
    this.registration = WorkerRegistrationSchema.parse({ schemaVersion: 1, workerId: options.workerId, signingKeyReference: options.signingProvider.keyReference, workerVersion: options.workerVersion, protocolVersions: [1], sandboxProviders: capabilities.sandboxes, agentBackends: capabilities.agents, benchmarkAdapters: capabilities.benchmarks, capacity: { cpu: options.cpu, memoryMb: options.memoryMb, diskMb: options.diskMb, gpu: options.gpu, maxTrials: options.maxTrials } })
    this.leases = new WorkerLeaseClient(options.controlPlane, this.registration, options.leaseMs)
    this.runner = new TrialRunner(options)
  }

  private async registrationWithReadiness(): Promise<WorkerRegistration> {
    const policies = this.options.readinessPolicies
    if (!policies) return this.registration
    const checkedAt = new Date().toISOString()
    const capabilities = this.options.registry.capabilities()
    const supportedSandboxes = policies.sandboxes.filter((policy) => capabilities.sandboxes.includes(policy.provider))
    const supportedAgents = policies.agents.filter((variant) => capabilities.agents.includes(variant.backendId))
    const sandboxes = await Promise.all(supportedSandboxes.map(async (policy) => {
      const provider = this.options.registry.sandbox(policy.provider)
      const result = await provider.preflight(policy)
      return {
        provider: policy.provider, imageDigest: policy.imageDigest, networkMode: policy.network.mode,
        allowedDestinations: [...policy.network.allowedDestinations], ok: result.ok,
        errors: result.errors.map((item) => ({ component: 'sandbox' as const, ...item })),
        warnings: result.warnings.map((item) => ({ component: 'sandbox' as const, ...item })),
      }
    }))
    const agents = await Promise.all(supportedAgents.map(async (variant) => {
      const backend = this.options.registry.agent(variant)
      const result = await backend.preflight(variant)
      const missing = []
      for (const reference of variant.credentialRefs) if (!(await this.options.credentials.available(reference))) missing.push({ component: 'credentials' as const, code: 'CREDENTIAL_REFERENCE_UNAVAILABLE', message: 'credential reference is unavailable: ' + reference.referenceId })
      return {
        backendId: variant.backendId, configHash: variant.configHash, credentialReferenceIds: variant.credentialRefs.map((reference) => reference.referenceId),
        ok: result.ok && missing.length === 0, errors: [...result.errors.map((item) => ({ component: 'agent' as const, ...item })), ...missing],
        warnings: result.warnings.map((item) => ({ component: 'agent' as const, ...item })),
      }
    }))
    const readiness: WorkerReadiness = { checkedAt, sandboxes, agents }
    return WorkerRegistrationSchema.parse({ ...this.registration, readiness })
  }

  async start(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const stop = () => controller.abort(signal?.reason ?? new Error('worker stopping'))
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    for (const provider of this.options.registry.sandboxProviders()) await provider.reapOrphans(this.registration.workerId)
    await this.leases.register(await this.registrationWithReadiness(), controller.signal)
    const active = new Set<Promise<void>>()
    let heartbeatError: unknown
    const workerHeartbeat = this.workerHeartbeatLoop(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) { heartbeatError = error; controller.abort(error) }
    })
    try {
      while (!controller.signal.aborted) {
        while (active.size < this.registration.capacity.maxTrials) {
          let lease: import('@agent-kernel/eval-protocol').TrialLease | null
          try { lease = await this.leases.acquire(controller.signal) } catch (error) {
            if (controller.signal.aborted) break
            throw error
          }
          if (!lease) break
          const run = this.runLease(lease, controller.signal).catch((error: unknown) => this.options.onTrialError?.(error, lease.trialId)).finally(() => active.delete(run))
          active.add(run)
        }
        if (active.size === 0) await delay(500, undefined, { signal: controller.signal }).catch(() => undefined)
        else await Promise.race([...active, delay(250, undefined, { signal: controller.signal }).catch(() => undefined)])
      }
    } finally {
      controller.abort(new Error('worker stopped'))
      await Promise.allSettled(active)
      await workerHeartbeat
      signal?.removeEventListener('abort', stop)
    }
    if (heartbeatError && !signal?.aborted) throw heartbeatError
  }

  async runUntilIdle(options: { pollIntervalMs?: number; idlePolls?: number; signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal
    for (const provider of this.options.registry.sandboxProviders()) await provider.reapOrphans(this.registration.workerId)
    await this.leases.register(await this.registrationWithReadiness(), signal)
    const active = new Set<Promise<void>>()
    let idlePolls = 0
    const requiredIdlePolls = options.idlePolls ?? 3
    const pollIntervalMs = options.pollIntervalMs ?? 100
    while (!signal?.aborted) {
      let acquired = false
      while (active.size < this.registration.capacity.maxTrials) {
        const lease = await this.leases.acquire(signal)
        if (!lease) break
        acquired = true
        const running = this.runLease(lease, signal).catch((error: unknown) => this.options.onTrialError?.(error, lease.trialId)).finally(() => active.delete(running))
        active.add(running)
      }
      if (active.size > 0) { idlePolls = 0; await Promise.race([...active]); continue }
      if (!acquired) idlePolls += 1
      if (idlePolls >= requiredIdlePolls) return
      await delay(pollIntervalMs, undefined, signal ? { signal } : undefined).catch(() => undefined)
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('worker run aborted')
  }

  private async workerHeartbeatLoop(signal: AbortSignal): Promise<void> {
    const intervalMs = Math.max(100, Math.floor(this.options.leaseMs / 3))
    while (!signal.aborted) {
      await delay(intervalMs, undefined, { signal }).catch(() => undefined)
      if (!signal.aborted) await this.leases.heartbeatWorker(signal)
    }
  }

  private async runLease(lease: import('@agent-kernel/eval-protocol').TrialLease, parentSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const abort = () => controller.abort(parentSignal?.reason ?? new Error('worker stopping'))
    parentSignal?.addEventListener('abort', abort, { once: true })
    if (parentSignal?.aborted) abort()
    let receipt: 'none' | 'known' | 'indeterminate' = 'none'
    let lastEventSequence = 0
    let heartbeatTail = Promise.resolve()
    const heartbeat = async (next?: 'known' | 'indeterminate'): Promise<void> => {
      if (next) receipt = next
      const sent = heartbeatTail.then(() => this.leases.heartbeat(lease, lastEventSequence, receipt, controller.signal))
      heartbeatTail = sent.then(() => undefined, () => undefined)
      await sent
    }
    await heartbeat()
    const intervalMs = Math.max(100, Math.floor(this.options.leaseMs / 3))
    const loop = (async () => {
      while (!controller.signal.aborted) {
        await delay(intervalMs, undefined, { signal: controller.signal }).catch(() => undefined)
        if (controller.signal.aborted) return
        try { await heartbeat() } catch (error) { controller.abort(error); return }
      }
    })()
    try {
      await this.runner.run(lease, controller.signal, {
        executionReceipt: async (next) => heartbeat(next),
        progress: async (state) => {
          const event = await this.leases.progress(lease, state, controller.signal)
          lastEventSequence = event.sequence
        },
      })
    } finally {
      controller.abort(new Error('trial finished'))
      parentSignal?.removeEventListener('abort', abort)
      await loop
      await heartbeatTail
    }
  }
}
