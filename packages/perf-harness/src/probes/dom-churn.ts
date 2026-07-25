import type { Page } from 'puppeteer-core'

/**
 * Count how often elements matching a CSS selector are torn down and rebuilt
 * inside a container while some action runs. This is the direct measure of the
 * streaming/tool-loop "flicker": if already-rendered nodes are stable, the
 * removed/added counts stay near zero.
 */

export type DomChurnOptions = {
  /** CSS selector for the elements whose rebuilds we count. */
  selector: string
  /** CSS selector of the subtree to observe. Defaults to `body`. */
  within?: string
}

export type DomChurnResult = {
  /** Matching elements removed from the DOM during the window. */
  removed: number
  /** Matching elements added to the DOM during the window. */
  added: number
  /** Total mutation records seen (all kinds). */
  totalMutations: number
}

/**
 * Run `action` while observing DOM churn of `selector` under `within`.
 * Returns the counts. The observer is installed and torn down around the
 * action, so it captures exactly the churn caused by it.
 */
export async function measureDomChurn(
  page: Page,
  options: DomChurnOptions,
  action: () => Promise<void>,
): Promise<DomChurnResult> {
  await page.evaluate((opts) => {
    const win = window as unknown as { __akChurn?: DomChurnState; __akChurnStop?: () => void }
    const root = (opts.within ? document.querySelector(opts.within) : document.body) ?? document.body
    const state: DomChurnState = { removed: 0, added: 0, total: 0 }
    const matches = (n: Node): boolean =>
      n.nodeType === 1 &&
      ((n as Element).matches?.(opts.selector) === true ||
        (n as Element).querySelector?.(opts.selector) != null)
    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        state.total += 1
        rec.removedNodes.forEach((n) => { if (matches(n)) state.removed += 1 })
        rec.addedNodes.forEach((n) => { if (matches(n)) state.added += 1 })
      }
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    win.__akChurn = state
    win.__akChurnStop = () => mo.disconnect()
  }, options)

  await action()

  return page.evaluate(() => {
    const win = window as unknown as { __akChurn: DomChurnState; __akChurnStop?: () => void }
    win.__akChurnStop?.()
    return { removed: win.__akChurn.removed, added: win.__akChurn.added, totalMutations: win.__akChurn.total }
  })
}

/**
 * Measure how much the "already-rendered" region (everything except the last
 * child) of a container changes while an action runs. Used for streaming
 * markdown: the tail block naturally updates every token, but earlier blocks
 * must stay stable — so we ignore the last child and count changes to the rest.
 */
export async function measureEarlyRegionChanges(
  page: Page,
  containerSelector: string,
  action: () => Promise<void>,
): Promise<{ earlyRegionChanges: number }> {
  await page.evaluate((sel) => {
    const win = window as unknown as { __akEarly?: { changes: number; last: string }; __akEarlyStop?: () => void }
    const state = { changes: 0, last: '' }
    const mo = new MutationObserver(() => {
      const host = document.querySelector(sel)
      if (!host) return
      const kids = Array.from(host.children)
      if (kids.length < 2) return
      const early = kids.slice(0, -1).map((k) => (k as HTMLElement).outerHTML).join('')
      if (state.last && early !== state.last) state.changes += 1
      state.last = early
    })
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    win.__akEarly = state
    win.__akEarlyStop = () => mo.disconnect()
  }, containerSelector)

  await action()

  return page.evaluate(() => {
    const win = window as unknown as { __akEarly: { changes: number }; __akEarlyStop?: () => void }
    win.__akEarlyStop?.()
    return { earlyRegionChanges: win.__akEarly.changes }
  })
}

type DomChurnState = { removed: number; added: number; total: number }
