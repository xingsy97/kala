import { BadCasesTab } from './BadCasesTab.js'

export function BadCasesView(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-badcases">
      <BadCasesTab />
    </div>
  )
}
