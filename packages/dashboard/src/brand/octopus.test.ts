import { describe, expect, it } from 'vitest'
import { octopusBadgeSvg, octopusSvg } from './octopus.js'

describe('original octopus identity', () => {
  it('uses the same readable character with distinct web and desktop variants', () => {
    const web = octopusSvg('web')
    const desktop = octopusSvg('desktop')
    expect(web).toContain('#ffa58f')
    expect(desktop).toContain('#8be0d5')
    expect(web).not.toContain('y="54"')
    expect(desktop).toContain('y="54"')
    for (const svg of [web, desktop]) {
      expect(svg).toContain('viewBox="0 0 64 64"')
      expect(svg.match(/<circle /g)).toHaveLength(2)
      expect(svg).not.toMatch(/<text|<image|<script|href=/)
    }
  })

  it('keeps the octopus during activity and reserves the maskable safe area', () => {
    expect(octopusSvg('web', { runningFrame: 1 })).toContain('rotate(90 54 10)')
    expect(octopusSvg('web', { runningFrame: 1 })).toContain('#ffa58f')
    expect(octopusSvg('web', { maskable: true })).toContain('rx="0"')
    expect(octopusSvg('web', { maskable: true })).toContain('scale(.88)')
    expect(octopusBadgeSvg()).toContain('mask="url(#octopus)"')
  })
})
