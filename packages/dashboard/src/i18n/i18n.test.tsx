import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LanguageSwitcher } from '../features/i18n/LanguageSwitcher.js'
import { i18n } from './index.js'

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

    expect(i18n.t('common.settings')).toBe('设置')
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
    expect(screen.getByTestId('language-switcher').textContent).toContain('ZH')
  })
})

