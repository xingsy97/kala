/**
 * Shiki highlighter — global singleton loader with per-language lazy
 * loading. Shiki v4 ships a WASM oniguruma + JSON grammars; loading all
 * 100+ languages up front would be ~4MB of bundle. Instead, we bootstrap
 * with a minimal theme pair and add languages the first time a code
 * block asks for one.
 *
 * We emit dual-theme HTML (`defaultColor: false`) so the same rendered
 * spans work in both light and dark mode via `--shiki-light` and
 * `--shiki-dark` CSS custom properties. That means a theme toggle costs
 * a single CSS class flip — no re-highlight, no flash.
 *
 * The `ensureLanguage` helper deduplicates concurrent load calls so a
 * message with three `typescript` blocks only downloads the grammar once.
 */

import type { BundledLanguage, BundledTheme, Highlighter } from 'shiki'

const LIGHT_THEME: BundledTheme = 'github-light'
const DARK_THEME: BundledTheme = 'github-dark'

let highlighterPromise: Promise<Highlighter> | null = null
const languageLoads = new Map<string, Promise<void>>()

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const shiki = await import('shiki')
      return shiki.createHighlighter({
        themes: [LIGHT_THEME, DARK_THEME],
        langs: [],
      })
    })()
  }
  return highlighterPromise
}

async function ensureLanguage(highlighter: Highlighter, lang: string): Promise<boolean> {
  if (highlighter.getLoadedLanguages().includes(lang as BundledLanguage)) return true
  const existing = languageLoads.get(lang)
  if (existing) {
    await existing
    return highlighter.getLoadedLanguages().includes(lang as BundledLanguage)
  }
  const attempt = (async () => {
    try {
      await highlighter.loadLanguage(lang as BundledLanguage)
    } catch {
      // Unknown / unbundled language — swallow so the caller can fall back
      // to plain text. Shiki throws for grammars it doesn't bundle.
    }
  })()
  languageLoads.set(lang, attempt)
  await attempt
  return highlighter.getLoadedLanguages().includes(lang as BundledLanguage)
}

/**
 * Highlight `code` as `lang`, returning the shiki-produced HTML (a `<pre>`
 * with theme-agnostic spans). Returns `null` when the language is unknown
 * or shiki can't initialize — callers should render a plain `<pre>` in
 * that case.
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  try {
    const highlighter = await getHighlighter()
    const normalized = lang.toLowerCase()
    const loaded = await ensureLanguage(highlighter, normalized)
    const useLang = loaded ? normalized : 'text'
    return highlighter.codeToHtml(code, {
      lang: useLang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    })
  } catch {
    return null
  }
}

export const SHIKI_LIGHT_THEME = LIGHT_THEME
export const SHIKI_DARK_THEME = DARK_THEME
