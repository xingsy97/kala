/**
 * Thin wrapper around `sonner` so the rest of the app never imports it directly.
 * The intent is dual:
 *
 *   1. Semantic vocabulary  -  `info | success | warning | error` maps 1:1 to the
 *      four sonner variants but with a `NotifyOpts` shape we control. Anything
 *      sonner-specific stays here.
 *   2. Test seam  -  a single mock point (`vi.mock('./notify.js')`) lets tests
 *      assert on notification calls without stubbing the whole sonner module.
 *
 * Dedup: pass `id` and sonner will replace an existing toast with the same id
 * rather than stacking a duplicate. Use it for events that can fire repeatedly
 * for the same underlying condition (e.g. approval-required for the same
 * callId, or a shell that toggles running/done a few times during teardown).
 *
 * The parent app is responsible for mounting `<Toaster>` once at the root
 * (see [[App]]). This module never renders.
 */

import { toast, type ExternalToast } from 'sonner'

export type NotifyOpts = {
  description?: string
  action?: { label: string; onClick: () => void }
  /** ms; undefined uses sonner's default (~4s); Infinity keeps it until closed. */
  duration?: number
  /** Stable id  -  repeats replace the previous toast in-place. */
  id?: string
}

export type NotifyKind = 'info' | 'success' | 'warning' | 'error'

function toSonnerOpts(opts?: NotifyOpts): ExternalToast | undefined {
  if (!opts) return undefined
  const out: ExternalToast = {}
  if (opts.description !== undefined) out.description = opts.description
  if (opts.action) out.action = { label: opts.action.label, onClick: opts.action.onClick }
  if (opts.duration !== undefined) out.duration = opts.duration
  if (opts.id !== undefined) out.id = opts.id
  return out
}

export const notify = {
  info(message: string, opts?: NotifyOpts): void {
    toast.info(message, toSonnerOpts(opts))
  },
  success(message: string, opts?: NotifyOpts): void {
    toast.success(message, toSonnerOpts(opts))
  },
  warning(message: string, opts?: NotifyOpts): void {
    toast.warning(message, toSonnerOpts(opts))
  },
  error(message: string, opts?: NotifyOpts): void {
    toast.error(message, toSonnerOpts(opts))
  },
  dismiss(id?: string): void {
    if (id !== undefined) toast.dismiss(id)
    else toast.dismiss()
  },
}
