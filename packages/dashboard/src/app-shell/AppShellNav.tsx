import { useTranslation } from 'react-i18next'
import { BarChart3, BookOpen, Bot, Boxes, Settings as SettingsIcon, Sparkles, Workflow } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../components/ui/button.js'
import { cn } from '../lib/utils.js'
import { LanguageSwitcher } from '../features/i18n/LanguageSwitcher.js'
import type { AppSection } from './section.js'

type NavItem = {
  id: AppSection
  labelKey: string
  Icon: typeof Bot
  testid: string
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'agent', labelKey: 'appShell.nav.agent', Icon: Bot, testid: 'app-shell-nav-agent' },
  { id: 'benchmarks', labelKey: 'appShell.nav.benchmarks', Icon: BarChart3, testid: 'app-shell-nav-benchmarks' },
  { id: 'operations', labelKey: 'appShell.nav.operations', Icon: Workflow, testid: 'app-shell-nav-operations' },
  { id: 'artifacts', labelKey: 'appShell.nav.artifacts', Icon: Boxes, testid: 'app-shell-nav-artifacts' },
  { id: 'pipeline', labelKey: 'appShell.nav.pipeline', Icon: Sparkles, testid: 'app-shell-nav-pipeline' },
  { id: 'docs', labelKey: 'appShell.nav.docs', Icon: BookOpen, testid: 'app-shell-nav-docs' },
]

export function AppShellNav({
  section,
  onSelect,
  onOpenSettings,
  connectionStatus,
}: {
  section: AppSection
  onSelect(section: AppSection): void
  onOpenSettings(): void
  connectionStatus?: ReactNode
}): JSX.Element {
  const { t } = useTranslation()

  return (
    <nav
      aria-label={t('appShell.nav.aria')}
      data-testid="app-shell-nav"
      className="sticky top-0 z-30 flex h-11 items-center gap-1 border-b border-border/60 bg-background/95 px-3 backdrop-blur"
    >
      <span className="mr-2 text-xs font-semibold tracking-wide text-muted-foreground">
        agent-kernel
      </span>
      {NAV_ITEMS.map(({ id, labelKey, Icon, testid }) => {
        const active = section === id
        return (
          <Button
            key={id}
            variant="ghost"
            size="sm"
            data-testid={testid}
            aria-current={active ? 'page' : undefined}
            title={t(labelKey)}
            onClick={() => onSelect(id)}
            className={cn(
              'h-8 gap-1.5 px-2.5 text-xs',
              active
                ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 flex-none" aria-hidden />
            <span>{t(labelKey)}</span>
          </Button>
        )
      })}
      <span className="ml-auto flex items-center gap-1">
        <LanguageSwitcher />
        <Button
          variant="ghost"
          size="icon"
          data-testid="app-shell-nav-settings-icon"
          onClick={onOpenSettings}
          title={t('app.openSettings')}
          aria-label={t('app.openSettings')}
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          <SettingsIcon className="h-4 w-4" aria-hidden />
        </Button>
        {connectionStatus}
      </span>
    </nav>
  )
}
