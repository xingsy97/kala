import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../../lib/utils.js'
import { EmptyRow, SectionHeader } from '../controls.js'

export function AgentSection({
  payload,
  onPayloadChange,
}: {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const agentPrompt = payload.agentPrompt
  const [customPrompt, setCustomPrompt] = useState(agentPrompt?.customPrompt ?? '')
  useEffect(() => setCustomPrompt(agentPrompt?.customPrompt ?? ''), [agentPrompt?.customPrompt])

  const updatePreset = useMutation({
    mutationFn: async ({ preset, customPrompt }: { preset: string; customPrompt?: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/agent-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset, ...(customPrompt !== undefined ? { customPrompt } : {}) }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div>
      <SectionHeader title={t('settings.sections.agent.label')} subtitle={t('settings.agent.subtitle')} />
      {!agentPrompt ? (
        <EmptyRow>{t('settings.agent.unavailable')}</EmptyRow>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {agentPrompt.presets.map((preset) => {
              const selected = preset.id === agentPrompt.selectedPreset
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={cn(
                    'min-h-28 rounded-md border p-4 text-left transition-colors',
                    selected
                      ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                      : 'border-border bg-card/60 hover:bg-accent/60',
                  )}
                  onClick={() => {
                    setError(null)
                    if (!selected) updatePreset.mutate({ preset: preset.id })
                  }}
                  disabled={updatePreset.isPending}
                  data-testid={`settings-agent-preset-${preset.id}`}
                  aria-pressed={selected}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-foreground">{preset.label}</div>
                    {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{preset.description}</p>
                </button>
              )
            })}
          </div>
          {agentPrompt.selectedPreset === 'custom' ? (
            <div className="space-y-2">
              <label htmlFor="settings-agent-custom-prompt" className="text-sm font-medium text-foreground">{t('settings.agent.customPrompt')}</label>
              <textarea
                id="settings-agent-custom-prompt"
                data-testid="settings-agent-custom-prompt"
                className="min-h-64 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.target.value)}
                disabled={updatePreset.isPending}
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  disabled={updatePreset.isPending || !customPrompt.trim() || customPrompt === agentPrompt.customPrompt}
                  onClick={() => {
                    setError(null)
                    updatePreset.mutate({ preset: 'custom', customPrompt })
                  }}
                  data-testid="settings-agent-custom-prompt-save"
                >
                  {updatePreset.isPending ? t('settings.agent.saving') : t('settings.agent.savePrompt')}
                </button>
              </div>
            </div>
          ) : null}
          {error ? <div className="text-xs text-destructive">{error}</div> : null}
          <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground ring-1 ring-border/50">
            <div>{t('settings.agent.appliesToNewSessions')}</div>
            <div className="mt-1 break-all font-mono">{agentPrompt.configPath}</div>
          </div>
        </div>
      )}
    </div>
  )
}
