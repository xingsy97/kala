/**
 * Thin wrapper around `sonner` so the rest of the app never imports it directly.
 * The intent is dual:
 *
 *   1. Semantic vocabulary — `info | success | warning | error` maps 1:1 to the
 *      four sonner variants but with a `NotifyOpts` shape we control. Anything
 *      sonner-specific stays here.
 *   2. Test seam — a single mock point (`vi.mock('./notify.js')`) lets tests
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

import { createElement } from 'react'
import { toast, type ExternalToast } from 'sonner'

export type NotifyOpts = {
  description?: string
  action?: { label: string; onClick: () => void }
  /** Make the toast message a keyboard-accessible click target. */
  onClick?: () => void
  /** ms; undefined uses sonner's default (~4s); Infinity keeps it until closed. */
  duration?: number
  /** Stable id — repeats replace the previous toast in-place. */
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

function toastTitle(message: string, opts?: NotifyOpts) {
  return opts?.onClick
    ? createElement('button', {
      type: 'button',
      className: 'pointer-events-auto -mx-3 -my-2 block w-[calc(100%+1.5rem)] px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      onClick: opts.onClick,
    }, message)
    : message
}

export const notify = {
  info(message: string, opts?: NotifyOpts): void {
    toast.info(message, toSonnerOpts(opts))
  },
  success(message: string, opts?: NotifyOpts): void {
    toast.success(toastTitle(message, opts), toSonnerOpts(opts))
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
