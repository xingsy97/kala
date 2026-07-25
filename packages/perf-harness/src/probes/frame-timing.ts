import type { Page } from 'puppeteer-core'

/**
 * Sample requestAnimationFrame intervals while an action runs and summarize
 * how janky the main thread was. A long frame means the main thread was blocked
 * (rendering, layout, GC, a heavy synchronous computation) and animations/
 * interactions stuttered. This is the "is it smooth?" measurement.
 */

export type FrameTimingResult = {
  /** Number of frames sampled. */
  frames: number
  /** Mean frame interval (ms). ~16.7 at a healthy 60fps. */
  avgMs: number
  /** Longest single frame interval (ms) — the worst hitch. */
  maxMs: number
  /** Frames longer than 33ms (a dropped frame at 60fps). */
  droppedOver33ms: number
  /** Frames longer than 100ms (a visible hitch). */
  hitchesOver100ms: number
}

/** Run `action` while recording frame intervals; return a jank summary. */
export async function measureFrameTiming(page: Page, action: () => Promise<void>): Promise<FrameTimingResult> {
  await page.evaluate(() => {
    const win = window as unknown as { __akFrames?: number[]; __akFramesRun?: boolean }
    win.__akFrames = []
    win.__akFramesRun = true
    let last = performance.now()
    const loop = (t: number): void => {
      win.__akFrames!.push(t - last)
      last = t
      if (win.__akFramesRun) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })

  await action()

  return page.evaluate(() => {
    const win = window as unknown as { __akFrames: number[]; __akFramesRun: boolean }
    win.__akFramesRun = false
    const f = win.__akFrames.filter((x) => x > 0)
    const frames = f.length
    const sum = f.reduce((a, c) => a + c, 0)
    return {
      frames,
      avgMs: frames > 0 ? Math.round(sum / frames) : 0,
      maxMs: frames > 0 ? Math.round(Math.max(...f)) : 0,
      droppedOver33ms: f.filter((x) => x > 33).length,
      hitchesOver100ms: f.filter((x) => x > 100).length,
    }
  })
}
