export {
  openDashboard,
  type BrowserSession,
  type BrowserSessionOptions,
} from './browser-session.js'

export {
  measureDomChurn,
  measureEarlyRegionChanges,
  type DomChurnOptions,
  type DomChurnResult,
} from './dom-churn.js'

export {
  measureFrameTiming,
  type FrameTimingResult,
} from './frame-timing.js'

export {
  profileMainThread,
  type CpuProfileResult,
  type CpuProfileOptions,
  type SelfTimeEntry,
} from './cpu-profile.js'

export {
  detectHorizontalOverflow,
  type OverflowResult,
  type OverflowSample,
} from './layout-overflow.js'

/** Await a fixed duration — handy for "observe for N seconds" windows. */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
