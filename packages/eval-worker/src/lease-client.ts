import { ControlPlaneClient, type EvaluationEvent, type TrialLease, type TrialProgressUpdate, type WorkerRegistration } from '@agent-kernel/eval-sdk'

export class WorkerLeaseClient {
  constructor(readonly controlPlane: ControlPlaneClient, readonly registration: WorkerRegistration, readonly leaseMs: number) {}

  async register(registration: WorkerRegistration = this.registration, signal?: AbortSignal): Promise<void> {
    await this.controlPlane.registerWorker(registration, signal)
  }

  async acquire(signal?: AbortSignal): Promise<TrialLease | null> {
    return await this.controlPlane.acquireLease(this.registration.workerId, this.leaseMs, signal)
  }

  async heartbeatWorker(signal?: AbortSignal): Promise<void> {
    await this.controlPlane.heartbeatWorker(this.registration.workerId, signal)
  }

  async heartbeat(lease: TrialLease, lastEventSequence: number, executionReceipt: 'none' | 'known' | 'indeterminate', signal?: AbortSignal): Promise<void> {
    await this.controlPlane.heartbeatLease({ schemaVersion: 1, leaseId: lease.leaseId, workerId: this.registration.workerId, at: new Date().toISOString(), lastEventSequence }, executionReceipt, signal)
  }

  async progress(lease: TrialLease, state: TrialProgressUpdate['state'], signal?: AbortSignal): Promise<EvaluationEvent> {
    return await this.controlPlane.progressTrial({ schemaVersion: 1, leaseId: lease.leaseId, workerId: this.registration.workerId, trialId: lease.trialId, state, at: new Date().toISOString() }, signal)
  }
}
