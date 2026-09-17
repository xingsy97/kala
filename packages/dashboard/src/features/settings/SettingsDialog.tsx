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
import { ProductState } from '../../components/ui/product-state.js'
import type { DurableSessionViewCache } from '../../durable-session-cache.js'
import { SettingsSectionButton, SettingsSectionHelpContext } from './controls.js'
import { HelpHint } from '../../components/ui/help-hint.js'
import { useMinWidth } from '../../app-logic/use-viewport.js'
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
  host?: string
  token?: string
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

export function SettingsDialog({ open, onOpenChange, onModelsChanged, executors = [], sessionCache, host = '', token }: Props): JSX.Element {
  const { t } = useTranslation()
  const desktopLayout = useMinWidth(768)
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionKey>('connection')
  const [sectionHelp, setSectionHelp] = useState<string>()
  const activeSection = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0]!

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
        className={cn(dialogMobileSheetClassName, 'h-auto grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] border-x-0 border-border/60 bg-background text-foreground shadow-2xl sm:h-[min(90dvh,46rem)] sm:max-w-5xl sm:overflow-hidden sm:rounded-2xl sm:border-x [&_input]:border-border [&_input]:bg-card/70 [&_input]:text-foreground [&_select]:border-border [&_select]:bg-card/70 [&_select]:text-foreground [&_table]:bg-muted/10 [&_td]:text-foreground [&_textarea]:border-border [&_textarea]:bg-card/70 [&_textarea]:text-foreground [&_th]:bg-muted/30 [&_th]:text-foreground')}
        data-testid="settings-dialog"
      >
        <DialogHeader className="relative min-h-[4.5rem] min-w-0 justify-center border-b border-border/40 bg-card/75 px-4 py-2 pr-14 backdrop-blur md:min-h-0 md:px-6 md:py-4 md:pr-14">
          <div className={desktopLayout ? 'hidden' : undefined}>
            <div className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('settings.title')}</div>
            <div className="flex min-w-0 items-center gap-1">
            <label className="relative mt-0.5 inline-flex min-w-0 max-w-full flex-1 items-center gap-2 pr-6" data-testid="settings-mobile-section-picker">
              <span className="sr-only">{t('settings.sectionsLabel')}</span>
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
            <HelpHint key={section} label={t(activeSection.label)}><span className="block">{t(activeSection.hint)}</span>{sectionHelp ? <span className="mt-2 block">{sectionHelp}</span> : null}</HelpHint>
            </div>
          </div>
          <div className={desktopLayout ? undefined : 'hidden'}>
            <DialogTitle className="flex items-center gap-1 text-base font-semibold text-foreground">{t('settings.title')}<HelpHint label={t('settings.title')}>{t('settings.description')}</HelpHint></DialogTitle>
          </div>
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <DialogClose
            className={dialogTouchCloseClassName}
            aria-label={t('common.close')}
            data-testid="settings-dialog-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div className={cn('grid min-h-0 min-w-0', desktopLayout && 'grid-cols-[14.5rem_minmax(0,1fr)]')}>
          <aside className={cn('min-h-0 min-w-0 border-r border-border/35 bg-muted/15', !desktopLayout && 'hidden')}>
            <nav className="h-full space-y-1 overflow-x-hidden overflow-y-auto px-3 py-4" aria-label={t('settings.sectionsLabel')}>
              {SECTION_GROUPS.map((group) => (
                <div key={group} className="space-y-1" data-testid={`settings-group-${group}`}>
                  <div className="px-3 pb-1.5 pt-4 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75 first:pt-0">
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
            className="ak-workspace-canvas min-h-0 min-w-0 max-w-full overflow-x-hidden"
            viewportClassName="[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0 [&>div]:!max-w-full"
          >
            <div className="mx-auto min-w-0 max-w-full overflow-x-hidden px-4 py-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] text-foreground md:max-w-3xl md:p-8" data-testid="settings-responsive-content">
              <SettingsSectionHelpContext.Provider value={setSectionHelp}>
              {loadError ? (
                <ProductState kind="error" title={t('settings.loadErrorTitle')} description={t('settings.loadFailed', { error: loadError })} primary={{ label: t('common.retry'), onClick: () => { void settingsQuery.refetch() } }} />
              ) : payload === null ? (
                <ProductState kind="loading" title={t('settings.loadingTitle')} description={t('settings.loadingDescription')} />
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
                <DeploymentSection payload={payload} executors={executors} host={host} token={token} />
              ) : section === 'notifications' ? (
                <NotificationsSection />
              ) : (
                <McpSection payload={payload} />
              )}
              </SettingsSectionHelpContext.Provider>
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
