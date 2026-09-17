export const INTERFACE_SCALE_MIN = 75
export const INTERFACE_SCALE_MAX = 200
export const DEFAULT_INTERFACE_SCALE = 125
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 48

// Keep existing persisted indices stable; new controls display/edit pixels.
function extendFontSizes(previous: readonly number[]): readonly number[] {
  return [
    ...previous,
    ...Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => i + FONT_SIZE_MIN)
      .filter((size) => !previous.includes(size)),
  ]
}

export const CHAT_FONT_SIZE_PX = extendFontSizes([12, 13, 14, 15, 16, 18, 20])
export const SESSION_EXPLORER_FONT_SIZE_PX = extendFontSizes([11, 12, 13, 14, 15])
export const FILE_EXPLORER_FONT_SIZE_PX = extendFontSizes([10, 11, 12, 13, 14])
export const FILE_VIEW_FONT_SIZE_PX = extendFontSizes([10, 12, 14, 16, 18])
