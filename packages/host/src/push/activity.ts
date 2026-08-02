/** In-memory presence used to avoid pushing when the product is already in use. */
export class PushActivityTracker {
  private readonly devices = new Map<string, { active: boolean; updatedAt: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly heartbeatTtlMs = 45_000,
  ) {}

  update(deviceId: string, active: boolean): void {
    this.devices.set(deviceId, { active, updatedAt: this.now() })
  }

  hasActiveDevice(): boolean {
    const now = this.now()
    let active = false
    for (const [deviceId, state] of this.devices) {
      if (now - state.updatedAt > this.heartbeatTtlMs) {
        this.devices.delete(deviceId)
      } else if (state.active) {
        active = true
      }
    }
    return active
  }
}
