/**
 * ComposerFlipContainer — a 3D flip surface that swaps between the composer
 * (input) face and an approval-decision face. When `showApproval` is true the
 * back face (approval card) is presented; otherwise the front face (composer).
 *
 * The container's height animates to match the active face so the flip does
 * not cause a jarring layout jump between two faces of different sizes.
 *
 * Implementation notes:
 *  - CSS 3D: parent has `perspective`, inner has `transform-style: preserve-3d`
 *    and `rotateX(180deg)` (vertical flip like a flip-clock), each face uses
 *    `backface-visibility: hidden` and is absolutely positioned to overlap.
 *  - Height: each face is measured with `useMeasure`; the parent's inline
 *    `height` follows the active face's measured height, with a CSS
 *    transition so both rotation and resize happen smoothly.
 */

import { type ReactNode } from 'react'
import useMeasure from 'react-use-measure'

import { cn } from '../../lib/utils.js'

type Props = {
  showApproval: boolean
  front: ReactNode
  back: ReactNode
}

export function ComposerFlipContainer({ showApproval, front, back }: Props): JSX.Element {
  const [frontRef, frontBounds] = useMeasure({ debounce: 0 })
  const [backRef, backBounds] = useMeasure({ debounce: 0 })
  const activeHeight = showApproval ? backBounds.height : frontBounds.height
  return (
    <div
      className="[perspective:1600px]"
      data-testid="composer-flip"
      data-showing={showApproval ? 'approval' : 'composer'}
      style={{
        height: activeHeight > 0 ? activeHeight : undefined,
        transition: 'height 300ms ease',
      }}
    >
      <div
        className={cn(
          'relative h-full w-full [transform-style:preserve-3d]',
          'transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]',
        )}
        style={{
          transform: showApproval ? 'rotateX(180deg)' : 'rotateX(0deg)',
        }}
      >
        <div
          ref={frontRef}
          className={cn(
            'absolute inset-x-0 top-0 w-full [backface-visibility:hidden]',
          )}
          aria-hidden={showApproval}
          // While the back face is showing, the front is not painted (via
          // backface-visibility) but its DOM is still keyboard-reachable
          // without this. inert prevents tabbing into the hidden face.
          {...(showApproval ? { inert: '' as unknown as boolean } : {})}
        >
          {front}
        </div>
        <div
          ref={backRef}
          className={cn(
            'absolute inset-x-0 top-0 w-full [backface-visibility:hidden] [transform:rotateX(180deg)]',
          )}
          aria-hidden={!showApproval}
          {...(!showApproval ? { inert: '' as unknown as boolean } : {})}
        >
          {back}
        </div>
      </div>
    </div>
  )
}
