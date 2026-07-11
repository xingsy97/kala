import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { RunBenchmarkWizard } from '../artifacts/RunBenchmarkWizard.js'

export function RunBenchmarkWizardModal({
  open,
  onOpenChange,
  onCompleted,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onCompleted?(): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        data-testid="run-benchmark-wizard-modal"
      >
        <DialogHeader>
          <DialogTitle>{t('benchmarks.wizardModal.title')}</DialogTitle>
          <DialogDescription>{t('benchmarks.wizardModal.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="p-1">
            <RunBenchmarkWizard onArtifactActionComplete={onCompleted} />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
