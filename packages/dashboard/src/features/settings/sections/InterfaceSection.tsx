import type { DurableSessionViewCache } from '../../../durable-session-cache.js'
import { Check, Eye, Loader2, Monitor, Moon, RefreshCw, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { useTheme } from '../../../lib/theme.js'
import { wakeLockSupported } from '../../../lib/wake-lock.js'
import {
  DEFAULT_CHAT_CONTENT_WIDTH,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_LINE_HEIGHT,
  DEFAULT_CHAT_MATH_SCALE,
  DEFAULT_CHAT_SIDE_SPACE,
  DEFAULT_FILE_EXPLORER_FONT_SIZE,
  DEFAULT_FILE_VIEW_FONT_SIZE,
  DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  DEFAULT_SESSION_EXPLORER_FONT_SIZE,
  PREF_CHAT_CONTENT_WIDTH,
  PREF_CHAT_FONT_SIZE,
  PREF_CHAT_LINE_HEIGHT,
  PREF_CHAT_MATH_SCALE,
  PREF_CHAT_SIDE_SPACE,
  PREF_DURABLE_SESSION_CACHE_ENABLED,
  PREF_EXPLORER_OPEN,
  PREF_FILE_EXPLORER_FONT_SIZE,
  PREF_FILE_VIEW_FONT_SIZE,
  PREF_INSPECTOR_OPEN,
  PREF_KEEP_SCREEN_AWAKE,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_SESSION_EXPLORER_FONT_SIZE,
  PREF_SHOW_TOOL_CALL_TAB,
  PREF_SMOOTH_STREAMING_TEXT,
  PREF_TOPBAR_OPEN,
  useBooleanPref,
  useNumberPref,
} from '../../../lib/prefs.js'
import { DEFAULT_SESSION_VIEW_CACHE_MAX_MB, PREF_SESSION_VIEW_CACHE_MAX_MB } from '../../../session-view-cache.js'
import {
  BUILTIN_VSCODE_THEMES,
  applyCurrentVSCodeTheme,
  applyVSCodeTheme,
  builtinThemeForScheme,
  readStoredVSCodeTheme,
  validateVSCodeTheme,
  writeStoredVSCodeTheme,
  type StoredVSCodeTheme,
} from '../../../theme/vscode-theme.js'
import { cn } from '../../../lib/utils.js'
import { InterfaceToggle, SectionHeader, Toggle } from '../controls.js'
import { formatBytes, responseError } from '../section-utils.js'

export function InterfaceSection({ sessionCache }: { sessionCache?: DurableSessionViewCache }): JSX.Element {
  const { t } = useTranslation()
  const [showToolCallTab, setShowToolCallTab] = useBooleanPref(PREF_SHOW_TOOL_CALL_TAB, true)
  const [explorerOpen, setExplorerOpen] = useBooleanPref(PREF_EXPLORER_OPEN, true)
  const [inspectorOpen, setInspectorOpen] = useBooleanPref(PREF_INSPECTOR_OPEN, true)
  const [topbarOpen, setTopbarOpen] = useBooleanPref(PREF_TOPBAR_OPEN, true)
  const [liveToolActivityTail, setLiveToolActivityTail] = useNumberPref(
    PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
    DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
    { min: 0, max: 10 },
  )
  const [chatFontSize, setChatFontSize] = useNumberPref(PREF_CHAT_FONT_SIZE, DEFAULT_CHAT_FONT_SIZE, { min: 0, max: 6 })
  const [sessionExplorerFontSize, setSessionExplorerFontSize] = useNumberPref(PREF_SESSION_EXPLORER_FONT_SIZE, DEFAULT_SESSION_EXPLORER_FONT_SIZE, { min: 0, max: 4 })
  const [fileExplorerFontSize, setFileExplorerFontSize] = useNumberPref(PREF_FILE_EXPLORER_FONT_SIZE, DEFAULT_FILE_EXPLORER_FONT_SIZE, { min: 0, max: 4 })
  const [fileViewFontSize, setFileViewFontSize] = useNumberPref(PREF_FILE_VIEW_FONT_SIZE, DEFAULT_FILE_VIEW_FONT_SIZE, { min: 0, max: 4 })
  const [chatContentWidth, setChatContentWidth] = useNumberPref(PREF_CHAT_CONTENT_WIDTH, DEFAULT_CHAT_CONTENT_WIDTH, { min: 0, max: 2 })
  const [chatSideSpace, setChatSideSpace] = useNumberPref(PREF_CHAT_SIDE_SPACE, DEFAULT_CHAT_SIDE_SPACE, { min: 0, max: 2 })
  const [chatLineHeight, setChatLineHeight] = useNumberPref(PREF_CHAT_LINE_HEIGHT, DEFAULT_CHAT_LINE_HEIGHT, { min: 0, max: 2 })
  const [chatMathScale, setChatMathScale] = useNumberPref(PREF_CHAT_MATH_SCALE, DEFAULT_CHAT_MATH_SCALE, { min: 0, max: 4 })
  const [sessionCacheMaxMb, setSessionCacheMaxMb] = useNumberPref(PREF_SESSION_VIEW_CACHE_MAX_MB, DEFAULT_SESSION_VIEW_CACHE_MAX_MB, { min: 0, max: 4096 })
  const [durableCacheEnabled, setDurableCacheEnabled] = useBooleanPref(PREF_DURABLE_SESSION_CACHE_ENABLED, true)
  const [keepScreenAwake, setKeepScreenAwake] = useBooleanPref(PREF_KEEP_SCREEN_AWAKE, false)
  const [smoothStreamingText, setSmoothStreamingText] = useBooleanPref(PREF_SMOOTH_STREAMING_TEXT, true)
  const [theme, , setTheme, effectiveTheme] = useTheme()
  const [storedVSCodeTheme, setStoredVSCodeTheme] = useState<StoredVSCodeTheme | null>(() => readStoredVSCodeTheme())
  const currentThemeLabel = storedVSCodeTheme?.label ?? builtinThemeForScheme(effectiveTheme).label
  const restoreSavedTheme = (): void => {
    applyCurrentVSCodeTheme(effectiveTheme)
    setStoredVSCodeTheme(readStoredVSCodeTheme())
  }
  const applyStoredTheme = (next: StoredVSCodeTheme | null): void => {
    writeStoredVSCodeTheme(next)
    setStoredVSCodeTheme(next)
  }
  const previewTheme = (next: StoredVSCodeTheme): void => {
    applyVSCodeTheme(next.theme, effectiveTheme)
  }
  useEffect(() => restoreSavedTheme, [effectiveTheme])
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.interface.label')}
        subtitle={t('settings.interface.subtitle')}
      />
      <ul className="space-y-3 text-sm">
        <li className="flex flex-col gap-4 rounded-md bg-card/60 px-4 py-3 ring-1 ring-border/50 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.theme.label')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.theme.desc')}
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label={t('settings.interface.theme.label')}
            className="inline-flex flex-none overflow-hidden rounded-md border border-border"
            data-testid="settings-theme-toggle"
          >
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'system'}
              onClick={() => setTheme('system')}
              data-testid="settings-theme-system"
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs',
                theme === 'system'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Monitor className="h-3.5 w-3.5" aria-hidden />
              <span>{t('settings.interface.theme.system')}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'dark'}
              onClick={() => setTheme('dark')}
              data-testid="settings-theme-dark"
              className={cn(
                'inline-flex items-center gap-1.5 border-l border-border px-3 py-1.5 text-xs',
                theme === 'dark'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Moon className="h-3.5 w-3.5" aria-hidden />
              <span>{t('settings.interface.theme.dark')}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'light'}
              onClick={() => setTheme('light')}
              data-testid="settings-theme-light"
              className={cn(
                'inline-flex items-center gap-1.5 border-l border-border px-3 py-1.5 text-xs',
                theme === 'light'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Sun className="h-3.5 w-3.5" aria-hidden />
              <span>{t('settings.interface.theme.light')}</span>
            </button>
          </div>
        </li>
        <li className="rounded-md border border-border bg-card/60 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="font-medium">{t('settings.interface.vscodeTheme.label')}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('settings.interface.vscodeTheme.desc')}
              </p>
              <p className="mt-2 text-xs text-muted-foreground" data-testid="settings-vscode-theme-current">
                {t('settings.interface.vscodeTheme.current', { theme: currentThemeLabel })}
              </p>
            </div>
          </div>
          <MarketplaceThemeBrowser
            activeThemeId={storedVSCodeTheme?.id ?? `agent-kernel-${effectiveTheme}`}
            effectiveTheme={effectiveTheme}
            onPreview={previewTheme}
            onApply={(next) => applyStoredTheme(next)}
          />
        </li>
        <SegmentedNumberPref
          label={t('settings.interface.chatFontSize')}
          description={t('settings.interface.chatFontSizeDesc')}
          value={chatFontSize}
          onChange={setChatFontSize}
          testId="settings-chat-font-size"
          options={[0, 1, 2, 3, 4, 5, 6].map((value) => ({
            value,
            label: t(`settings.interface.chatFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.fileViewFontSize')}
          description={t('settings.interface.fileViewFontSizeDesc')}
          value={fileViewFontSize}
          onChange={setFileViewFontSize}
          testId="settings-file-view-font-size"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.fileViewFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.sessionExplorerFontSize')}
          description={t('settings.interface.sessionExplorerFontSizeDesc')}
          value={sessionExplorerFontSize}
          onChange={setSessionExplorerFontSize}
          testId="settings-session-explorer-font-size"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.explorerFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.fileExplorerFontSize')}
          description={t('settings.interface.fileExplorerFontSizeDesc')}
          value={fileExplorerFontSize}
          onChange={setFileExplorerFontSize}
          testId="settings-file-explorer-font-size"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.explorerFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatContentWidth')}
          description={t('settings.interface.chatContentWidthDesc')}
          value={chatContentWidth}
          onChange={setChatContentWidth}
          testId="settings-chat-content-width"
          options={[0, 1, 2].map((value) => ({
            value,
            label: t(`settings.interface.size3.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatSideSpace')}
          description={t('settings.interface.chatSideSpaceDesc')}
          value={chatSideSpace}
          onChange={setChatSideSpace}
          testId="settings-chat-side-space"
          options={[0, 1, 2].map((value) => ({
            value,
            label: t(`settings.interface.size3.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatLineHeight')}
          description={t('settings.interface.chatLineHeightDesc')}
          value={chatLineHeight}
          onChange={setChatLineHeight}
          testId="settings-chat-line-height"
          options={[0, 1, 2].map((value) => ({
            value,
            label: t(`settings.interface.size3.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatMathScale')}
          description={t('settings.interface.chatMathScaleDesc')}
          value={chatMathScale}
          onChange={setChatMathScale}
          testId="settings-chat-math-scale"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.chatMathScaleOptions.${value}`),
          }))}
        />
        <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.showToolCallTab')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.showToolCallTabDesc')}
            </p>
          </div>
          <Toggle
            checked={showToolCallTab}
            onChange={setShowToolCallTab}
            ariaLabel={t('settings.interface.showToolCallTab')}
            testId="settings-toggle-tool-call-tab"
          />
        </li>
        <InterfaceToggle
          label={t('settings.interface.explorerOpen')}
          description={t('settings.interface.explorerOpenDesc')}
          checked={explorerOpen}
          onChange={setExplorerOpen}
          testId="settings-toggle-explorer-open"
        />
        <InterfaceToggle
          label={t('settings.interface.inspectorOpen')}
          description={t('settings.interface.inspectorOpenDesc')}
          checked={inspectorOpen}
          onChange={setInspectorOpen}
          testId="settings-toggle-inspector-open"
        />
        <InterfaceToggle
          label={t('settings.interface.smoothStreamingText')}
          description={t('settings.interface.smoothStreamingTextDesc')}
          checked={smoothStreamingText}
          onChange={setSmoothStreamingText}
          testId="settings-toggle-smooth-streaming-text"
        />
        <InterfaceToggle
          label={t('settings.interface.topbarOpen')}
          description={t('settings.interface.topbarOpenDesc')}
          checked={topbarOpen}
          onChange={setTopbarOpen}
          testId="settings-toggle-topbar-open"
        />
        <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.liveToolActivityTail')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.liveToolActivityTailDesc')}
            </p>
          </div>
          <select value={liveToolActivityTail} onChange={(event) => setLiveToolActivityTail(Number(event.currentTarget.value))} className="h-8 w-24 flex-none rounded-md bg-background px-2 text-sm ring-1 ring-border/70" aria-label={t('settings.interface.liveToolActivityTail')} data-testid="settings-live-tool-activity-tail">
            {[0, 1, 2, 3, 5, 8, 10].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </li>
        <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.sessionCacheMaxMb')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.sessionCacheMaxMbDesc')}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <input list="session-cache-size-presets" type="number" min={0} max={4096} value={sessionCacheMaxMb} onChange={(event) => setSessionCacheMaxMb(Number(event.currentTarget.value))} className="h-8 w-24 rounded-md bg-background px-2 text-sm ring-1 ring-border/70" aria-label={t('settings.interface.sessionCacheMaxMb')} data-testid="settings-session-cache-max-mb" />
            <datalist id="session-cache-size-presets">{[0, 50, 100, 200, 500, 750, 1024, 2048, 4096].map((value) => <option key={value} value={value} />)}</datalist>
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
        </li>
        <InterfaceToggle
          label="Durable session cache"
          description="Keep recently viewed session content in this browser for fast reloads. The host remains authoritative."
          checked={durableCacheEnabled}
          onChange={setDurableCacheEnabled}
          testId="settings-toggle-durable-session-cache"
        />
        <SessionCacheManagement cache={sessionCache} enabled={durableCacheEnabled} />
        <InterfaceToggle
          label="Keep screen awake while running"
          description={wakeLockSupported() ? 'Prevent screen sleep while the selected session is actively running.' : 'Screen Wake Lock is unavailable in this browser.'}
          checked={keepScreenAwake && wakeLockSupported()}
          onChange={setKeepScreenAwake}
          testId="settings-toggle-keep-screen-awake"
          disabled={!wakeLockSupported()}
        />
      </ul>
    </div>
  )
}

type MarketplaceSearchResult = {
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  verified: boolean
  downloadCount: number
  iconUrl?: string
}

type MarketplaceExtension = MarketplaceSearchResult & {
  themes: Array<{ id: string; label: string; uiTheme: string; path: string }>
}

function MarketplaceThemeBrowser({
  activeThemeId,
  effectiveTheme,
  onPreview,
  onApply,
}: {
  activeThemeId: string
  effectiveTheme: 'dark' | 'light'
  onPreview(theme: StoredVSCodeTheme): void
  onApply(theme: StoredVSCodeTheme): void
}): JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('dark')
  const [selected, setSelected] = useState<MarketplaceSearchResult | null>(null)
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null)
  const [themeAction, setThemeAction] = useState<{ id: string; kind: 'preview' | 'apply' } | null>(null)
  const searchQuery = useQuery({
    queryKey: ['vscode-theme-marketplace-search', query],
    queryFn: async (): Promise<MarketplaceSearchResult[]> => {
      const res = await fetch(`/themes/marketplace/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await responseError(res))
      const payload = await res.json() as { results?: MarketplaceSearchResult[] }
      return payload.results ?? []
    },
    enabled: query.trim().length > 0,
    staleTime: 60_000,
  })
  const extensionQuery = useQuery({
    queryKey: ['vscode-theme-marketplace-extension', selected?.namespace, selected?.name],
    queryFn: async (): Promise<MarketplaceExtension> => {
      if (!selected) throw new Error('missing extension')
      const res = await fetch(`/themes/marketplace/extensions/${encodeURIComponent(selected.namespace)}/${encodeURIComponent(selected.name)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await responseError(res))
      return await res.json() as MarketplaceExtension
    },
    enabled: selected !== null,
    staleTime: 60_000,
  })

  const loadTheme = async (extension: MarketplaceExtension, themeId: string): Promise<StoredVSCodeTheme> => {
    const res = await fetch(`/themes/marketplace/extensions/${encodeURIComponent(extension.namespace)}/${encodeURIComponent(extension.name)}/themes/${encodeURIComponent(themeId)}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(await responseError(res))
    const payload = await res.json() as { theme: unknown; extension: MarketplaceExtension }
    const theme = validateVSCodeTheme(payload.theme)
    if (!theme) throw new Error(t('settings.interface.vscodeTheme.invalidTheme'))
    const contribution = extension.themes.find((entry) => entry.id === themeId || entry.label === themeId)
    return {
      source: 'marketplace',
      id: `${extension.namespace}.${extension.name}:${themeId}`,
      label: contribution?.label ?? theme.name ?? themeId,
      extension: `${extension.namespace}.${extension.name}`,
      theme: { ...theme, name: theme.name ?? contribution?.label },
    }
  }

  const selectedThemes = extensionQuery.data?.themes ?? []
  const themeRows: Array<{
    id: string
    label: string
    source: string
    load(): Promise<StoredVSCodeTheme> | StoredVSCodeTheme
  }> = [
    ...BUILTIN_VSCODE_THEMES.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      source: `${candidate.label} / ${candidate.theme.type === 'light' ? 'vs' : 'vs-dark'}`,
      load: () => candidate,
    })),
    ...selectedThemes.map((candidate) => ({
      id: `${extensionQuery.data!.namespace}.${extensionQuery.data!.name}:${candidate.id}`,
      label: candidate.label,
      source: `${extensionQuery.data!.displayName} / ${candidate.uiTheme}`,
      load: () => loadTheme(extensionQuery.data!, candidate.id),
    })),
  ]

  const runThemeAction = async (row: (typeof themeRows)[number], kind: 'preview' | 'apply'): Promise<void> => {
    setThemeAction({ id: row.id, kind })
    try {
      const theme = await Promise.resolve(row.load())
      if (kind === 'preview') {
        onPreview(theme)
        setPreviewThemeId(row.id)
      } else {
        onApply(theme)
        setPreviewThemeId(null)
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setThemeAction((current) => current?.id === row.id && current.kind === kind ? null : current)
    }
  }

  return (
    <div className="mt-4 space-y-3" data-testid="settings-vscode-marketplace">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm font-medium">{t('settings.interface.vscodeTheme.themeList')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.interface.vscodeTheme.marketplaceDesc')}</p>
        </div>
        <div className="flex min-w-0 gap-2">
          <input
            className="h-8 min-w-0 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.interface.vscodeTheme.searchPlaceholder')}
            data-testid="settings-vscode-marketplace-search"
          />
          <Button type="button" variant="outline" size="sm" onClick={() => searchQuery.refetch()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('settings.interface.vscodeTheme.refresh')}
          </Button>
        </div>
      </div>
      {searchQuery.error ? <div className="text-xs text-destructive">{(searchQuery.error as Error).message}</div> : null}
      <div className="rounded-md border border-border bg-background/40 p-2">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <div className="font-medium text-muted-foreground">{t('settings.interface.vscodeTheme.searchResults')}</div>
          {selected ? <div className="min-w-0 truncate text-[11px] text-muted-foreground">{selected.displayName}</div> : null}
        </div>
        <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
          {(searchQuery.data ?? []).map((result) => (
            <button
              key={`${result.namespace}.${result.name}`}
              type="button"
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground', selected?.namespace === result.namespace && selected.name === result.name ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
              onClick={() => setSelected(result)}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">{result.displayName}</div>
                <div className="truncate text-[11px]">{result.namespace}.{result.name}</div>
              </div>
              {result.verified ? <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary">{t('settings.interface.vscodeTheme.verified')}</span> : null}
            </button>
          ))}
          {searchQuery.isLoading ? <div className="px-2 py-1 text-xs text-muted-foreground">{t('common.loading')}</div> : null}
          {selected !== null && extensionQuery.isLoading ? <div className="px-2 py-1 text-xs text-muted-foreground">{t('settings.interface.vscodeTheme.loadingThemes')}</div> : null}
          {extensionQuery.error ? <div className="px-2 py-1 text-xs text-destructive">{(extensionQuery.error as Error).message}</div> : null}
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background/60" data-testid="settings-vscode-theme-list">
        <div className="max-h-72 divide-y divide-border overflow-y-auto">
          {themeRows.map((row) => {
            const active = activeThemeId === row.id || (!activeThemeId && row.id === `agent-kernel-${effectiveTheme}`)
            return (
              <ThemeListRow
                key={row.id}
                id={row.id}
                label={row.label}
                source={row.source}
                active={active}
                previewing={previewThemeId === row.id}
                previewLoading={themeAction?.id === row.id && themeAction.kind === 'preview'}
                applyLoading={themeAction?.id === row.id && themeAction.kind === 'apply'}
                onPreview={() => void runThemeAction(row, 'preview')}
                onApply={() => void runThemeAction(row, 'apply')}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ThemeListRow({
  id,
  label,
  source,
  active,
  previewing,
  previewLoading,
  applyLoading,
  onPreview,
  onApply,
}: {
  id: string
  label: string
  source: string
  active: boolean
  previewing: boolean
  previewLoading: boolean
  applyLoading: boolean
  onPreview(): void
  onApply(): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center" data-testid={`settings-vscode-theme-${id}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium">{label}</div>
            {active ? <span className="flex-none rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary">{t('settings.interface.vscodeTheme.active')}</span> : null}
            {previewing ? <span className="flex-none rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">{t('settings.interface.vscodeTheme.previewing')}</span> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">{source}</div>
        </div>
      </div>
      <div className="flex flex-none gap-2 sm:justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onPreview} disabled={previewLoading || applyLoading}>
          {previewLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {t('settings.interface.vscodeTheme.preview')}
        </Button>
        <Button type="button" size="sm" onClick={onApply} disabled={active || previewLoading || applyLoading}>
          {applyLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {t('settings.interface.vscodeTheme.apply')}
        </Button>
      </div>
    </div>
  )
}

function SegmentedNumberPref({
  label,
  description,
  value,
  onChange,
  options,
  testId,
}: {
  label: string
  description: string
  value: number
  onChange(next: number): void
  options: readonly { value: number; label: string }[]
  testId: string
}): JSX.Element {
  return (
    <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-background/70 p-1"
        data-testid={testId}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            data-testid={`${testId}-${option.value}`}
            className={cn(
              'min-h-8 rounded px-2.5 py-1 text-xs transition-colors',
              value === option.value
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </li>
  )
}

function SessionCacheManagement({ cache, enabled }: { cache?: DurableSessionViewCache; enabled: boolean }): JSX.Element {
  const [stats, setStats] = useState<{ sessions: number; estimatedBytes: number; maxBytes: number } | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setStats(cache ? await cache.durableStats().catch(() => null) : null)
    setPersistent(await navigator.storage?.persisted?.().catch(() => false) ?? null)
  }
  useEffect(() => { void refresh() }, [cache, enabled])

  const clear = async (): Promise<void> => {
    if (!cache) return
    setBusy(true)
    await cache.clearDurable()
    await refresh()
    setBusy(false)
  }
  const requestPersistence = async (): Promise<void> => {
    if (!navigator.storage?.persist) return
    setBusy(true)
    setPersistent(await navigator.storage.persist().catch(() => false))
    setBusy(false)
  }

  return (
    <li className="rounded-md border border-border/50 bg-card/60 px-4 py-3" data-testid="settings-session-cache-management">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs text-muted-foreground">
          <div>{enabled ? `${stats?.sessions ?? 0} cached sessions - ${formatBytes(stats?.estimatedBytes ?? 0)}` : 'Durable cache disabled'}</div>
          <div className="mt-0.5">Browser storage: {persistent === null ? 'unknown' : persistent ? 'persistent' : 'evictable'}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy || !navigator.storage?.persist} onClick={() => void requestPersistence()}>Keep cache</Button>
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy || !cache} onClick={() => void clear()}>Clear cache</Button>
        </div>
      </div>
    </li>
  )
}
