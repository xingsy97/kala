import { cn } from '../../lib/utils.js'

/** The original composer waveform, shared with the expanded recorder. */
export function VoiceLevelTrace({ levels, className }: { levels: readonly number[]; className?: string }): JSX.Element {
  const width = 160
  const height = 24
  const floor = height - 2
  const points = levels.map((level, index) => {
    const x = levels.length <= 1 ? 0 : (index / (levels.length - 1)) * width
    const y = floor - Math.max(0, Math.min(1, level)) * (height - 5)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const area = `M 0 ${floor} L ${points.replaceAll(' ', ' L ')} L ${width} ${floor} Z`
  return (
    <div className={cn('h-6 text-primary', className)} data-testid="composer-voice-waveform" aria-hidden="true">
      <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <path d={area} fill="currentColor" opacity="0.09" />
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          opacity="0.82"
        />
      </svg>
    </div>
  )
}
