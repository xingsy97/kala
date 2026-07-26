import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Collapses composer-adjacent banners once 2+ would stack.
 *
 * Each banner component wraps its visible output in <BannerSlot> instead of
 * emitting its <div> directly. BannerSlot registers with the surrounding
 * <BannerStack> and defers rendering to the stack, which then decides how
 * many to show inline and how many to hide behind a "N more notices" toggle.
 * Banners that render `null` never register, so the count reflects reality.
 *
 * If <BannerSlot> is used outside a <BannerStack>, it just renders its
 * children inline — safe for tests or standalone pages.
 */
type BannerEntry = { id: string; node: ReactNode; order: number }

type Ctx = {
  register: (id: string, node: ReactNode, order: number) => void
  unregister: (id: string) => void
}

const BannerStackContext = createContext<Ctx | null>(null)

export function BannerStack({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<BannerEntry[]>([])
  const [expanded, setExpanded] = useState(false)

  const register = useCallback((id: string, node: ReactNode, order: number) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id)
      next.push({ id, node, order })
      next.sort((a, b) => a.order - b.order)
      return next
    })
  }, [])
  const unregister = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }, [])

  const ctx = useMemo<Ctx>(() => ({ register, unregister }), [register, unregister])

  // Assign a stable order to each child slot by its position in the children
  // array. BannerSlot picks this up via context on first mount.
  const childrenWithOrder = useMemo(() => {
    let order = 0
    return Children.map(children, (child) => {
      if (!isValidElement(child)) return child
      const assigned = order++
      return <BannerStackOrderContext.Provider value={assigned}>{child}</BannerStackOrderContext.Provider>
    })
  }, [children])

  const visible = entries
  const [first, ...rest] = visible
  const extraCount = rest.length

  return (
    <BannerStackContext.Provider value={ctx}>
      {/* Render the raw children off-DOM so their effects (register calls) run
          but their nodes are portaled through the slot renderer below. */}
      <div style={{ display: 'contents' }} aria-hidden="true">
        {childrenWithOrder}
      </div>
      {first ? <span key={first.id}>{first.node}</span> : null}
      {expanded && rest.length > 0
        ? rest.map((entry) => <span key={entry.id}>{entry.node}</span>)
        : null}
      {extraCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid="banner-stack-toggle"
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-border/60 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
              <span>{t('banners.hideMore', { count: extraCount })}</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
              <span>{t('banners.more', { count: extraCount })}</span>
            </>
          )}
        </button>
      ) : null}
    </BannerStackContext.Provider>
  )
}

const BannerStackOrderContext = createContext<number>(0)

/**
 * Wrap each banner's visible <div> in <BannerSlot> instead of returning it
 * directly. When the surrounding <BannerStack> is present, the slot registers
 * its content and renders nothing itself; the stack renders the content and
 * decides whether to inline or collapse it. Without a stack, it just renders
 * children inline.
 */
export function BannerSlot({ children }: { children: ReactNode }): JSX.Element | null {
  const ctx = useContext(BannerStackContext)
  const order = useContext(BannerStackOrderContext)
  const id = useId()

  useEffect(() => {
    if (!ctx) return
    ctx.register(id, children, order)
    return () => ctx.unregister(id)
  }, [ctx, id, children, order])

  if (ctx) return null
  return <>{children}</>
}
