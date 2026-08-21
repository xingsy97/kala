import type { ReactNode } from 'react'

import { cn } from '../../lib/utils.js'

export function ProductPage({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }): JSX.Element {
  return <main className={cn('ak-workspace-canvas flex h-full min-h-0 flex-col overflow-auto', className)} data-testid={testId}>{children}</main>
}

export function ProductPageHeader({ eyebrow = 'Agent RunLab', title, description, actions, titleTestId }: { eyebrow?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode; titleTestId?: string }): JSX.Element {
  return (
    <header className="mx-auto flex w-full max-w-[96rem] flex-none flex-col gap-4 px-4 pb-4 pt-5 sm:px-6 sm:pt-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary/80">{eyebrow}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em]" data-testid={titleTestId}>{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="w-full lg:w-auto">{actions}</div> : null}
    </header>
  )
}

export function ProductPageBody({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('mx-auto min-h-[32rem] w-full max-w-[96rem] flex-1 px-3 pb-6 sm:px-6 lg:px-8', className)}>{children}</div>
}

export function ProductPanel({ children, active = true, testId, className }: { children: ReactNode; active?: boolean; testId?: string; className?: string }): JSX.Element {
  return <section className={cn('ak-workspace-surface h-full min-h-0 flex-col overflow-hidden', active ? 'flex' : 'hidden', className)} data-testid={testId}>{children}</section>
}

export function ProductPanelHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-none items-start justify-between gap-4 border-b border-border/35 px-5 py-4 sm:px-6">
      <div className="min-w-0"><h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>{description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}</div>
      {actions}
    </div>
  )
}

export function ProductSegmentedControl({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <div className="ak-segmented-control grid w-full grid-cols-2 sm:w-auto sm:min-w-80" role="group" aria-label={label}>{children}</div>
}

export function ProductSegment({ active, onClick, testId, children }: { active: boolean; onClick(): void; testId?: string; children: ReactNode }): JSX.Element {
  return <button type="button" aria-pressed={active} onClick={onClick} data-testid={testId} className={cn('h-10 rounded-lg px-4 text-sm font-medium transition-[background-color,color,box-shadow]', active ? 'bg-card text-foreground shadow-sm ring-1 ring-border/40' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground')}>{children}</button>
}
