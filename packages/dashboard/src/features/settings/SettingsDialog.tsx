import { useEffect, useState, type FormEvent } from 'react'
import {
  Bell,
  Blocks,
  Bot,
  Cable,
  Cpu,
  KeyRound,
  Palette,
  PlugZap,
  Rocket,
  ServerCog,
  Shield,
  SlidersHorizontal,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AttachedExecutor, ServerSettingsPayload } from '@agent-kernel/shared'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
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


type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  onModelsChanged?(): void
  executors?: readonly AttachedExecutor[]
  sessionCache?: DurableSessionViewCache
}

type SectionKey = 'runtime' | 'connection' | 'agent' | 'models' | 'security' | 'socketAdmin' | 'executorAccess' | 'approvals' | 'hooks' | 'mcp' | 'interface' | 'deployment' | 'notifications'

const SECTIONS: readonly { key: SectionKey; label: string; hint: string; icon: LucideIcon }[] = [
  { key: 'connection', label: 'settings.sections.connection.label', hint: 'settings.sections.connection.hint', icon: Cable },
  { key: 'agent', label: 'settings.sections.agent.label', hint: 'settings.sections.agent.hint', icon: Bot },
  { key: 'models', label: 'settings.sections.models.label', hint: 'settings.sections.models.hint', icon: Cpu },
  { key: 'approvals', label: 'settings.sections.approvals.label', hint: 'settings.sections.approvals.hint', icon: KeyRound },
  { key: 'executorAccess', label: 'settings.sections.executorAccess.label', hint: 'settings.sections.executorAccess.hint', icon: TerminalSquare },
  { key: 'interface', label: 'settings.sections.interface.label', hint: 'settings.sections.interface.hint', icon: Palette },
  { key: 'security', label: 'settings.sections.security.label', hint: 'settings.sections.security.hint', icon: Shield },
  { key: 'socketAdmin', label: 'settings.sections.socketAdmin.label', hint: 'settings.sections.socketAdmin.hint', icon: ServerCog },
  { key: 'hooks', label: 'settings.sections.hooks.label', hint: 'settings.sections.hooks.hint', icon: PlugZap },
  { key: 'runtime', label: 'settings.sections.runtime.label', hint: 'settings.sections.runtime.hint', icon: SlidersHorizontal },
  { key: 'deployment', label: 'settings.sections.deployment.label', hint: 'settings.sections.deployment.hint', icon: Rocket },
  { key: 'mcp', label: 'settings.sections.mcp.label', hint: 'settings.sections.mcp.hint', icon: Blocks },
  { key: 'notifications', label: 'settings.sections.notifications.label', hint: 'settings.sections.notifications.hint', icon: Bell },
]

export function SettingsDialog({ open, onOpenChange, onModelsChanged, executors = [], sessionCache }: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionKey>('connection')

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
        className="h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-0.5rem)] max-w-4xl overflow-hidden border-border bg-background p-0 text-foreground shadow-2xl gap-0 grid-rows-[auto_minmax(0,1fr)] sm:h-[min(90dvh,44rem)] [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_select]:border-border [&_select]:bg-background [&_select]:text-foreground [&_table]:bg-muted/20 [&_td]:text-foreground [&_textarea]:border-border [&_textarea]:bg-background [&_textarea]:text-foreground [&_th]:bg-muted/50 [&_th]:text-foreground"
        data-testid="settings-dialog"
      >
        <DialogHeader className="border-b border-border bg-card px-4 py-3 sm:px-5">
          <DialogTitle className="text-base font-semibold text-foreground">{t('settings.title')}</DialogTitle>
          <DialogDescription className="line-clamp-2 text-xs text-muted-foreground sm:line-clamp-none">
            {t('settings.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[200px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-h-0 min-w-0 border-b border-border bg-sidebar md:border-b-0 md:border-r">
            <nav className="flex w-full max-w-full gap-1 overflow-x-auto p-2 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:block md:h-full md:space-y-1 md:overflow-x-hidden md:overflow-y-auto md:p-3" aria-label={t('settings.sectionsLabel')}>
              {SECTIONS.map((s) => (
                <SettingsSectionButton key={s.key} section={s} active={section === s.key} onClick={() => setSection(s.key)} />
              ))}
            </nav>
          </aside>
          <ScrollArea
            className="min-h-0 min-w-0 max-w-full overflow-x-hidden bg-background"
            viewportClassName="[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0 [&>div]:!max-w-full"
          >
            <div className="min-w-0 max-w-full overflow-x-hidden p-4 text-foreground sm:p-7" data-testid="settings-responsive-content">
              {loadError ? (
                <div className="rounded-md border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {t('settings.loadFailed', { error: loadError })}
                </div>
              ) : payload === null ? (
                <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'connection' ? (
                <ConnectionSection />
              ) : section === 'agent' ? (
                <AgentSection payload={payload} onPayloadChange={applyPayload} />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} onPayloadChange={applyPayload} onModelsChanged={onModelsChanged} />
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

