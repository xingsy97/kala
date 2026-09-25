import { Children, cloneElement, isValidElement, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

function scopeColumnHeaders(node: ReactNode): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; scope?: string }>(child)) return child
    const children = scopeColumnHeaders(child.props.children)
    if (child.type === 'th') return cloneElement(child, { ...child.props, scope: child.props.scope ?? 'col', children })
    return cloneElement(child, { ...child.props, children })
  })
}

/** Semantic table overflow container shared by chat, docs, and file previews. */
export function MarkdownTable({ children, label = 'Scrollable table' }: { children?: ReactNode; label?: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const measureOverflow = useCallback(() => {
    const container = containerRef.current
    if (container) setOverflowing(container.scrollWidth > container.clientWidth + 1)
  }, [])

  useLayoutEffect(() => {
    measureOverflow()
    const container = containerRef.current
    if (!container) return
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measureOverflow)
      observer.observe(container)
      const table = container.querySelector('table')
      if (table) observer.observe(table)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measureOverflow)
    return () => window.removeEventListener('resize', measureOverflow)
  }, [measureOverflow])

  return (
    <div
      ref={containerRef}
      className="ak-markdown-table-scroll"
      role="region"
      aria-label={label}
      tabIndex={overflowing ? 0 : undefined}
    >
      <table>{scopeColumnHeaders(children)}</table>
    </div>
  )
}
