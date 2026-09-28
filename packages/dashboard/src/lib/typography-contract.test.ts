import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
const entrypoint = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8')

describe('typography contract', () => {
  it('uses locally bundled variable font families', () => {
    expect(entrypoint).toContain("import '@fontsource-variable/inter/wght.css'")
    expect(entrypoint).toContain("import '@fontsource-variable/noto-sans-sc/wght.css'")
    expect(entrypoint).toContain("import '@fontsource-variable/jetbrains-mono/wght.css'")
    expect(stylesheet).toContain("'Inter Variable'")
    expect(stylesheet).toContain("'Noto Sans SC Variable'")
    expect(stylesheet).toContain("'JetBrains Mono Variable'")
  })

  it('keeps the root metric stable and exposes semantic type roles', () => {
    expect(stylesheet).toMatch(/:root\s*\{[\s\S]*?font-size:\s*16px;/)
    expect(stylesheet).not.toContain('font-size: calc(16px')
    for (const role of ['caption', 'meta', 'ui', 'body', 'title', 'heading', 'code']) {
      expect(stylesheet).toContain(`--ak-type-${role}-size:`)
      expect(stylesheet).toContain(`--ak-type-${role}-leading:`)
    }
  })

  it('uses language-aware fallback order without forcing grayscale smoothing', () => {
    expect(stylesheet).toContain(':root:lang(zh)')
    expect(stylesheet).toContain('font-synthesis: none')
    expect(stylesheet).toContain('-webkit-font-smoothing: auto')
    expect(stylesheet).not.toContain('-webkit-font-smoothing: antialiased')
  })
})
