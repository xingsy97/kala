import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dashboardRequire = createRequire(new URL('../packages/dashboard/package.json', import.meta.url))
const postcss = dashboardRequire('postcss')
const tailwindcss = dashboardRequire('tailwindcss')
const autoprefixer = dashboardRequire('autoprefixer')

describe('dashboard Tailwind config', () => {
  it('generates utilities when PostCSS runs from the host package cwd', async () => {
    const previousCwd = process.cwd()
    process.chdir(join(previousCwd, 'packages/host'))
    try {
      const postcssConfig = (await import('../packages/dashboard/postcss.config.js')).default
      const tailwindConfig = (await import('../packages/dashboard/tailwind.config.js')).default

      expect(tailwindConfig.content).toMatchObject({ relative: true })
      expect(postcssConfig.plugins.tailwindcss.config).toBeTypeOf('string')
      expect(isAbsolute(postcssConfig.plugins.tailwindcss.config)).toBe(true)
      expect(postcssConfig.plugins.tailwindcss.config).toMatch(/packages\/dashboard\/tailwind\.config\.js$/)

      const input = await readFile('../dashboard/src/index.css', 'utf8')
      const result = await postcss([
        tailwindcss(postcssConfig.plugins.tailwindcss),
        autoprefixer(postcssConfig.plugins.autoprefixer),
      ]).process(input, { from: '../dashboard/src/index.css' })

      expect(result.css).toContain('.h-screen')
      expect(result.css).toContain('.bg-background')
      expect(result.css).toContain('.bg-sidebar')
      expect(result.css.length).toBeGreaterThan(40_000)
    } finally {
      process.chdir(previousCwd)
    }
  })
})
