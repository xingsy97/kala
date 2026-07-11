import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LanguageSwitcher } from '../features/i18n/LanguageSwitcher.js'
import { i18n } from './index.js'
import { resources } from './resources.js'

function collectKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  const out: string[] = []
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k
    out.push(...collectKeys(v, next))
  }
  return out
}

describe('dashboard i18n', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('defaults to English and falls back to English for missing Chinese keys', async () => {
    expect(i18n.t('common.settings')).toBe('Settings')

    await i18n.changeLanguage('zh')

    expect(i18n.t('common.settings')).toBe(' - ')
    expect(i18n.t('language.english')).toBe('English')
  })

  it('switches language and persists the dashboard language preference', async () => {
    render(<LanguageSwitcher />)

    expect(screen.getByTestId('language-switcher').textContent).toContain('EN')

    fireEvent.click(screen.getByTestId('language-switcher'))

    await waitFor(() => {
      expect(localStorage.getItem('ak-dashboard-language')).toBe('zh')
      expect(document.documentElement.lang).toBe('zh-CN')
    })
    expect(screen.getByTestId('language-switcher').textContent).toContain(' - ')
  })

  it('keeps en and zh translation key sets in sync (principle A4)', () => {
    const enKeys = new Set(collectKeys(resources.en.translation))
    const zhKeys = new Set(collectKeys(resources.zh.translation))
    const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))
    const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] })
  })

  it('resolves recently added dashboard UI keys instead of rendering raw key paths', async () => {
    const keys = [
      'benchmarks.terminalWizard.description',
      'artifacts.eval.artifactCategories.patch',
      'artifacts.eval.details.session',
      'artifacts.ops.stats.reliabilityIssues',
      'inspector.llm.messagesTab',
      'inspector.llm.descriptionBytesLabel',
    ]

    for (const lang of ['en', 'zh'] as const) {
      await i18n.changeLanguage(lang)
      for (const key of keys) {
        expect(i18n.t(key), `${lang}.${key}`).not.toBe(key)
      }
    }
  })

  it('never claims resolved status at the Run Agent stage (principle A3)', () => {
    // `inferDescription` covers the Run Agent step  -  before official grading.
    // It may reference `resolved` only to say the status is *unknown* until
    // the official harness runs. It must not assert that predictions imply
    // resolved outcomes.
    for (const lang of ['en', 'zh'] as const) {
      const infer = resources[lang].translation.artifacts?.eval?.wizard?.inferDescription
      expect(infer, `${lang}.inferDescription must exist`).toBeDefined()
      const text = String(infer)
      const bad = /\b(?:has been|is|are)\s+resolved\b| - \s*resolved| - /i
      expect(bad.test(text), `${lang}.inferDescription must not claim resolved status: ${text}`).toBe(false)
    }
  })
})
