import { GripVertical } from 'lucide-react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels'

import { cn } from '../../lib/utils.js'

export const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof PanelGroup>): JSX.Element => (
  <PanelGroup
    className={cn(
      'flex h-full w-full data-[panel-group-direction=vertical]:flex-col',
      className,
    )}
    {...props}
  />
)

export const ResizablePanel = Panel

export const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof PanelResizeHandle> & {
  withHandle?: boolean
}): JSX.Element => (
  <PanelResizeHandle
    className={cn(
      'relative flex w-px items-center justify-center bg-slate-200 dark:bg-slate-800 after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-sky-400 dark:hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90',
      className,
    )}
    {...props}
  >
    {withHandle ? (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
        <GripVertical className="h-2.5 w-2.5 text-slate-500" />
      </div>
    ) : null}
  </PanelResizeHandle>
)
