import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { SectionHeader } from '../controls.js'

export function McpSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.mcp.label')}
        subtitle={t('settings.mcp.subtitle')}
      />
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="mb-1 font-medium text-foreground">{t('settings.mcp.notImplemented')}</div>
        <p className="text-muted-foreground">{payload.mcp.note}</p>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        {t('settings.mcp.body')}
      </p>
      <div className="mt-4 flex items-center gap-2 text-sm">
        <a
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Model Context Protocol
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}
