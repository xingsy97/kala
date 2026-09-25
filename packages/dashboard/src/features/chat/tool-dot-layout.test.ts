import { describe, expect, it } from 'vitest'

import { groupConsecutiveToolDots, toolDotNodeWidth, toolDotRailBudget, toolPreviewGeometry, visibleToolDots } from './tool-dot-layout.js'

describe('tool dot responsive layout', () => {
  it('budgets extra width for repeated-call count labels', () => {
    expect(toolDotNodeWidth(31, 1)).toBe(31)
    expect(toolDotNodeWidth(31, 2)).toBe(49)
    expect(toolDotNodeWidth(31, 100)).toBe(61)
  })

  it('shows long rails on wide desktop panels but preserves compact and mobile layouts', () => {
    expect(toolDotRailBudget(1200)).toBe(840)
    expect(toolDotRailBudget(906)).toBe(815)
    expect(toolDotRailBudget(800)).toBe(272)
    expect(toolDotRailBudget(390)).toBe(338)
  })

  it('groups only consecutive same-name tool dots and preserves order', () => {
    const groups = groupConsecutiveToolDots([
      { callId: 'r1', toolName: 'read' },
      { callId: 'r2', toolName: 'read' },
      { callId: 'g1', toolName: 'grep' },
      { callId: 'g2', toolName: 'grep' },
      { callId: 'r3', toolName: 'read' },
    ])
    expect(groups.map((group) => [group.toolName, group.dots.map((dot) => dot.callId)])).toEqual([
      ['read', ['r1', 'r2']],
      ['grep', ['g1', 'g2']],
      ['read', ['r3']],
    ])
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

  it('keeps a short desktop preview adjacent to its Dot using measured height', () => {
    const anchor = { left: 120, right: 148, top: 700, bottom: 728 }
    const geometry = toolPreviewGeometry({ anchor, viewportWidth: 1200, viewportHeight: 800, contentHeight: 120 })
    expect(geometry).toMatchObject({ mobile: false, horizontal: 'anchor', vertical: 'above', width: 384 })
    expect(anchor.top - (geometry.top + 120)).toBe(10)
    expect(Math.abs(geometry.left - anchor.left)).toBeLessThanOrEqual(16)
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
