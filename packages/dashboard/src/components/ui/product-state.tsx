import type { ReactNode } from 'react'
import { AlertTriangle, CloudOff, Inbox, Loader2, LockKeyhole, ShieldAlert } from 'lucide-react'

import { cn } from '../../lib/utils.js'
import { Button } from './button.js'

export type ProductStateKind = 'loading' | 'empty' | 'offline' | 'unauthorized' | 'forbidden' | 'degraded' | 'error' | 'fatal'

export function ProductState({
  kind,
  title,
  description,
  detail,
  primary,
  secondary,
  className,
}: {
  kind: ProductStateKind
  title: string
  description: string
  detail?: ReactNode
  primary?: { label: string; onClick(): void }
  secondary?: { label: string; onClick(): void }
  className?: string
}): JSX.Element {
  const Icon = kind === 'loading' ? Loader2
    : kind === 'empty' ? Inbox
      : kind === 'offline' ? CloudOff
        : kind === 'unauthorized' ? LockKeyhole
          : kind === 'forbidden' ? ShieldAlert
            : AlertTriangle
  return (
    <section
      className={cn('mx-auto flex w-full max-w-lg flex-col items-center rounded-xl bg-card/70 px-5 py-8 text-center shadow-sm', className)}
      role={kind === 'loading' ? 'status' : 'alert'}
      aria-live={kind === 'loading' ? 'polite' : 'assertive'}
      data-product-state={kind}
    >
      <span className="grid h-11 w-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className={cn('h-5 w-5', kind === 'loading' && 'animate-spin')} aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {detail ? <div className="mt-3 w-full rounded-md bg-muted/60 p-3 text-left text-xs text-muted-foreground">{detail}</div> : null}
      {primary || secondary ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {primary ? <Button onClick={primary.onClick}>{primary.label}</Button> : null}
          {secondary ? <Button variant="outline" onClick={secondary.onClick}>{secondary.label}</Button> : null}
        </div>
      ) : null}
    </section>
  )
}
