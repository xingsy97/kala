import type { LucideIcon } from 'lucide-react'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

/**
 * Shared, presentational Settings controls. Extracted from SettingsDialog so the
 * individual Section components can live in their own files without duplicating
 * these primitives. Pure UI — no settings state or side effects.
 */

/** Minimal shape a section tab button needs; avoids importing the SECTIONS registry. */
export type SettingsSectionInfo = { key: string; icon: LucideIcon }

export function SettingsSectionButton({
  section,
  active,
  onClick,
}: {
  section: SettingsSectionInfo
  active: boolean
  onClick(): void
}): JSX.Element {
  const { t } = useTranslation()
  const label = t(`settings.sections.${section.key}.label`)
  const hint = t(`settings.sections.${section.key}.hint`)
  const Icon = section.icon
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`settings-tab-${section.key}`}
      className={cn(
        'w-32 flex-none rounded-md px-3 py-2 text-left text-sm transition-colors sm:w-36 md:w-full',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-border'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn('h-4 w-4 flex-none', active ? 'text-sidebar-accent-foreground' : 'text-sidebar-foreground/60')} aria-hidden="true" />
        <div className="min-w-0 truncate font-medium">{label}</div>
      </div>
      <div className="mt-1 hidden truncate pl-6 text-[11px] text-sidebar-foreground/50 md:block">{hint}</div>
    </button>
  )
}

export function SectionHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}): JSX.Element {
  return (
    <div className="mb-6 min-w-0 border-b border-border pb-5">
      <h3 className="text-2xl font-semibold text-foreground">{title}</h3>
      {subtitle ? (
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

export function InterfaceToggle({
  label,
  description,
  checked,
  onChange,
  testId,
  disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange(next: boolean): void
  testId: string
  disabled?: boolean
}): JSX.Element {
  return (
    <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} testId={testId} disabled={disabled} />
    </li>
  )
}

export function Toggle({
  checked,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
}: {
  checked: boolean
  onChange(next: boolean): void
  ariaLabel: string
  testId?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

// ── Layout primitives shared by section bodies ────────────────────────────────

export function EmptyRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-white/15 bg-black/20 px-4 py-6 text-sm text-zinc-400">
      {children}
    </div>
  )
}

export function SettingsKeyValueList({
  rows,
  testId,
}: {
  rows: readonly { label: string; value: React.ReactNode }[]
  testId?: string
}): JSX.Element {
  return (
    <dl className="overflow-hidden rounded-md ring-1 ring-border/50" data-testid={testId}>
      {rows.map((row, index) => (
        <div
          key={row.label}
          className={cn(
            'grid min-w-0 gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(8rem,0.42fr)_minmax(0,1fr)] sm:items-center sm:gap-4',
            index !== rows.length - 1 && 'border-b border-border/50',
          )}
        >
          <dt className="text-xs font-medium text-muted-foreground sm:text-sm sm:text-foreground">{row.label}</dt>
          <dd className="min-w-0 text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SettingsRecordList({
  children,
  testId,
  className,
}: {
  children: React.ReactNode
  testId?: string
  className?: string
}): JSX.Element {
  return (
    <div className={cn('grid min-w-0 gap-2', className)} data-testid={testId}>
      {children}
    </div>
  )
}

export function SettingsRecord({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-muted/20 p-3 ring-1 ring-border/50">
      <div className="min-w-0 border-b border-border/40 pb-2">
        <div className="break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">{title}</div>
        {detail ? <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{detail}</div> : null}
      </div>
      <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2">{children}</dl>
    </div>
  )
}

export function SettingsRecordField({
  label,
  mono = false,
  children,
}: {
  label: string
  mono?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(6rem,0.42fr)_minmax(0,1fr)] items-baseline gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-foreground [overflow-wrap:anywhere]', mono && 'font-mono')}>{children}</dd>
    </div>
  )
}

export function CopyButton({ value }: { value: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Non-fatal — clipboard permission denied.
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-none text-zinc-400 hover:bg-white/10 hover:text-zinc-50"
      aria-label={copied ? t('settings.copy.copied') : t('settings.copy.copyValue')}
      onClick={() => {
        void copy()
      }}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  )
}
