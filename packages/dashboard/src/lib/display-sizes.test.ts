import { describe, expect, it } from 'vitest'
import { CHAT_FONT_SIZE_PX, SESSION_EXPLORER_FONT_SIZE_PX, FILE_EXPLORER_FONT_SIZE_PX, FILE_VIEW_FONT_SIZE_PX, FONT_SIZE_MIN, FONT_SIZE_MAX } from './display-sizes.js'
import { chatDisplayStyle } from '../features/chat/chatDisplayPrefs.js'

describe('expanded display sizes', () => {
  it('preserves every existing saved font index', () => {
    expect(CHAT_FONT_SIZE_PX.slice(0, 7)).toEqual([12, 13, 14, 15, 16, 18, 20])
    expect(SESSION_EXPLORER_FONT_SIZE_PX.slice(0, 5)).toEqual([11, 12, 13, 14, 15])
    expect(FILE_EXPLORER_FONT_SIZE_PX.slice(0, 5)).toEqual([10, 11, 12, 13, 14])
    expect(FILE_VIEW_FONT_SIZE_PX.slice(0, 5)).toEqual([10, 12, 14, 16, 18])
  })

  it('supports every integer pixel size from 10 to 48 without duplicates', () => {
    for (const sizes of [CHAT_FONT_SIZE_PX, SESSION_EXPLORER_FONT_SIZE_PX, FILE_EXPLORER_FONT_SIZE_PX, FILE_VIEW_FONT_SIZE_PX]) {
      expect(new Set(sizes).size).toBe(sizes.length)
      expect([...sizes].sort((a, b) => a - b)).toEqual(Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => FONT_SIZE_MIN + i))
    }
  })

  it('applies the actual maximum chat size in scalable units', () => {
    expect(chatDisplayStyle({ fontSize: CHAT_FONT_SIZE_PX.indexOf(48), contentWidth: 1, sideSpace: 1, lineHeight: 1 })).toHaveProperty('--ak-chat-font-size', '3rem')
  })
})
