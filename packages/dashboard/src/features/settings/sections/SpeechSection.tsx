import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { HelpHint } from '../../../components/ui/help-hint.js'
import {
  DEFAULT_AZURE_SPEECH_ENDPOINT,
  loadSpeechSettings,
  SPEECH_SETTINGS_CHANGED_EVENT,
  type SpeechTranscriptionMode,
  type SpeechSettings,
} from '../../voice/speech-api.js'
import { SectionHeader, Toggle } from '../controls.js'
import { responseError } from '../section-utils.js'

export function SpeechSection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<SpeechSettings | null>(null)
  const [endpoint, setEndpoint] = useState(DEFAULT_AZURE_SPEECH_ENDPOINT)
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState<SpeechTranscriptionMode>('realtime')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSpeechSettings().then((next) => {
      if (cancelled) return
      setSettings(next)
      setEndpoint(next.endpoint)
      setEnabled(next.configured ? next.enabled : true)
      setMode(next.mode)
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!settings?.configured && !apiKey.trim()) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/speech', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: endpoint.trim(),
          enabled,
          mode,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const next = (await response.json()) as SpeechSettings
      setSettings(next)
      setEndpoint(next.endpoint)
      setApiKey('')
      setMessage(t('settings.speech.saved'))
      window.dispatchEvent(new Event(SPEECH_SETTINGS_CHANGED_EVENT))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/speech/test', { method: 'POST' })
      if (!response.ok) throw new Error(await responseError(response))
      setMessage(t('settings.speech.testSucceeded'))
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/settings/speech', { method: 'DELETE' })
      if (!response.ok) throw new Error(await responseError(response))
      const next = (await response.json()) as SpeechSettings
      setSettings(next)
      setEndpoint(next.endpoint)
      setEnabled(true)
      setMode('realtime')
      setApiKey('')
      setMessage(t('settings.speech.removed'))
      window.dispatchEvent(new Event(SPEECH_SETTINGS_CHANGED_EVENT))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="settings-speech-section">
      <SectionHeader title={t('settings.sections.speech.label')} subtitle={t('settings.speech.info')} />
      {loading ? (
        <div className="text-sm text-muted-foreground" role="status">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-border/60 bg-card/60 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{t('settings.speech.status')}</div>
                <p className="mt-1 text-xs text-muted-foreground" data-testid="settings-speech-status">
                  {!isSecureVoiceContext()
                    ? t('settings.speech.insecureStatus')
                    : settings?.configured ? t('settings.speech.configured') : t('settings.speech.notConfigured')}
                  {isSecureVoiceContext() && settings?.updatedAt
                    ? ` · ${t('settings.speech.updatedAt', { date: new Date(settings.updatedAt).toLocaleString(i18n.language) })}`
                    : ''}
                </p>
                {!isSecureVoiceContext() ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="settings-speech-https-required">
                    {t('settings.speech.insecureDetail')}
                  </p>
                ) : null}
              </div>
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                ariaLabel={t('settings.speech.enable')}
                testId="settings-speech-enabled"
              />
            </div>
          </div>

          <form className="space-y-4 rounded-xl border border-border/60 bg-card/60 p-4" onSubmit={(event) => { void save(event) }}>
            <label className="block text-sm font-medium" htmlFor="settings-speech-provider">
              {t('settings.speech.provider')}
            </label>
            <select id="settings-speech-provider" className="h-9 w-full rounded-md border px-3 text-sm" value="azure" disabled>
              <option value="azure">Azure Speech</option>
            </select>

            <label className="flex items-center gap-1 text-sm font-medium" htmlFor="settings-speech-mode">
              {t('settings.speech.mode')}
              <HelpHint label={t('settings.speech.mode')}>{t('settings.speech.modeInfo')}</HelpHint>
            </label>
            <select
              id="settings-speech-mode"
              data-testid="settings-speech-mode"
              className="h-9 w-full rounded-md border px-3 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as SpeechTranscriptionMode)}
            >
              <option value="realtime">{t('settings.speech.modeRealtime')}</option>
              <option value="after_recording">{t('settings.speech.modeAfterRecording')}</option>
            </select>

            <label className="flex items-center gap-1 text-sm font-medium" htmlFor="settings-speech-endpoint">
              {t('settings.speech.endpoint')}
              <HelpHint label={t('settings.speech.endpoint')}>{t('settings.speech.endpointHint')}</HelpHint>
            </label>
            <input
              id="settings-speech-endpoint"
              data-testid="settings-speech-endpoint"
              type="url"
              spellCheck={false}
              className="h-9 w-full rounded-md border px-3 font-mono text-sm"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />

            <label className="flex items-center gap-1 text-sm font-medium" htmlFor="settings-speech-api-key">
              {t('settings.speech.apiKey')}
              <HelpHint label={t('settings.speech.apiKey')}>{t('settings.speech.apiKeyHint')}</HelpHint>
            </label>
            <input
              id="settings-speech-api-key"
              data-testid="settings-speech-api-key"
              type="password"
              autoComplete="new-password"
              className="h-9 w-full rounded-md border px-3 text-sm"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={settings?.configured ? t('settings.speech.apiKeyConfiguredPlaceholder') : t('settings.speech.apiKeyPlaceholder')}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !endpoint.trim() || (!settings?.configured && !apiKey.trim())} data-testid="settings-speech-save">
                {t('common.save')}
              </Button>
              <Button type="button" variant="outline" disabled={busy || !settings?.configured} onClick={() => { void testConnection() }} data-testid="settings-speech-test">
                {t('settings.speech.test')}
              </Button>
              {settings?.configured ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => { void remove() }} data-testid="settings-speech-delete">
                  {t('settings.speech.remove')}
                </Button>
              ) : null}
            </div>
          </form>

          {error ? <p className="text-sm text-destructive" role="alert">{t('settings.speech.requestFailed', { error })}</p> : null}
          {message ? <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">{message}</p> : null}
        </div>
      )}
    </div>
  )
}

function isSecureVoiceContext(): boolean {
  return typeof window === 'undefined' || window.isSecureContext !== false
}
