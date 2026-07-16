import { useEffect } from 'react'

const TITLE_SPINNER_FRAMES = ['/', '-', '\\', '|'] as const
const TITLE_SPINNER_INTERVAL_MS = 500

export const DASHBOARD_TITLE = 'Agent RunLab'

export function useRunningTitleIndicator(isRunning: boolean, baseTitle = DASHBOARD_TITLE): void {
  useEffect(() => {
    if (!isRunning) {
      document.title = baseTitle
      return
    }

    let frame = 0
    const render = (): void => {
      document.title = `${TITLE_SPINNER_FRAMES[frame]} ${baseTitle}`
      frame = (frame + 1) % TITLE_SPINNER_FRAMES.length
    }
    render()
    const interval = window.setInterval(render, TITLE_SPINNER_INTERVAL_MS)
    return () => {
      window.clearInterval(interval)
      document.title = baseTitle
    }
  }, [baseTitle, isRunning])
}
