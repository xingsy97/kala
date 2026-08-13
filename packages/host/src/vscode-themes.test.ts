import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

let searchMarketplaceThemes: typeof import('./vscode-themes.js').searchMarketplaceThemes
let readMarketplaceThemeExtension: typeof import('./vscode-themes.js').readMarketplaceThemeExtension
let readMarketplaceTheme: typeof import('./vscode-themes.js').readMarketplaceTheme
let cacheDir: string

describe('vscode theme marketplace service', () => {
  beforeEach(async () => {
    vi.resetModules()
    cacheDir = await mkdtemp(join(tmpdir(), 'agent-kernel-vscode-themes-'))
    process.env.AGENT_KERNEL_OPEN_VSX_BASE_URL = 'https://example.test'
    process.env.AGENT_KERNEL_VSCODE_THEME_CACHE_DIR = cacheDir
    ;({ searchMarketplaceThemes, readMarketplaceThemeExtension, readMarketplaceTheme } = await import('./vscode-themes.js'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.AGENT_KERNEL_OPEN_VSX_BASE_URL
    delete process.env.AGENT_KERNEL_VSCODE_THEME_CACHE_DIR
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('searches Open VSX themes and parses theme contributions from a VSIX without executing extension code', async () => {
    const vsix = zipSync({
      'extension/package.json': strToU8(JSON.stringify({ contributes: { themes: [{ label: 'Example Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }] } })),
      'extension/themes/dark.json': strToU8(`{
        // VS Code color themes commonly use JSONC.
        "name": "Example Dark",
        "type": "dark",
        "colors": { "editor.background": "#101010", },
      }`),
    })
    const extension = {
      namespace: 'example',
      name: 'theme',
      displayName: 'Example Theme',
      description: 'A theme',
      version: '1.0.0',
      verified: true,
      downloadCount: 12,
      files: {
        download: 'https://example.test/download/theme.vsix',
        manifest: 'https://example.test/download/package.json',
      },
    }
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.includes('/api/-/search')) return Response.json({ extensions: [extension] })
      if (href === 'https://example.test/api/example/theme') return Response.json(extension)
      if (href === extension.files.manifest) return Response.json({ contributes: { themes: [{ label: 'Example Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }] } })
      if (href === extension.files.download) return new Response(vsix)
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchMarketplaceThemes('dark')).resolves.toEqual({ results: [expect.objectContaining({ namespace: 'example', name: 'theme' })] })
    await expect(readMarketplaceThemeExtension('example', 'theme')).resolves.toEqual(expect.objectContaining({ themes: [expect.objectContaining({ label: 'Example Dark' })] }))
    await expect(readMarketplaceTheme('example', 'theme', 'Example Dark')).resolves.toEqual(expect.objectContaining({ theme: expect.objectContaining({ colors: { 'editor.background': '#101010' } }) }))
  })
})
