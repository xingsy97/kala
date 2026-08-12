import { useEffect, useState, type FormEvent } from 'react'
import {
  Bell,
  Blocks,
  Bot,
  Cable,
  Cpu,
  ChevronDown,
  KeyRound,
  Search,
  Palette,
  PlugZap,
  Rocket,
  ServerCog,
  Shield,
  SlidersHorizontal,
  TerminalSquare,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AttachedExecutor, ServerSettingsPayload } from '@agent-kernel/shared'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import type { DurableSessionViewCache } from '../../durable-session-cache.js'
import { SettingsSectionButton } from './controls.js'
import { AgentSection } from './sections/AgentSection.js'
import { ApprovalsSection } from './sections/ApprovalsSection.js'
import { ConnectionSection } from './sections/ConnectionSection.js'
import { DeploymentSection } from './sections/DeploymentSection.js'
import { ExecutorAccessSection } from './sections/ExecutorAccessSection.js'
import { HooksSection } from './sections/HooksSection.js'
import { InterfaceSection } from './sections/InterfaceSection.js'
import { McpSection } from './sections/McpSection.js'
import { ModelsSection } from './sections/ModelsSection.js'
import { NotificationsSection } from './sections/NotificationsSection.js'
import { RuntimeSection } from './sections/RuntimeSection.js'
import { SecuritySection } from './sections/SecuritySection.js'
import { SocketAdminSection } from './sections/SocketAdminSection.js'
import { WebSearchSection } from './sections/WebSearchSection.js'


type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  onModelsChanged?(): void
  executors?: readonly AttachedExecutor[]
  sessionCache?: DurableSessionViewCache
}

type SectionKey = 'runtime' | 'connection' | 'agent' | 'models' | 'webSearch' | 'security' | 'socketAdmin' | 'executorAccess' | 'approvals' | 'hooks' | 'mcp' | 'interface' | 'deployment' | 'notifications'

type SectionGroup = 'personal' | 'workspace' | 'agent' | 'administration'
const SECTION_GROUPS: readonly SectionGroup[] = ['personal', 'workspace', 'agent', 'administration']
const SECTIONS: readonly { key: SectionKey; label: string; hint: string; icon: LucideIcon; group: SectionGroup }[] = [
  { key: 'interface', label: 'settings.sections.interface.label', hint: 'settings.sections.interface.hint', icon: Palette, group: 'personal' },
  { key: 'notifications', label: 'settings.sections.notifications.label', hint: 'settings.sections.notifications.hint', icon: Bell, group: 'personal' },
  { key: 'executorAccess', label: 'settings.sections.executorAccess.label', hint: 'settings.sections.executorAccess.hint', icon: TerminalSquare, group: 'workspace' },
  { key: 'agent', label: 'settings.sections.agent.label', hint: 'settings.sections.agent.hint', icon: Bot, group: 'agent' },
  { key: 'models', label: 'settings.sections.models.label', hint: 'settings.sections.models.hint', icon: Cpu, group: 'agent' },
  { key: 'webSearch', label: 'settings.sections.webSearch.label', hint: 'settings.sections.webSearch.hint', icon: Search, group: 'agent' },
  { key: 'approvals', label: 'settings.sections.approvals.label', hint: 'settings.sections.approvals.hint', icon: KeyRound, group: 'agent' },
  { key: 'connection', label: 'settings.sections.connection.label', hint: 'settings.sections.connection.hint', icon: Cable, group: 'administration' },
  { key: 'security', label: 'settings.sections.security.label', hint: 'settings.sections.security.hint', icon: Shield, group: 'administration' },
  { key: 'socketAdmin', label: 'settings.sections.socketAdmin.label', hint: 'settings.sections.socketAdmin.hint', icon: ServerCog, group: 'administration' },
  { key: 'hooks', label: 'settings.sections.hooks.label', hint: 'settings.sections.hooks.hint', icon: PlugZap, group: 'administration' },
  { key: 'runtime', label: 'settings.sections.runtime.label', hint: 'settings.sections.runtime.hint', icon: SlidersHorizontal, group: 'administration' },
  { key: 'deployment', label: 'settings.sections.deployment.label', hint: 'settings.sections.deployment.hint', icon: Rocket, group: 'administration' },
  { key: 'mcp', label: 'settings.sections.mcp.label', hint: 'settings.sections.mcp.hint', icon: Blocks, group: 'administration' },
]

export function SettingsDialog({ open, onOpenChange, onModelsChanged, executors = [], sessionCache }: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionKey>('connection')
  const activeSection = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0]!
  const ActiveSectionIcon = activeSection.icon

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async (): Promise<ServerSettingsPayload> => {
      const r = await fetch('/settings', { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as ServerSettingsPayload
    },
    enabled: open,
    staleTime: 30_000,
  })
  const payload = settingsQuery.data ?? null
  const loadError = settingsQuery.error ? (settingsQuery.error as Error).message : null

  const applyPayload = (next: ServerSettingsPayload): void => {
    queryClient.setQueryData(['settings'], next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(dialogMobileSheetClassName, 'h-auto grid-rows-[auto_minmax(0,1fr)] border-x-0 border-border bg-background text-foreground shadow-2xl sm:h-[min(90dvh,44rem)] sm:max-w-4xl sm:border-x [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_select]:border-border [&_select]:bg-background [&_select]:text-foreground [&_table]:bg-muted/20 [&_td]:text-foreground [&_textarea]:border-border [&_textarea]:bg-background [&_textarea]:text-foreground [&_th]:bg-muted/50 [&_th]:text-foreground')}
        data-testid="settings-dialog"
      >
        <DialogHeader className="relative min-h-[4.5rem] justify-center border-b border-border bg-card px-4 py-2 pr-14 md:min-h-0 md:px-5 md:py-3 md:pr-14">
          <div className="md:hidden">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('settings.title')}</div>
            <label className="relative mt-0.5 inline-flex max-w-[calc(100vw-5rem)] items-center gap-2 pr-6" data-testid="settings-mobile-section-picker">
              <span className="sr-only">{t('settings.sectionsLabel')}</span>
              <ActiveSectionIcon className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
              <span className="truncate text-lg font-semibold leading-6 text-foreground">{t(activeSection.label)}</span>
              <ChevronDown className="pointer-events-none absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <select
                value={section}
                onChange={(event) => setSection(event.target.value as SectionKey)}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                aria-label={t('settings.sectionsLabel')}
                data-testid="settings-mobile-section-select"
              >
                {SECTIONS.map((item) => <option key={item.key} value={item.key}>{t(item.label)}</option>)}
              </select>
            </label>
          </div>
          <div className="hidden md:block">
            <DialogTitle className="text-base font-semibold text-foreground">{t('settings.title')}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('settings.description')}
            </DialogDescription>
          </div>
          <DialogClose
            className={dialogTouchCloseClassName}
            aria-label={t('common.close')}
            data-testid="settings-dialog-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div className="grid min-h-0 min-w-0 md:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 min-w-0 border-border bg-sidebar md:!block md:border-r">
            <nav className="h-full space-y-1 overflow-x-hidden overflow-y-auto p-3" aria-label={t('settings.sectionsLabel')}>
              {SECTION_GROUPS.map((group) => (
                <div key={group} className="space-y-1" data-testid={`settings-group-${group}`}>
                  <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/45 first:pt-0">
                    {t(`settings.groups.${group}`)}
                  </div>
                  {SECTIONS.filter((item) => item.group === group).map((item) => (
                    <SettingsSectionButton key={item.key} section={item} active={section === item.key} onClick={() => setSection(item.key)} />
                  ))}
                </div>
              ))}
            </nav>
          </aside>
          <ScrollArea
            className="min-h-0 min-w-0 max-w-full overflow-x-hidden bg-background"
            viewportClassName="[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0 [&>div]:!max-w-full"
          >
            <div className="mx-auto min-w-0 max-w-2xl overflow-x-hidden px-4 py-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] text-foreground md:max-w-full md:p-7" data-testid="settings-responsive-content">
              {loadError ? (
                <div className="rounded-md border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
                  <p>{t('settings.loadFailed', { error: loadError })}</p>
                  <button
                    type="button"
                    className="mt-3 rounded-md border border-red-300/50 px-3 py-1.5 text-sm font-medium hover:bg-red-500/10"
                    onClick={() => { void settingsQuery.refetch() }}
                  >
                    {t('common.reload')}
                  </button>
                </div>
              ) : payload === null ? (
                <div className="text-sm text-muted-foreground" role="status" aria-live="polite">{t('common.loading')}</div>
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'connection' ? (
                <ConnectionSection />
              ) : section === 'agent' ? (
                <AgentSection payload={payload} onPayloadChange={applyPayload} />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} onPayloadChange={applyPayload} onModelsChanged={onModelsChanged} />
              ) : section === 'webSearch' ? (
                <WebSearchSection />
              ) : section === 'security' ? (
                <SecuritySection payload={payload} />
              ) : section === 'socketAdmin' ? (
                <SocketAdminSection payload={payload} onPayloadChange={applyPayload} />
              ) : section === 'executorAccess' ? (
                <ExecutorAccessSection executors={executors} />
              ) : section === 'approvals' ? (
                <ApprovalsSection />
              ) : section === 'hooks' ? (
                <HooksSection payload={payload} />
              ) : section === 'interface' ? (
                <InterfaceSection sessionCache={sessionCache} />
              ) : section === 'deployment' ? (
                <DeploymentSection payload={payload} executors={executors} />
              ) : section === 'notifications' ? (
                <NotificationsSection />
              ) : (
                <McpSection payload={payload} />
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Web Push (background) subscription toggle. Sits below the foreground
 * desktop-notification prefs and reuses the same per-kind toggles so the
 * server dispatches the same categories the user already opted in to.
 *
 * Kept separate from DesktopNotificationsSettings because feature detection,
 * subscription state, and iOS-standalone gating are all specific to Push
 * and would clutter the foreground path.
 */

