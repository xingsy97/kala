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
}: {
  activeTab: RightPanelTab
  onTabChange(tab: RightPanelTab): void
  onCollapse(): void
  files: ReactNode
  git: ReactNode
  terminal: ReactNode
  inspector: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground" data-testid="right-panel">
      <div className="grid h-11 flex-none grid-cols-[repeat(4,minmax(0,1fr))_2.5rem] items-center border-b border-border/50 px-1" role="tablist">
        <TabButton active={activeTab === 'files'} onClick={() => onTabChange('files')} icon={<Files className="h-3.5 w-3.5" />} label="Files" testId="right-panel-files-tab" />
        <TabButton active={activeTab === 'git'} onClick={() => onTabChange('git')} icon={<GitBranch className="h-3.5 w-3.5" />} label="Git" testId="right-panel-git-tab" />
        <TabButton active={activeTab === 'terminal'} onClick={() => onTabChange('terminal')} icon={<SquareTerminal className="h-3.5 w-3.5" />} label={t('rightPanel.terminal')} testId="right-panel-terminal-tab" />
        <TabButton active={activeTab === 'inspector'} onClick={() => onTabChange('inspector')} icon={<Bug className="h-3.5 w-3.5" />} label={t('rightPanel.inspector')} testId="right-panel-inspector-tab" />
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onCollapse} title={t('rightPanel.collapse')} aria-label={t('rightPanel.collapse')} data-testid="right-panel-collapse"><PanelRightClose className="h-4 w-4" /></Button>
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
  return <div className={cn('absolute inset-0 min-h-0 overflow-hidden', !active && 'invisible pointer-events-none')} aria-hidden={!active} data-testid={testId}>{children}</div>
}

function TabButton({ active, onClick, icon, label, testId }: { active: boolean; onClick(): void; icon: ReactNode; label: string; testId: string }): JSX.Element {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} data-testid={testId} className={cn('inline-flex h-10 min-w-0 items-center justify-center gap-1 border-b-2 px-1 text-[11px] transition-colors', active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>{icon}{label}</button>
}
