export type DotIdentity = { callId: string; status?: string }

export type ToolPreviewGeometry = {
  mobile: boolean
  left: number
  top: number
  width: number
  maxHeight: number
  horizontal: 'right' | 'left' | 'viewport'
  vertical: 'above' | 'below' | 'bottom'
}

export function toolDotRailBudget(containerWidth: number): number {
  if (containerWidth <= 0) return 0
  if (containerWidth < 640) return Math.max(112, containerWidth - 52)
  return Math.round(Math.max(144, Math.min(containerWidth * 0.34, 420)))
}

export function visibleToolDots<T extends DotIdentity>(
  dots: readonly T[],
  limit: number,
  preferredCallIds: readonly string[],
): T[] {
  if (dots.length <= limit) return [...dots]
  const safeLimit = Math.max(2, limit)
  const selected = new Set<number>([0, dots.length - 1])
  for (const callId of preferredCallIds) {
    if (selected.size >= safeLimit) break
    const index = dots.findIndex((dot) => dot.callId === callId)
    if (index >= 0) selected.add(index)
  }
  for (let index = dots.length - 1; index >= 0 && selected.size < safeLimit; index -= 1) selected.add(index)
  for (let index = 1; index < dots.length && selected.size < safeLimit; index += 1) selected.add(index)
  return [...selected].sort((a, b) => a - b).map((index) => dots[index]!)
}

export function toolPreviewGeometry(input: {
  anchor: { left: number; right: number; top: number; bottom: number }
  viewportWidth: number
  viewportHeight: number
}): ToolPreviewGeometry {
  const { anchor, viewportWidth, viewportHeight } = input
  const inset = 8
  if (viewportWidth < 640) {
    const width = Math.max(0, viewportWidth - inset * 2)
    const maxHeight = Math.max(160, Math.min(viewportHeight * 0.72, viewportHeight - 24))
    return {
      mobile: true,
      left: inset,
      top: Math.max(inset, viewportHeight - maxHeight - inset),
      width,
      maxHeight,
      horizontal: 'viewport',
      vertical: 'bottom',
    }
  }
  const gap = 12
  const width = Math.min(544, viewportWidth - inset * 2)
  const maxHeight = Math.max(180, Math.min(448, viewportHeight - inset * 2))
  const rightFits = anchor.right + gap + width <= viewportWidth - inset
  const horizontal = rightFits ? 'right' : 'left'
  const aboveFits = anchor.top - gap - maxHeight >= inset
  const vertical = aboveFits ? 'above' : 'below'
  const left = horizontal === 'right'
    ? anchor.right + gap
    : Math.max(inset, anchor.left - gap - width)
  const top = vertical === 'above'
    ? Math.max(inset, anchor.top - gap - maxHeight)
    : Math.min(Math.max(inset, anchor.bottom + gap), Math.max(inset, viewportHeight - maxHeight - inset))
  return { mobile: false, left, top, width, maxHeight, horizontal, vertical }
}
