import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import { SectionHeader, SettingsKeyValueList } from '../controls.js'

export function SecuritySection({ payload }: { payload: ServerSettingsPayload }): JSX.Element {
  const { t } = useTranslation()
  const auth = payload.auth
  const inviteCount = auth?.executorIdentity.inviteCount ?? 0
  const rows: Array<[string, string]> = auth
    ? [
        [t('settings.security.dashboardAuth'), auth.dashboardAuthRequired ? t('settings.security.required') : t('settings.security.notRequired')],
        [t('settings.security.githubOAuth'), auth.githubOAuth.required ? (auth.githubOAuth.configured ? t('settings.security.requiredConfigured') : t('settings.security.requiredIncomplete')) : t('settings.security.disabled')],
        [t('settings.security.githubWhitelist'), auth.githubOAuth.usernameWhitelistEnabled ? auth.githubOAuth.usernameWhitelist.join(', ') : t('settings.security.disabled')],
        [t('settings.security.executorIdentity'), auth.executorIdentity.tokenScoped ? t('settings.security.tokenScoped', { count: auth.executorIdentity.tokenCount }) : auth.executorIdentity.tokenCount > 0 ? t('settings.security.tokenProtected', { count: auth.executorIdentity.tokenCount }) : t('settings.security.inviteReady')],
        [t('settings.security.executorInvites'), t('settings.security.inviteCount', { count: inviteCount })],
      ]
    : [
        [t('settings.security.dashboardAuth'), t('settings.security.notRequired')],
        [t('settings.security.githubOAuth'), t('settings.security.disabled')],
        [t('settings.security.executorIdentity'), t('settings.security.inviteReady')],
      ]
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.security.label')}
        subtitle={t('settings.security.subtitle')}
      />
      <SettingsKeyValueList rows={rows.map(([label, value]) => ({
        label,
        value: <span className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{value}</span>,
      }))} />
      <div className="mt-4 rounded-md bg-muted/40 px-4 py-3 text-xs text-muted-foreground ring-1 ring-border/50">
        <div className="break-words font-mono">HOST_GITHUB_OAUTH_REQUIRED, GITHUB_USERNAME_WHITELIST, EXECUTOR_TOKENS, HOST_AUDIT_DIR</div>
      </div>
    </div>
  )
}
