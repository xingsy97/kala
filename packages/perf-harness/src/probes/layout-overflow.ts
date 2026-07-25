import type { Page } from 'puppeteer-core'

/**
 * Detect horizontal overflow inside a container — elements whose content is
 * wider than the viewport / their box. This is the objective check for the
 * "content spills past the edge on mobile/PWA" class of layout bugs.
 */

export type OverflowSample = {
  tag: string
  testId: string
  className: string
  scrollWidth: number
  clientWidth: number
}

export type OverflowResult = {
  /** Whether the container was found at all. */
  found: boolean
  /** Container width in px (0 when not found). */
  containerWidth: number
  /** Viewport width in px. */
  viewportWidth: number
  /** Number of descendants overflowing horizontally past the viewport/container. */
  overflowCount: number
  /** A few example offenders (for diagnostics). */
  samples: OverflowSample[]
}

/**
 * Look for horizontally-overflowing descendants of `containerSelector`. An
 * element counts as overflowing when its scrollWidth exceeds its clientWidth
 * AND it (or its content) extends past the viewport edge — i.e. a real spill,
 * not an intentional inner scroll container.
 */
export async function detectHorizontalOverflow(page: Page, containerSelector: string): Promise<OverflowResult> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return { found: false, containerWidth: 0, viewportWidth: window.innerWidth, overflowCount: 0, samples: [] }
    const containerWidth = (root as HTMLElement).clientWidth
    const samples: OverflowSample[] = []
    let overflowCount = 0
    root.querySelectorAll('*').forEach((node) => {
      const el = node as HTMLElement
      if (el.clientWidth <= 0) return
      if (el.scrollWidth <= el.clientWidth + 2) return
      const rect = el.getBoundingClientRect()
      const spillsPastViewport = rect.right > window.innerWidth + 1
      const spillsPastContainer = el.scrollWidth > containerWidth + 8
      if (spillsPastViewport || spillsPastContainer) {
        overflowCount += 1
        if (samples.length < 8) {
          samples.push({
            tag: el.tagName.toLowerCase(),
            testId: el.getAttribute('data-testid') ?? '',
            className: (el.className || '').toString().slice(0, 80),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          })
        }
      }
    })
    return { found: true, containerWidth, viewportWidth: window.innerWidth, overflowCount, samples }
  }, containerSelector)
}
