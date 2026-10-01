import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const baseUrl = process.env.PROTOTYPE_URL ?? 'http://127.0.0.1:4179/'
const executablePath = process.env.CHROMIUM_PATH ?? '/snap/bin/chromium'
const screenshotDir = process.env.PROTOTYPE_SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function visible(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 20_000 })
  return page.$(selector)
}

async function clickVisible(page, selector) {
  await visible(page, selector)
  await page.waitForFunction((candidate) => {
    const node = document.querySelector(candidate)
    if (!(node instanceof HTMLElement)) return false
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    let ancestor = node
    while (ancestor) {
      if (ancestor.getAnimations().some((animation) => animation.playState === 'running')) return false
      ancestor = ancestor.parentElement
    }
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.pointerEvents !== 'none'
      && (hit === node || node.contains(hit))
  }, { timeout: 20_000 }, selector)
  const element = await page.$(selector)
  assert(element, `click target disappeared after becoming clickable: ${selector}`)
  await element.click()
}

async function dragExplorer(page, deltaX) {
  const resizeHandle = await page.$('[data-panel-resize-handle-id="explorer-resize-handle"], #explorer-resize-handle')
  assert(resizeHandle, 'production explorer resize handle is missing')
  const box = await resizeHandle.boundingBox()
  assert(box, 'explorer resize handle has no geometry')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + deltaX, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function dragRightPanel(page, deltaX) {
  const handles = await page.$$('[data-panel-resize-handle-id]')
  assert(handles.length >= 2, 'production right panel resize handle is missing')
  const resizeHandle = handles.at(-1)
  const box = await resizeHandle.boundingBox()
  assert(box, 'right panel resize handle has no geometry')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + deltaX, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function openSessionInfo(page, sessionId) {
  const row = `[data-testid="session-row"][data-session-id="${sessionId}"]`
  await page.waitForFunction((selector) => {
    const node = document.querySelector(`${selector} [data-testid="session-info-button"]`)
    if (!(node instanceof HTMLButtonElement)) return false
    node.click()
    return true
  }, { timeout: 20_000 }, row)
  await visible(page, '[data-testid="session-metadata-dialog"]')
}

async function desktopMatrix(browser) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
  const consoleErrors = []
  const failedResponses = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  for (const selector of [
    '[data-testid="explorer-surface"]',
    '[data-testid="chat-panel"]',
    '[data-testid="composer"]',
    '[data-testid="right-panel"]',
    '[data-testid="tool-card-dots-read-explorer"]',
    '[data-testid="thinking-block"]',
  ]) await visible(page, selector)

  const activeContext = await page.$eval('[data-testid="context-usage-bar"]', (node) => ({
    running: node.getAttribute('data-running'),
    flow: Boolean(document.querySelector('[data-testid="context-usage-running-flow"]')),
    trackRunning: document.querySelector('[data-testid="context-usage-track"]')?.getAttribute('data-running'),
    fillRunning: document.querySelector('[data-testid="context-usage-fill"]')?.getAttribute('data-running'),
    trackPath: document.querySelector('[data-testid="context-usage-track"] > path')?.getAttribute('d'),
    fillPath: document.querySelector('[data-testid="context-usage-fill"]')?.getAttribute('d'),
    fillDash: document.querySelector('[data-testid="context-usage-fill"]')?.getAttribute('stroke-dasharray'),
    flowDash: document.querySelector('[data-testid="context-usage-running-flow"]')?.getAttribute('stroke-dasharray'),
    flowMask: document.querySelector('[data-testid="context-usage-running-flow"]')?.getAttribute('mask'),
    animationDuration: getComputedStyle(document.querySelector('[data-testid="context-usage-running-flow"]')).animationDuration,
  }))
  assert(activeContext.running === 'true' && activeContext.flow, 'running context usage flow contract is missing')
  assert(activeContext.trackRunning === null, 'static context track incorrectly owns running state')
  assert(activeContext.fillRunning === 'true', 'context fill does not own running state')
  assert(activeContext.trackPath?.includes('Q') && activeContext.fillPath === activeContext.trackPath, `context track/fill lost the composer shoulder arc: ${activeContext.trackPath}`)
  assert(activeContext.fillDash === '35 66', `35% context fill is not clipped along the composer contour: ${activeContext.fillDash}`)
  assert(activeContext.flowDash === '5 11' && activeContext.flowMask?.startsWith('url(#'), 'context stripes are not low-density and masked to the filled contour')
  assert(Number.parseFloat(activeContext.animationDuration) >= 2.8, `context animation is too fast: ${activeContext.animationDuration}`)
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  assert(await page.$eval('[data-testid="context-usage-running-flow"]', (node) => getComputedStyle(node).animationName) === 'none', 'reduced motion did not disable context fill animation')
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])

  const messageGeometry = await page.evaluate(async () => {
    const userMetadata = document.querySelector('[data-testid="user-message-metadata"]')
    const userSurface = document.querySelector('[data-testid="user-message-surface"]')
    const assistantFooter = document.querySelector('[data-testid="assistant-message-footer"]')
    const userTimestamp = userMetadata?.querySelector('[data-testid="message-timestamp"]')
    const timestamp = assistantFooter?.querySelector('[data-testid="message-timestamp"]')
    const copy = userMetadata?.querySelector('[data-testid="copy-message"]')
    if (!(userMetadata instanceof HTMLElement) || !(userSurface instanceof HTMLElement) || !(assistantFooter instanceof HTMLElement) || !(timestamp instanceof HTMLElement) || !(userTimestamp instanceof HTMLElement) || !(copy instanceof HTMLElement)) return null
    const metadataRect = userMetadata.getBoundingClientRect()
    const surfaceRect = userSurface.getBoundingClientRect()
    const before = copy.getBoundingClientRect()
    userSurface.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const after = copy.getBoundingClientRect()
    return {
      userBottomDelta: Math.abs(metadataRect.bottom - surfaceRect.bottom),
      userLeftOfBubble: metadataRect.right <= surfaceRect.left + 2,
      copyPointerEvents: getComputedStyle(copy).pointerEvents,
      copyShift: Math.abs(before.x - after.x),
      metadataWidthShift: Math.abs(metadataRect.width - userMetadata.getBoundingClientRect().width),
      userTimestampPosition: getComputedStyle(userTimestamp).position,
      assistantTimestampPosition: getComputedStyle(timestamp).position,
      assistantFooterMinHeight: getComputedStyle(assistantFooter).minHeight,
    }
  })
  assert(messageGeometry, 'message metadata geometry is unavailable')
  assert(messageGeometry.userBottomDelta <= 4 && messageGeometry.userLeftOfBubble, 'user metadata is not bottom-aligned beside the bubble')
  assert(messageGeometry.copyPointerEvents !== 'none', 'user copy action is not pointer interactive')
  assert(messageGeometry.copyShift <= 1 && messageGeometry.metadataWidthShift <= 1, 'hover timestamp pushed user actions horizontally')
  assert(messageGeometry.userTimestampPosition === 'absolute', 'user timestamp still reserves an action slot')
  assert(messageGeometry.assistantTimestampPosition === 'absolute', 'assistant timestamp still reserves a metadata slot')
  const thinkingAlignment = await page.$eval('[data-testid="thinking-block"]', (thinking) => {
    const column = thinking.closest('[data-testid="assistant-content-column"]')
    if (!(column instanceof HTMLElement)) return null
    return Math.abs(thinking.getBoundingClientRect().left - column.getBoundingClientRect().left)
  })
  assert(thinkingAlignment !== null && thinkingAlignment <= 2, `Thinking is not aligned with the assistant text column: ${thinkingAlignment}`)
  assert(await page.$eval('[data-testid="thinking-block"]', (node) => node.textContent?.includes('3 / 3')), 'adjacent Thinking updates were not merged into one paged production block')
  await page.setViewport({ width: 1440, height: 520, deviceScaleFactor: 1 })
  await page.$eval('[data-testid="virtuoso-scroller"]', (node) => {
    node.scrollTop = Math.max(300, node.scrollHeight / 2)
    node.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await visible(page, '[data-testid="sticky-user-prompt"]')
  const pinnedSurface = await page.$eval('[data-testid="sticky-user-prompt"] button', (node) => node.className)
  assert(pinnedSurface.includes('bg-card/88') && pinnedSurface.includes('shadow-sm') && !pinnedSurface.includes('shadow-[0_10px'), 'pinned message surface is still visually heavy')
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'desktop-pinned-prompt.png') })
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
  await page.$eval('[data-testid="virtuoso-scroller"]', (node) => {
    node.scrollTop = 0
    node.dispatchEvent(new Event('scroll', { bubbles: true }))
  })

  await openSessionInfo(page, 'prototype-active')
  assert(await page.$eval('[data-testid="session-info-overview-tab"]', (node) => node.getAttribute('aria-selected')) === 'true', 'Session info did not open on Overview')
  assert((await page.$eval('[data-testid="session-metadata-dialog"]', (node) => node.textContent)).includes('Working directory'), 'Session Overview is missing configuration')
  await clickVisible(page, '[data-testid="session-info-statistics-tab"]')
  const compactStatistics = await page.$eval('[data-testid="session-statistics"]', (node) => node.textContent)
  assert(compactStatistics.includes('1.25 M') && compactStatistics.includes('2.4 B'), 'Session Statistics compact spaced K/M/B fixtures are missing')
  assert(compactStatistics.includes('IN') && compactStatistics.includes('OUT'), 'Session Statistics IN/OUT badges are missing')
  assert(await page.$eval('[data-testid="session-statistics-grid"]', (node) => node.querySelectorAll(':scope > div').length >= 8), 'Session Statistics is not using the dense shared-header grid')
  assert(compactStatistics.includes('did not report billable cost'), 'Unavailable Session cost explanation is missing')
  await clickVisible(page, '[data-testid="session-statistics-number-exact"]')
  const exactStatistics = await page.$eval('[data-testid="session-statistics"]', (node) => node.textContent)
  assert(exactStatistics.includes('1,250,000') && exactStatistics.includes('2,400,000,000'), 'Session Statistics exact token display is missing')
  await clickVisible(page, '[data-testid="session-metadata-dialog"] button[aria-label="Close"]')

  await openSessionInfo(page, 'prototype-attention')
  await clickVisible(page, '[data-testid="session-info-statistics-tab"]')
  assert((await page.$eval('[data-testid="session-cost-value"]', (node) => node.textContent)) === '$0.00', 'reported zero Session cost is not distinct from unavailable')
  await clickVisible(page, '[data-testid="session-metadata-dialog"] button[aria-label="Close"]')

  const workspaceRow = await page.$('[data-testid="workspace-row"][data-workspace-id="workspace-studio"]')
  await workspaceRow.hover()
  await page.$eval('[data-testid="workspace-info-workspace-studio"]', (node) => node.click())
  await visible(page, '[data-testid="workspace-metadata-dialog"]')
  assert(await page.$eval('[data-testid="workspace-metadata-tabs"]', (node) => node.scrollWidth <= node.clientWidth || getComputedStyle(node).overflowX === 'auto'), 'Workspace tabs are not responsive')
  await clickVisible(page, '[data-testid="workspace-metadata-sessions-tab"]')
  assert((await page.$eval('[data-testid="workspace-session-list"]', (node) => node.textContent)).includes('Long response · pinned prompt'), 'Workspace Sessions tab is missing mock sessions')
  await clickVisible(page, '[data-testid="workspace-metadata-runtime-tab"]')
  assert((await page.$eval('[data-testid="workspace-technical-details"]', (node) => node.textContent)).includes('executor-studio'), 'Workspace Runtime tab is missing technical identifiers')
  await page.keyboard.press('Escape')

  const imageState = await page.$$eval('img', (images) => images.map((image) => ({
    src: image.getAttribute('src') ?? '',
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  })))
  const brokenImages = imageState.filter((image) =>
    !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0)
  assert(brokenImages.length === 0, `broken production images:\n${JSON.stringify(brokenImages, null, 2)}`)
  for (const expected of [
    '/icons/octopus-web.svg',
    '/brand/kala-wordmark.svg',
    '/icons/macos.svg',
    '/icons/linux.svg',
    '/icons/windows.svg',
  ]) {
    assert(imageState.some((image) => image.src.startsWith(`${expected}?prototype=`)), `missing versioned production image: ${expected}`)
  }

  const sessionRows = await page.$$('[data-testid="session-row"]')
  assert(sessionRows.length >= 6, `expected rich sidebar data, received ${sessionRows.length} rows`)

  await clickVisible(page, '[data-testid="session-row"][data-session-id="prototype-subagents"]')
  await visible(page, '[data-testid="sub-agent-group-agent-running"]')
  const subAgentStates = await page.$$eval('[data-testid^="sub-agent-row-"]', (rows) => rows.map((row) => row.getAttribute('data-sub-agent-status')))
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'idle']) {
    assert(subAgentStates.includes(status), `Sub-agent matrix is missing ${status}: ${subAgentStates.join(', ')}`)
  }
  await clickVisible(page, '[data-testid="sub-agent-toggle-agent-running"]')
  await page.waitForSelector('[data-testid="nested-tool-group-toggle"]', { timeout: 20_000 })
  await page.$eval('[data-testid="nested-tool-group-toggle"]', (node) => node.scrollIntoView({ block: 'center' }))
  await clickVisible(page, '[data-testid="nested-tool-group-toggle"]')
  await visible(page, '[data-testid="nested-tool-intention-nested-read"]')
  for (const [callId, nestedCallId, expectedText] of [
    ['agent-completed', 'completed-read', 'retry policy before editing'],
    ['agent-failed', 'failed-read', 'fictional integration fixture'],
    ['agent-cancelled', 'cancelled-read', 'documented retry constraints'],
  ]) {
    await clickVisible(page, `[data-testid="sub-agent-toggle-${callId}"]`)
    await visible(page, `[data-testid="sub-agent-transcript-frame-${callId}"]`)
    await page.$eval(`[data-testid="sub-agent-transcript-frame-${callId}"] [data-testid="nested-tool-group-toggle"]`, (node) => node.click())
    await visible(page, `[data-testid="nested-tool-intention-${nestedCallId}"]`)
    const rowText = await page.$eval(`[data-testid="sub-agent-row-${callId}"]`, (node) => node.textContent ?? '')
    assert(rowText.toLowerCase().includes(expectedText), `${callId} expanded activity is missing meaningful intention/result text: ${rowText}`)
  }
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'desktop-sub-agent-matrix.png') })

  await clickVisible(page, '[data-testid="explorer-search-button"]')
  await visible(page, '[data-testid="explorer-search"]')
  await page.type('[data-testid="explorer-search"]', 'accessibility')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length === 1)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length >= 6)

  await clickVisible(page, '[data-testid="session-row"][data-session-id="prototype-ask-user"]')
  await visible(page, '[data-testid="ask-user-choice-card"]')
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-testid="ask-user-choice-card"]')
    const meta = card?.querySelector('[data-testid="ask-user-choice-meta"]')?.getBoundingClientRect()
    const prompt = card?.querySelector('[data-testid="ask-user-choice-prompt"]')?.getBoundingClientRect()
    return Boolean(meta && prompt && meta.height >= 20 && prompt.top >= meta.bottom - 1)
  })
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'desktop-ask-user-density.png') })
  assert((await page.$eval('[data-testid="ask-user-choice-message"]', (node) => node.textContent)).includes('rollout window'), 'first AskUserChoice question is missing')
  const compactHeaderGeometry = await page.$eval('[data-testid="ask-user-choice-card"]', (card) => {
    const meta = card.querySelector('[data-testid="ask-user-choice-meta"]')?.getBoundingClientRect()
    const required = card.querySelector('[data-testid="ask-user-choice-required"]')?.getBoundingClientRect()
    const index = card.querySelector('[data-testid="ask-user-choice-index"]')?.getBoundingClientRect()
    const prompt = card.querySelector('[data-testid="ask-user-choice-prompt"]')?.getBoundingClientRect()
    return meta && required && index && prompt
      ? {
          metaHeight: meta.height,
          requiredTop: required.top,
          indexTop: index.top,
          promptTop: prompt.top,
          metaBottom: meta.bottom,
          text: card.textContent ?? '',
          promptCount: [...card.querySelectorAll('[data-testid="ask-user-choice-message"]')].length,
        }
      : null
  })
  assert(compactHeaderGeometry, 'AskUserChoice compact header geometry is unavailable')
  assert(compactHeaderGeometry.metaHeight <= 36, `AskUserChoice meta header is too tall: ${compactHeaderGeometry.metaHeight}px`)
  assert(Math.abs(compactHeaderGeometry.requiredTop - compactHeaderGeometry.indexTop) <= 2, 'Input required and question count are not on the same line')
  assert(
    compactHeaderGeometry.promptTop >= compactHeaderGeometry.metaBottom - 1,
    `question prompt does not directly follow the meta header: ${JSON.stringify(compactHeaderGeometry)}`,
  )
  assert(!compactHeaderGeometry.text.includes('Choose the safest fictional rollout window.'), 'duplicate rollout summary is still visible')
  assert(compactHeaderGeometry.promptCount === 1, `question prompt is rendered ${compactHeaderGeometry.promptCount} times`)
  const densityGeometry = await page.$eval('[data-testid="ask-user-choice-card"]', (card) => {
    const prompt = card.querySelector('[data-testid="ask-user-choice-prompt"]')?.getBoundingClientRect()
    const list = card.querySelector('[data-testid="ask-user-choice-list"]')?.getBoundingClientRect()
    const firstRow = card.querySelector('[data-testid="ask-user-choice-row-business-hours"]')?.getBoundingClientRect()
    const secondRow = card.querySelector('[data-testid="ask-user-choice-row-maintenance-window"]')?.getBoundingClientRect()
    const footer = card.querySelector('[data-testid="ask-user-choice-footer"]')?.getBoundingClientRect()
    const custom = card.querySelector('[data-testid="ask-user-choice-custom-option"]')?.getBoundingClientRect()
    const description = card.querySelector('[data-testid="ask-user-choice-description-business-hours"]')
    if (!prompt || !list || !firstRow || !secondRow || !footer || !custom || !description) return null
    return {
      firstRowHeight: firstRow.height,
      rowGap: secondRow.top - firstRow.bottom,
      promptToListGap: list.top - prompt.bottom,
      listToCustomGap: custom.top - list.bottom,
      customToFooterGap: footer.top - custom.bottom,
      descriptionFontSize: Number.parseFloat(getComputedStyle(description).fontSize),
    }
  })
  assert(densityGeometry, 'AskUserChoice density geometry is unavailable')
  assert(densityGeometry.firstRowHeight <= 44, `choice row is too tall: ${densityGeometry.firstRowHeight}px`)
  assert(densityGeometry.descriptionFontSize >= 14, `choice description is too small: ${densityGeometry.descriptionFontSize}px`)
  for (const [name, gap] of Object.entries({
    rowGap: densityGeometry.rowGap,
    promptToListGap: densityGeometry.promptToListGap,
    listToCustomGap: densityGeometry.listToCustomGap,
    customToFooterGap: densityGeometry.customToFooterGap,
  })) {
    assert(gap <= 12, `${name} is too large: ${gap}px`)
  }
  console.log(`AskUserChoice density: row=${densityGeometry.firstRowHeight}px, description=${densityGeometry.descriptionFontSize}px, gaps=${densityGeometry.promptToListGap}/${densityGeometry.rowGap}/${densityGeometry.listToCustomGap}/${densityGeometry.customToFooterGap}px`)
  const firstDescription = await page.$eval('[data-testid="ask-user-choice-description-business-hours"]', (node) => {
    const style = getComputedStyle(node)
    return { text: node.textContent ?? '', fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
  })
  const inlineChoiceGeometry = await page.$eval('[data-testid="ask-user-choice-row-business-hours"]', (row) => {
    const title = row.querySelector('[data-testid="ask-user-choice-title-business-hours"]')?.getBoundingClientRect()
    const description = row.querySelector('[data-testid="ask-user-choice-description-business-hours"]')?.getBoundingClientRect()
    return title && description
      ? {
          titleTop: title.top,
          titleRight: title.right,
          descriptionTop: description.top,
          descriptionLeft: description.left,
        }
      : null
  })
  assert(firstDescription.text.includes('rollback path'), 'single-choice description is not realistic or visible')
  assert(Number.parseFloat(firstDescription.fontSize) >= 13, `choice description is too small: ${firstDescription.fontSize}`)
  assert(Number.parseFloat(firstDescription.lineHeight) >= 18, `choice description line-height is too tight: ${firstDescription.lineHeight}`)
  assert(inlineChoiceGeometry, 'choice title/description geometry is unavailable')
  assert(Math.abs(inlineChoiceGeometry.titleTop - inlineChoiceGeometry.descriptionTop) <= 3, 'choice title and description are not aligned on the same line')
  assert(inlineChoiceGeometry.descriptionLeft > inlineChoiceGeometry.titleRight, 'choice description does not follow the title horizontally')
  await page.$eval('[data-testid="ask-user-choice-option-maintenance-window"]', (node) => node.closest('label')?.click())
  await clickVisible(page, '[data-testid="ask-user-choice-submit"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="ask-user-choice-message"]')?.textContent?.includes('validation scope'))
  assert(await page.$eval('[data-testid="ask-user-choice-option-focused"]', (node) => node.getAttribute('type') === 'checkbox'), 'second AskUserChoice question is not multi-select')
  assert(await page.$eval('[data-testid="ask-user-choice-option-browser"]', (node) => node.getAttribute('aria-checked') === 'true'), 'multi-select default is missing')
  await clickVisible(page, '[data-testid="ask-user-choice-option-prototype"]')
  await clickVisible(page, '[data-testid="ask-user-choice-custom-option"]')
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'ask-user-choice-custom-input')
  await page.type('[data-testid="ask-user-choice-custom-input"]', 'Run focused tests, then the full browser matrix.')
  assert(await page.$('[data-testid="ask-user-choice-custom-cancel"]') === null, 'custom response still renders a redundant cancel action')
  await clickVisible(page, '[data-testid="ask-user-choice-option-prototype"]')
  assert(await page.$('[data-testid="ask-user-choice-custom-input"]') === null, 'selecting a normal choice did not close custom response')
  assert(await page.$eval('[data-testid="ask-user-choice-option-prototype"]', (node) => node.getAttribute('aria-checked') === 'false'), 'normal choice did not update while closing custom response')
  await clickVisible(page, '[data-testid="ask-user-choice-custom-option"]')
  assert((await page.$eval('[data-testid="ask-user-choice-custom-input"]', (node) => node.value)).includes('full browser matrix'), 'custom response draft was not preserved')
  await clickVisible(page, '[data-testid="ask-user-choice-submit"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-choice-card"]'))

  await clickVisible(page, '[data-testid="session-row"][data-session-id="prototype-attention"]')
  await visible(page, '[data-testid="approval-card"]')
  const approvalSurface = await page.$eval('[data-testid="approval-card"]', (node) => ({
    classes: node.className,
    background: getComputedStyle(node).backgroundColor,
  }))
  assert(approvalSurface.classes.includes('bg-card'), 'approval card is not using the neutral card surface')
  assert(!approvalSurface.classes.includes('bg-amber'), 'approval card still uses a full amber surface')
  await clickVisible(page, '[data-testid="approval-details-toggle"]')
  await visible(page, '[data-testid="approval-details"]')
  assert((await page.$eval('[data-testid="approval-details"]', (node) => node.textContent)).includes('src/payments/retry-policy.ts'), 'approval fixture does not contain realistic fictional patch data')

  await clickVisible(page, '[data-testid="session-row"][data-session-id="prototype-active"]')
  await page.waitForFunction(() => new URL(window.location.href).searchParams.get('sessionId') === 'prototype-active')
  await visible(page, '[data-testid="tool-card-dots-read-explorer"]')

  await dragExplorer(page, 120)
  const wideSidebar = await page.$eval('[data-testid="session-row"][data-session-id="prototype-active"]', (row) => {
    const title = row.querySelector('.ak-session-label')?.parentElement
    const activity = row.querySelector('.ak-session-last-activity')
    return {
      panelWidth: row.closest('[data-testid="explorer-panel"]')?.getBoundingClientRect().width ?? 0,
      rowWidth: row.getBoundingClientRect().width,
      titleWidth: title?.getBoundingClientRect().width ?? 0,
      activityDisplay: activity ? getComputedStyle(activity).display : 'missing',
      titleTruncated: title?.querySelector('.ak-session-label') ? title.querySelector('.ak-session-label').scrollWidth > title.querySelector('.ak-session-label').clientWidth : false,
      gridColumns: getComputedStyle(row).gridTemplateColumns,
    }
  })
  assert(wideSidebar.panelWidth > 320, `wide sidebar did not exceed the container threshold: ${wideSidebar.panelWidth}px`)
  assert(wideSidebar.activityDisplay !== 'none', 'last activity must remain visible at normal/wide sidebar width')
  assert(wideSidebar.titleTruncated, 'wide sidebar must cap and truncate the long title while time remains visible')

  await dragExplorer(page, -100)
  const mediumSidebar = await page.$eval('[data-testid="session-row"][data-session-id="prototype-active"]', (row) => {
    const title = row.querySelector('.ak-session-label')?.parentElement
    const activity = row.querySelector('.ak-session-last-activity')
    return {
      panelWidth: row.closest('[data-testid="explorer-panel"]')?.getBoundingClientRect().width ?? 0,
      titleWidth: title?.getBoundingClientRect().width ?? 0,
      activityDisplay: activity ? getComputedStyle(activity).display : 'missing',
      gridColumns: getComputedStyle(row).gridTemplateColumns,
    }
  })
  assert(mediumSidebar.activityDisplay === 'none', 'last activity must hide at the medium threshold before further title compression')
  assert(mediumSidebar.titleWidth > wideSidebar.titleWidth, 'medium threshold did not release time space back to the title')

  await dragExplorer(page, -140)
  const narrowSidebar = await page.$eval('[data-testid="session-row"][data-session-id="prototype-active"]', (row) => {
    const title = row.querySelector('.ak-session-label')?.parentElement
    const activity = row.querySelector('.ak-session-last-activity')
    return {
      panelWidth: row.closest('[data-testid="explorer-panel"]')?.getBoundingClientRect().width ?? 0,
      titleWidth: title?.getBoundingClientRect().width ?? 0,
      activityDisplay: activity ? getComputedStyle(activity).display : 'missing',
      gridColumns: getComputedStyle(row).gridTemplateColumns,
    }
  })
  assert(narrowSidebar.activityDisplay === 'none', 'last activity must remain hidden at very narrow width')
  assert(narrowSidebar.titleWidth < mediumSidebar.titleWidth, 'very narrow sidebar did not continue truncating the title')
  const wideActivityColumn = Number.parseFloat(wideSidebar.gridColumns.split(' ').at(-1) ?? '0')
  const narrowActivityColumn = Number.parseFloat(narrowSidebar.gridColumns.split(' ').at(-1) ?? '0')
  assert(wideActivityColumn >= 48, `wide sidebar did not reserve a readable activity column: ${wideSidebar.gridColumns}`)
  assert(narrowActivityColumn <= 1, `narrow sidebar still reserves activity geometry: ${narrowSidebar.gridColumns}`)
  await clickVisible(page, '[data-testid="sidebar-collapse-button"]')
  await visible(page, '[data-testid="desktop-session-rail"]')
  await clickVisible(page, '[data-testid="desktop-rail-expand"]')
  await visible(page, '[data-testid="explorer-surface"]')

  await clickVisible(page, '[data-testid="right-panel-inspector-tab"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="right-panel-inspector-tab"]')?.getAttribute('aria-selected') === 'true')
  assert(await page.$eval('[data-testid="right-panel-tabs"]', (node) => node.getAttribute('data-labels-visible')) === 'false', 'narrow right panel should use icon-only tabs')
  await dragRightPanel(page, -180)
  await page.waitForFunction(() => document.querySelector('[data-testid="right-panel-tabs"]')?.getAttribute('data-labels-visible') === 'true')
  assert((await page.$eval('[data-testid="right-panel-terminal-tab"]', (node) => node.textContent)).includes('Terminal'), 'wide right panel did not restore tab labels')
  await page.type('[data-testid="composer-input"]', 'Prototype composer placeholder message')
  await clickVisible(page, '[data-testid="composer-send"]')
  await page.waitForFunction(() => document.body.textContent?.includes('Prototype composer placeholder message'))
  await clickVisible(page, '[data-testid="app-shell-nav-settings-icon"]')
  await visible(page, '[data-testid="settings-dialog"]')
  const settingsHierarchy = await page.$eval('[data-testid="settings-group-items-administration"]', (node) => ({
    borderLeftWidth: getComputedStyle(node).borderLeftWidth,
    paddingLeft: getComputedStyle(node).paddingLeft,
  }))
  assert(settingsHierarchy.borderLeftWidth !== '0px', 'settings group hierarchy guide is missing')
  assert(Number.parseFloat(settingsHierarchy.paddingLeft) > 0, 'settings child items are not indented')
  await clickVisible(page, '[data-testid="settings-tab-interface"]')
  await visible(page, '[data-testid="settings-theme-dark"]')
  await clickVisible(page, '[data-testid="settings-theme-dark"]')
  assert(await page.$eval('[data-testid="settings-title-icon"]', (node) => node.getAttribute('aria-hidden')) === 'true', 'Settings title icon is missing or exposed to assistive technology')
  await clickVisible(page, '[data-testid="settings-tab-storage"]')
  await visible(page, '[data-testid="settings-storage"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-storage"]')?.textContent?.includes('Kala session storage'))
  const storageText = await page.$eval('[data-testid="settings-storage"]', (node) => node.textContent)
  assert(storageText.includes('Kala session storage') && storageText.includes('Sub-agent activity matrix'), `Storage inventory remained loading or has the wrong mock shape: ${storageText}`)
  const storageOrder = async () => page.$$eval('[data-testid="settings-storage-file-set-row"]', (rows) => rows.map((row) => row.getAttribute('data-session-id')))
  assert(JSON.stringify(await storageOrder()) === JSON.stringify(['prototype-subagents', 'prototype-active', 'prototype-usage']), 'Storage did not default to Size descending')
  await clickVisible(page, '[data-testid="settings-storage-sort-name"]')
  assert(JSON.stringify(await storageOrder()) === JSON.stringify(['prototype-active', 'prototype-subagents', 'prototype-usage']), 'Storage Name ascending order is wrong')
  await clickVisible(page, '[data-testid="settings-storage-sort-name"]')
  assert(JSON.stringify(await storageOrder()) === JSON.stringify(['prototype-usage', 'prototype-subagents', 'prototype-active']), 'Storage Name descending order is wrong')
  await clickVisible(page, '[data-testid="settings-storage-sort-size"]')
  assert(JSON.stringify(await storageOrder()) === JSON.stringify(['prototype-usage', 'prototype-active', 'prototype-subagents']), 'Storage Size ascending order is wrong')
  await clickVisible(page, '[data-testid="settings-storage-sort-size"]')
  assert(JSON.stringify(await storageOrder()) === JSON.stringify(['prototype-subagents', 'prototype-active', 'prototype-usage']), 'Storage Size descending order is wrong')
  await clickVisible(page, '[data-testid="settings-dialog-close"]')

  await page.evaluate(() => {
    localStorage.setItem('ak-hidden-workspaces', JSON.stringify({ version: 1, ids: ['workspace-labs'] }))
    localStorage.setItem('ak-hidden-sessions', JSON.stringify({ version: 1, ids: ['prototype-active'] }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await visible(page, '[data-testid="hidden-items-bar"]')
  assert((await page.$$('[data-testid="hidden-items-bar"]')).length === 1, 'Explorer rendered more than one Hidden disclosure')
  await clickVisible(page, '[data-testid="hidden-items-toggle"]')
  await visible(page, '[data-testid="hidden-workspaces-group"]')
  await visible(page, '[data-testid="hidden-sessions-group"]')
  assert(await page.$eval('[data-testid="session-unhide-icon"]', (node) => node.tagName.toLowerCase()) === 'svg', 'hidden restore does not use the Eye icon')
  assert(await page.$eval('[data-testid="hidden-session-label"]', (node) => {
    const item = node.closest('[data-testid="hidden-session-item"]')
    if (!(item instanceof HTMLElement)) return false
    return node.className.includes('truncate')
      && Boolean(node.getAttribute('title'))
      && item.getBoundingClientRect().right <= item.parentElement.getBoundingClientRect().right + 1
      && getComputedStyle(item).overflowX === 'hidden'
  }), 'hidden session label is not safely truncated')
  await clickVisible(page, '[data-testid="workspace-unhide-workspace-labs"]')
  await clickVisible(page, '[data-testid="session-unhide-prototype-active"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="hidden-items-bar"]'))

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert(overflow <= 1, `desktop horizontal overflow: ${overflow}px`)
  assert(consoleErrors.length === 0, `desktop console errors:\n${consoleErrors.join('\n')}`)
  assert(failedResponses.length === 0, `desktop HTTP failures:\n${failedResponses.join('\n')}`)
  await page.close()
}

async function responsiveMatrix(browser, viewport) {
  const page = await browser.newPage()
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
  const errors = []
  const failures = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await visible(page, '[data-testid="chat-panel"]')
  await visible(page, '[data-testid="composer"]')
  await clickVisible(page, '[data-testid="explorer-toggle"]')
  await visible(page, '[data-testid="explorer-drawer"]')
  await clickVisible(page, '[data-testid="explorer-search-button"]')
  await visible(page, '[data-testid="explorer-search"]')
  await page.type('[data-testid="explorer-search"]', 'Ask user')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length === 1)
  await clickVisible(page, '[data-testid="session-row"][data-session-id="prototype-ask-user"]')
  await visible(page, '[data-testid="ask-user-choice-card"]')
  const drawerStillVisible = await page.$eval('[data-testid="explorer-drawer"]', (node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
  })
  if (drawerStillVisible) {
    await page.keyboard.press('Escape')
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const cardOverflow = await page.$eval('[data-testid="ask-user-choice-card"]', (card) => {
    const rows = [...card.querySelectorAll('[data-testid^="ask-user-choice-row-"]')]
    const description = card.querySelector('[data-testid="ask-user-choice-description-business-hours"]')
    const descriptionStyle = description ? getComputedStyle(description) : null
    const lineHeight = Number.parseFloat(descriptionStyle?.lineHeight ?? '0')
    const descriptionHeight = description?.getBoundingClientRect().height ?? 0
    return {
      card: card.scrollWidth - card.clientWidth,
      rows: rows.map((row) => row.scrollWidth - row.clientWidth),
      descriptionHeight,
      descriptionLines: lineHeight > 0 ? descriptionHeight / lineHeight : 0,
      descriptionClamp: descriptionStyle?.webkitLineClamp ?? '',
      descriptionWhiteSpace: descriptionStyle?.whiteSpace ?? '',
    }
  })
  assert(cardOverflow.card <= 1, `${viewport.width}px AskUserChoice card overflow: ${cardOverflow.card}px`)
  assert(cardOverflow.rows.every((value) => value <= 1), `${viewport.width}px AskUserChoice row overflow: ${cardOverflow.rows.join(',')}px`)
  assert(cardOverflow.descriptionClamp === '2', `${viewport.width}px choice description is not capped at two lines`)
  assert(cardOverflow.descriptionWhiteSpace === 'pre-line', `${viewport.width}px choice description does not preserve explicit line breaks`)
  assert(cardOverflow.descriptionLines <= 2.1, `${viewport.width}px choice description exceeds two lines: ${cardOverflow.descriptionLines}`)
  if (viewport.width <= 390) {
    assert(cardOverflow.descriptionLines >= 1.8, `${viewport.width}px choice description did not wrap cleanly: ${cardOverflow.descriptionLines}`)
  }
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `responsive-${viewport.width}x${viewport.height}.png`) })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert(overflow <= 1, `${viewport.width}px horizontal overflow: ${overflow}px`)
  assert(errors.length === 0, `${viewport.width}px console errors:\n${errors.join('\n')}`)
  assert(failures.length === 0, `${viewport.width}px HTTP failures:\n${failures.join('\n')}`)
  await page.close()
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  await desktopMatrix(browser)
  await responsiveMatrix(browser, { width: 1100, height: 800 })
  await responsiveMatrix(browser, { width: 390, height: 844, isMobile: true, hasTouch: true })
  console.log('Production App prototype matrix passed: metadata tabs/statistics, context motion, transcript geometry, pinned prompt, merged Hidden items, responsive right-panel tabs, production interactions, and responsive layouts.')
} finally {
  await browser.close()
}
