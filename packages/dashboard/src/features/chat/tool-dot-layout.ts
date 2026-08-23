export type DotIdentity = { callId: string; status?: string }

export type ToolPreviewGeometry = {
  mobile: boolean
  left: number
  top: number
  width: number
  maxHeight: number
  horizontal: 'anchor' | 'viewport'
  vertical: 'above' | 'below' | 'bottom'
}

export function toolDotNodeWidth(basePixels: number, consecutiveCount: number): number {
  if (consecutiveCount <= 1) return basePixels
  return basePixels + 12 + String(consecutiveCount).length * 6
}

export function toolDotRailBudget(containerWidth: number): number {
  if (containerWidth <= 0) return 0
  if (containerWidth < 640) return Math.max(112, containerWidth - 52)
  return Math.round(Math.max(144, Math.min(containerWidth * 0.34, 420)))
}

export type ConsecutiveToolDotGroup<T> = {
  callId: string
  toolName: string
  dots: readonly T[]
}

export function groupConsecutiveToolDots<T extends DotIdentity & { toolName: string }>(
  dots: readonly T[],
): ConsecutiveToolDotGroup<T>[] {
  const groups: ConsecutiveToolDotGroup<T>[] = []
  for (const dot of dots) {
    const previous = groups.at(-1)
    if (previous?.toolName === dot.toolName) {
      groups[groups.length - 1] = { ...previous, dots: [...previous.dots, dot] }
    } else {
      groups.push({ callId: dot.callId, toolName: dot.toolName, dots: [dot] })
    }
  }
  return groups
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
  contentHeight?: number
}): ToolPreviewGeometry {
  const { anchor, viewportWidth, viewportHeight, contentHeight } = input
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
  const gap = 10
  const width = Math.min(384, viewportWidth - inset * 2)
  const maxHeight = Math.max(180, Math.min(448, viewportHeight - inset * 2))
  const measuredHeight = Math.max(1, Math.min(contentHeight ?? 240, maxHeight))
  const belowFits = anchor.bottom + gap + measuredHeight <= viewportHeight - inset
  const vertical = belowFits ? 'below' : 'above'
  // Keep the preview's leading edge close to the Dot instead of moving a wide
  // panel wholesale to the opposite side of the viewport.
  const left = Math.min(Math.max(inset, anchor.left - 16), Math.max(inset, viewportWidth - width - inset))
  const top = vertical === 'below'
    ? anchor.bottom + gap
    : Math.max(inset, anchor.top - gap - measuredHeight)
  const positionedMaxHeight = Math.max(1, Math.min(maxHeight, viewportHeight - inset - top))
  return { mobile: false, left, top, width, maxHeight: positionedMaxHeight, horizontal: 'anchor', vertical }
}
