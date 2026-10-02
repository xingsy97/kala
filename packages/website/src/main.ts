import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'

const menuButton = document.querySelector<HTMLButtonElement>('[data-menu-button]')
const navigation = document.querySelector<HTMLElement>('[data-site-navigation]')
const themeButton = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')
const announcementButton = document.querySelector<HTMLButtonElement>('[data-dismiss-announcement]')
const releaseArchiveSelect = document.querySelector<HTMLSelectElement>('#release-archive-select')

menuButton?.addEventListener('click', () => {
  const expanded = menuButton.getAttribute('aria-expanded') === 'true'
  menuButton.setAttribute('aria-expanded', String(!expanded))
  navigation?.toggleAttribute('data-open', !expanded)
})

navigation?.addEventListener('click', (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) return
  menuButton?.setAttribute('aria-expanded', 'false')
  navigation.removeAttribute('data-open')
})

themeButton?.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = nextTheme
  try {
    localStorage.setItem('kala-site-theme', nextTheme)
  } catch {
    // The selected theme still applies for the current page.
  }
  updateThemeButton()
})

announcementButton?.addEventListener('click', () => {
  document.documentElement.dataset.releaseNotice = 'hidden'
  try {
    localStorage.setItem('kala-release-notice', document.documentElement.dataset.releaseVersion ?? '')
  } catch {
    // Dismissal still applies for the current page.
  }
})

releaseArchiveSelect?.addEventListener('change', () => {
  const destination = releaseArchiveSelect.value
  if (destination) window.location.assign(destination)
})

updateThemeButton()

const platform = detectPlatform()
for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-platform-label]'))) {
  node.textContent = platform.label
}
for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-platform-note]'))) {
  node.textContent = platform.note
}

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-copy-command]'))) {
  button.addEventListener('click', async () => {
    const target = document.querySelector<HTMLElement>(button.dataset.copyCommand ?? '')
    const value = target?.textContent?.trim()
    if (!value) return
    const previous = button.textContent
    try {
      await navigator.clipboard.writeText(value)
      button.textContent = 'Copied'
      button.dataset.copied = 'true'
      window.setTimeout(() => {
        button.textContent = previous
        delete button.dataset.copied
      }, 1_800)
    } catch {
      button.textContent = 'Copy unavailable'
      window.setTimeout(() => {
        button.textContent = previous
      }, 1_800)
    }
  })
}

const downloadModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-download-mode]'))
const downloadModePanels = Array.from(document.querySelectorAll<HTMLElement>('[data-download-panel]'))

for (const button of downloadModeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.downloadMode
    for (const candidate of downloadModeButtons) {
      candidate.setAttribute('aria-selected', String(candidate === button))
    }
    for (const panel of downloadModePanels) {
      panel.hidden = panel.dataset.downloadPanel !== mode
    }
  })
}

const lightbox = document.querySelector<HTMLDialogElement>('[data-image-lightbox]')
const lightboxImage = lightbox?.querySelector<HTMLImageElement>('[data-lightbox-image]')

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-lightbox-src]'))) {
  button.addEventListener('click', () => {
    if (!lightbox || !lightboxImage) return
    const sourceImage = Array.from(button.querySelectorAll<HTMLImageElement>('img'))
      .find((image) => image.getClientRects().length > 0 && !image.classList.contains('device-frame'))
    lightboxImage.src = sourceImage?.currentSrc || sourceImage?.src || button.dataset.lightboxSrc || ''
    lightboxImage.alt = button.dataset.lightboxAlt ?? sourceImage?.alt ?? ''
    lightbox.showModal()
  })
}

lightbox?.querySelector<HTMLButtonElement>('[data-lightbox-close]')?.addEventListener('click', () => lightbox.close())
lightbox?.addEventListener('click', (event) => {
  if (event.target === lightbox) lightbox.close()
})

for (const carousel of Array.from(document.querySelectorAll<HTMLElement>('[data-carousel]'))) {
  initializeCarousel(carousel)
}

for (const demo of Array.from(document.querySelectorAll<HTMLElement>('[data-dag-demo]'))) {
  initializeDagDemo(demo)
}

function detectPlatform(): { label: string; note: string } {
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (value.includes('mac')) {
    return {
      label: 'Download for macOS',
      note: 'Portable is supported on macOS x64 and Apple silicon.',
    }
  }
  if (value.includes('linux')) {
    return {
      label: 'Download for Linux',
      note: 'Portable is supported on Linux x64.',
    }
  }
  if (value.includes('win')) {
    const releaseVersion = document.documentElement.dataset.releaseVersion
    return {
      label: 'View supported downloads',
      note: `Windows native binaries are not included in Kala${releaseVersion ? ` v${releaseVersion}` : ''}.`,
    }
  }
  return {
    label: 'Download Kala',
    note: 'See the supported platform matrix before installing.',
  }
}

function updateThemeButton() {
  if (!themeButton) return
  const target = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${target} theme`
  themeButton.setAttribute('aria-label', label)
  themeButton.title = label
  document.querySelector<HTMLMetaElement>('[data-theme-color]')?.setAttribute('content', target === 'light' ? '#0c1420' : '#f7f9fc')
}

function initializeCarousel(carousel: HTMLElement) {
  const track = carousel.querySelector<HTMLElement>('[data-carousel-track]')
  const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-carousel-slide]'))
  const dots = Array.from(carousel.querySelectorAll<HTMLButtonElement>('[data-carousel-dot]'))
  if (!track || slides.length < 2) return

  let index = 0
  let timer: number | undefined
  let pointerStart: number | undefined
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  const show = (next: number) => {
    index = (next + slides.length) % slides.length
    track.style.transform = `translateX(-${index * 100}%)`
    carousel.dataset.carouselIndex = String(index)
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === index
      slide.classList.toggle('is-active', active)
      slide.setAttribute('aria-hidden', String(!active))
    })
    dots.forEach((dot, dotIndex) => {
      dot.toggleAttribute('aria-current', dotIndex === index)
    })
  }

  const stop = () => {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    stop()
    if (reducedMotion || carousel.dataset.carouselAutoplay !== 'true') return
    timer = window.setInterval(() => show(index + 1), 6_000)
  }

  carousel.querySelector<HTMLButtonElement>('[data-carousel-previous]')?.addEventListener('click', () => {
    show(index - 1)
    start()
  })
  carousel.querySelector<HTMLButtonElement>('[data-carousel-next]')?.addEventListener('click', () => {
    show(index + 1)
    start()
  })
  dots.forEach((dot, dotIndex) => dot.addEventListener('click', () => {
    show(dotIndex)
    start()
  }))
  carousel.addEventListener('mouseenter', stop)
  carousel.addEventListener('mouseleave', start)
  carousel.addEventListener('focusin', stop)
  carousel.addEventListener('focusout', (event) => {
    if (!carousel.contains(event.relatedTarget as Node | null)) start()
  })
  carousel.addEventListener('pointerdown', (event) => {
    pointerStart = event.clientX
  })
  carousel.addEventListener('pointerup', (event) => {
    if (pointerStart === undefined) return
    const distance = event.clientX - pointerStart
    pointerStart = undefined
    if (Math.abs(distance) < 45) return
    show(index + (distance < 0 ? 1 : -1))
    start()
  })
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start())
  show(0)
  start()
}

function initializeDagDemo(demo: HTMLElement) {
  const nodes = Array.from(demo.querySelectorAll<HTMLElement>('[data-dag-node]'))
  const edges = Array.from(demo.querySelectorAll<SVGPathElement>('[data-dag-edge]'))
  const status = demo.querySelector<HTMLElement>('[data-dag-status]')
  const replay = demo.querySelector<HTMLButtonElement>('[data-dag-replay]')
  const allNodeIds = nodes.map((node) => node.dataset.dagNode ?? '')
  const steps: Array<{ message: string; complete?: string[]; running?: string[]; ready?: string[] }> = [
    { message: 'Mapping dependencies', running: ['scope'] },
    { message: 'Three branches running in parallel', complete: ['scope'], running: ['runtime', 'dashboard', 'docs'] },
    { message: 'Validation unlocked', complete: ['scope', 'runtime', 'dashboard', 'docs'], running: ['integration', 'browser'] },
    { message: 'Release gate ready', complete: ['scope', 'runtime', 'dashboard', 'docs', 'integration', 'browser'], ready: ['release'] },
    { message: 'Shipping verified work', complete: ['scope', 'runtime', 'dashboard', 'docs', 'integration', 'browser'], running: ['release'] },
    { message: 'Plan complete', complete: allNodeIds },
  ]
  let step = 0
  let timer: number | undefined
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  const render = () => {
    const current = steps[step]
    if (!current) return
    if (status) status.textContent = current.message
    nodes.forEach((node) => {
      const id = node.dataset.dagNode ?? ''
      const state = current.complete?.includes(id)
        ? 'complete'
        : current.running?.includes(id)
          ? 'running'
          : current.ready?.includes(id)
            ? 'ready'
            : 'waiting'
      node.dataset.state = state
      const stateNode = node.querySelector<HTMLElement>('[data-node-state]')
      if (stateNode) stateNode.textContent = state === 'complete' ? 'Complete' : state === 'running' ? 'Running' : state === 'ready' ? 'Ready' : 'Blocked'
    })
    edges.forEach((edge) => {
      const [, target = ''] = (edge.dataset.dagEdge ?? '').split(':')
      edge.dataset.state = current.complete?.includes(target)
        ? 'complete'
        : current.running?.includes(target) || current.ready?.includes(target)
          ? 'active'
          : 'waiting'
    })
  }
  const stop = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
  }
  const start = () => {
    stop()
    if (reducedMotion) return
    const delay = step === steps.length - 1 ? 4_200 : 1_900
    timer = window.setTimeout(() => {
      step = (step + 1) % steps.length
      render()
      start()
    }, delay)
  }
  replay?.addEventListener('click', () => {
    step = 0
    render()
    start()
  })
  demo.addEventListener('mouseenter', stop)
  demo.addEventListener('mouseleave', start)
  demo.addEventListener('focusin', stop)
  demo.addEventListener('focusout', (event) => {
    if (!demo.contains(event.relatedTarget as Node | null)) start()
  })
  if (reducedMotion) step = steps.length - 1
  render()
  start()
}
