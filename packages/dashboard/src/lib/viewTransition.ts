/**
 * Thin wrapper around the browser's View Transitions API so callers can
 * request a smooth cross-fade between two React commits without knowing
 * anything about `document.startViewTransition` or its capability
 * detection.
 *
 * Why not just call the API directly? Two reasons:
 *
 *   1. Feature detection — Firefox has not shipped View Transitions as of
 *      writing. Without a wrapper, every call site would have to duplicate
 *      the `typeof document.startViewTransition === 'function'` check.
 *   2. `flushSync` is mandatory. React 18 batches state updates across
 *      microtasks; if we don't force a synchronous commit inside the
 *      transition callback, the API captures the *pre* screenshot but then
 *      never sees the *post* frame land, so the transition either does
 *      nothing or animates the wrong direction. Making this the wrapper's
 *      responsibility is safer than relying on every caller to remember.
 *
 * We intentionally do **not** wire this into every state setter. Radix
 * dialogs, sonner toasts, and Framer-driven components already animate
 * themselves — layering View Transitions on top would double-animate.
 * Reserve this for hard-cut React swaps where the browser has no other way
 * to interpolate the two frames (tab switch, sub-agent expand, workspace
 * change, etc.).
 */

import { flushSync } from 'react-dom'

type StartViewTransitionFn = (callback: () => void) => { finished: Promise<void> }

function getStartFn(): StartViewTransitionFn | undefined {
  if (typeof document === 'undefined') return undefined
  const fn = (document as unknown as { startViewTransition?: unknown }).startViewTransition
  return typeof fn === 'function' ? (fn.bind(document) as StartViewTransitionFn) : undefined
}

/**
 * Run `fn` inside a browser view transition when supported, otherwise call it
 * directly. `fn` is always executed synchronously inside `flushSync` when a
 * transition is available so React commits before the browser captures the
 * post-state screenshot.
 */
export function withViewTransition(fn: () => void): void {
  const start = getStartFn()
  if (!start) {
    fn()
    return
  }
  start(() => {
    flushSync(fn)
  })
}

/**
 * Cheap capability check, exposed for callers that want to gate related UX
 * (e.g. show a longer intro animation only if the browser can't cross-fade).
 */
export function supportsViewTransitions(): boolean {
  return getStartFn() !== undefined
}
