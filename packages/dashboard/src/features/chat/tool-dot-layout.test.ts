import { describe, expect, it } from 'vitest'

import { toolDotRailBudget, toolPreviewGeometry, visibleToolDots } from './tool-dot-layout.js'

describe('tool dot responsive layout', () => {
  it('reserves most desktop width for intention instead of the dot rail', () => {
    expect(toolDotRailBudget(1200)).toBe(408)
    expect(toolDotRailBudget(800)).toBe(272)
    expect(toolDotRailBudget(390)).toBe(338)
  })

  it('folds long rails while preserving the first, latest, running, and pinned dots', () => {
    const dots = Array.from({ length: 100 }, (_, index) => ({ callId: `c${index}`, status: index === 50 ? 'running' : 'succeeded' }))
    const visible = visibleToolDots(dots, 8, ['c50', 'c25'])
    expect(visible).toHaveLength(8)
    expect(visible.map((dot) => dot.callId)).toEqual(expect.arrayContaining(['c0', 'c25', 'c50', 'c99']))
    expect(new Set(visible.map((dot) => dot.callId)).size).toBe(8)
  })

  it('uses an inset bottom sheet on phones regardless of dot location', () => {
    const geometry = toolPreviewGeometry({ anchor: { left: 340, right: 370, top: 700, bottom: 730 }, viewportWidth: 390, viewportHeight: 844 })
    expect(geometry).toMatchObject({ mobile: true, left: 8, width: 374, horizontal: 'viewport', vertical: 'bottom' })
    expect(geometry.left + geometry.width).toBeLessThanOrEqual(390 - 8)
    expect(geometry.top).toBeGreaterThanOrEqual(8)
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(844 - 8)
  })

  it('clamps desktop anchored details inside the viewport', () => {
    const geometry = toolPreviewGeometry({ anchor: { left: 980, right: 1008, top: 740, bottom: 768 }, viewportWidth: 1024, viewportHeight: 800 })
    expect(geometry.mobile).toBe(false)
    expect(geometry.left).toBeGreaterThanOrEqual(8)
    expect(geometry.left + geometry.width).toBeLessThanOrEqual(1016)
    expect(geometry.top).toBeGreaterThanOrEqual(8)
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(792)
  })
})
