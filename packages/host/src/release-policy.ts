export type ReleasePolicy = { channel: 'stable' | 'preview'; minExecutorVersion: string; maxExecutorVersion: string; maintenanceWindow?: { startHourUtc: number; durationMinutes: number } }
export function executorVersionAllowed(policy: ReleasePolicy, version: string): boolean { return compare(version, policy.minExecutorVersion) >= 0 && compare(version, policy.maxExecutorVersion) <= 0 }
export function withinMaintenanceWindow(policy: ReleasePolicy, now = new Date()): boolean {
  if (!policy.maintenanceWindow) return true
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes(), start = policy.maintenanceWindow.startHourUtc * 60
  return ((minute - start + 1440) % 1440) < policy.maintenanceWindow.durationMinutes
}
function compare(a: string, b: string): number { const aa=a.split('.').map(Number),bb=b.split('.').map(Number); for(let i=0;i<3;i++){const d=(aa[i]??0)-(bb[i]??0);if(d)return Math.sign(d)}return 0 }
