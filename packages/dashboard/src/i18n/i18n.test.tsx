import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LanguageSwitcher } from '../features/i18n/LanguageSwitcher.js'
import { i18n } from './index.js'
import { resources } from './resources.js'

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

  it('keeps en and zh translation key sets in sync (principle A4)', () => {
    const enKeys = new Set(collectKeys(resources.en.translation))
    const zhKeys = new Set(collectKeys(resources.zh.translation))
    const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))
    const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] })
  })

  it('defines every statically referenced translation key in both languages', () => {
    const referenced = collectReferencedKeys(SOURCE_ROOT)
    const missing = (['en', 'zh'] as const).flatMap((language) =>
      referenced
        .filter(({ key }) => !hasKey(resources[language].translation, key))
        .map(({ key, file }) => `${language}:${key} (${file})`),
    )
    expect(missing).toEqual([])
  })

  it('resolves recently added dashboard UI keys instead of rendering raw key paths', async () => {
    const keys = [
      'artifacts.profiles.actions',
      'artifacts.memory.actions',
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
})

function collectReferencedKeys(root: string): Array<{ key: string; file: string }> {
  const found = new Map<string, { key: string; file: string }>()
  for (const file of sourceFiles(root)) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
    const source = readFileSync(file, 'utf8')
    const patterns = [
      /\bt\(\s*['"]([^'"`]+)['"]/g,
      /\bi18n\.t\(\s*['"]([^'"`]+)['"]/g,
      /\bi18nKey\s*=\s*['"]([^'"`]+)['"]/g,
    ]
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const key = match[1]
        if (!key) continue
        found.set(`${file}:${key}`, { key, file: file.slice(root.length + 1) })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file))
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

function hasKey(root: unknown, key: string): boolean {
  let current = root
  const segments = key.split('.')
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (!current || typeof current !== 'object') return false
    if (segment in current) {
      current = (current as Record<string, unknown>)[segment]
      continue
    }
    if (index === segments.length - 1) {
      const record = current as Record<string, unknown>
      return typeof record[`${segment}_one`] === 'string' && typeof record[`${segment}_other`] === 'string'
    }
    return false
  }
  return typeof current === 'string' || Array.isArray(current)
}
