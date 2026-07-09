import { describe, expect, it, beforeEach } from 'vitest'

import { applyVSCodeTheme, themeCssVarName, validateVSCodeTheme, writeStoredVSCodeTheme, readStoredVSCodeTheme } from './vscode-theme.js'

describe('vscode theme runtime', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    document.documentElement.className = ''
  })

  it('maps VS Code color ids to CSS variables and derived shadcn tokens', () => {
    applyVSCodeTheme({
      type: 'dark',
      colors: {
        'editor.background': '#101216',
        foreground: '#e6e8ee',
        'button.background': '#2f6feb',
      },
    })

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue(themeCssVarName('editor.background'))).toBe('#101216')
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('220 15.8% 7.5%')
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('219.6 82.5% 55.3%')
  })

  it('keeps saturated VS Code selection colors out of broad dashboard surfaces', () => {
    applyVSCodeTheme({
      type: 'dark',
      colors: {
        'editor.background': '#101216',
        foreground: '#e6e8ee',
        'button.background': '#2f6feb',
        'list.activeSelectionBackground': '#007acc',
        'list.activeSelectionForeground': '#ffffff',
      },
    })

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('219.6 82.5% 55.3%')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('220 5.2% 22.7%')
    expect(document.documentElement.style.getPropertyValue('--accent-foreground')).toBe('225 19% 91.8%')
  })

  it('validates and stores raw theme JSON without conversion', () => {
    const theme = validateVSCodeTheme({ name: 'Raw', type: 'light', colors: { foreground: '#000000' } })
    expect(theme?.name).toBe('Raw')

    writeStoredVSCodeTheme({ source: 'custom', id: 'raw', label: 'Raw', theme: theme! })

    expect(readStoredVSCodeTheme()?.theme.colors?.foreground).toBe('#000000')
  })
})
