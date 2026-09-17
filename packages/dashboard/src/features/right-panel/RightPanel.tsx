import type { ReactNode } from 'react'
import { Bug, Files, GitBranch, PanelRightClose, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

export type RightPanelTab = 'files' | 'git' | 'terminal' | 'inspector'

export function RightPanel({
  activeTab,
  onTabChange,
  onCollapse,
  files,
  git,
  terminal,
  inspector,
  headerHelp,
}: {
  activeTab: RightPanelTab
  onTabChange(tab: RightPanelTab): void
  onCollapse(): void
  files: ReactNode
  git: ReactNode
  terminal: ReactNode
  inspector: ReactNode
  headerHelp?: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col bg-card/80 text-card-foreground" data-testid="right-panel">
      <div className="flex h-14 min-w-0 flex-none items-center gap-1 overflow-hidden border-b border-border/35 bg-card/70 px-2 backdrop-blur sm:h-12">
        <div className="ak-segmented-control grid min-w-0 flex-1 grid-cols-4 gap-0.5" data-testid="right-panel-tabs" role="tablist" aria-label={t('rightPanel.tools')}>
          <TabButton active={activeTab === 'files'} onClick={() => onTabChange('files')} icon={<Files className="h-3.5 w-3.5" />} label={t('rightPanel.files')} testId="right-panel-files-tab" />
          <TabButton active={activeTab === 'git'} onClick={() => onTabChange('git')} icon={<GitBranch className="h-3.5 w-3.5" />} label={t('rightPanel.git')} testId="right-panel-git-tab" />
          <TabButton active={activeTab === 'terminal'} onClick={() => onTabChange('terminal')} icon={<SquareTerminal className="h-3.5 w-3.5" />} label={t('rightPanel.terminal')} testId="right-panel-terminal-tab" />
          <TabButton active={activeTab === 'inspector'} onClick={() => onTabChange('inspector')} icon={<Bug className="h-3.5 w-3.5" />} label={t('rightPanel.inspector')} testId="right-panel-inspector-tab" />
        </div>
        {headerHelp}
        <span className="ml-1 h-5 w-px flex-none bg-border/40" aria-hidden="true" />
        <Button variant="ghost" size="icon" className="h-11 w-11 flex-none rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground sm:h-8 sm:w-8" onClick={onCollapse} title={t('rightPanel.collapse')} aria-label={t('rightPanel.collapse')} data-testid="right-panel-collapse"><PanelRightClose className="h-4 w-4" /></Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <PanelContent active={activeTab === 'files'} testId="right-panel-files-content">{files}</PanelContent>
        <PanelContent active={activeTab === 'git'} testId="right-panel-git-content">{git}</PanelContent>
        <PanelContent active={activeTab === 'terminal'} testId="right-panel-terminal-content">{terminal}</PanelContent>
        <PanelContent active={activeTab === 'inspector'} testId="right-panel-inspector-content">{inspector}</PanelContent>
      </div>
    </div>
  )
}

function PanelContent({ active, testId, children }: { active: boolean; testId: string; children: ReactNode }): JSX.Element {
  // Keep inactive tools mounted so terminal processes and file state survive tab
  // switches, but remove their entire subtree from layout and hit testing.
  // `visibility: hidden` is insufficient because descendants may explicitly set
  // `visibility: visible`, which previously left Inspector covering Terminal.
  return <div className={cn('absolute inset-0 min-h-0 overflow-hidden', !active && 'hidden')} aria-hidden={!active} data-testid={testId}>{children}</div>
}

function TabButton({ active, onClick, icon, label, testId }: { active: boolean; onClick(): void; icon: ReactNode; label: string; testId: string }): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-11 w-full min-w-0 items-center justify-center gap-1 rounded-lg px-1 text-[0.6875rem] font-medium transition-all sm:h-8 sm:px-1.5',
        active
          ? 'bg-card text-foreground shadow-sm ring-1 ring-border/45'
          : 'text-muted-foreground hover:bg-card/55 hover:text-foreground',
      )}
    >
      {icon}<span className="truncate">{label}</span>
    </button>
  )
}
