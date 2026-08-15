import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-v8.cpu_profiler',
].join(',')

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function gitRevision(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

export async function browserMetadata(browser, page, artifactPath, root) {
  return {
    artifactPath,
    artifactSha256: sha256File(artifactPath),
    gitRevision: gitRevision(root),
    chromiumVersion: await browser.version(),
    userAgent: await page.browser().userAgent(),
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
  }
}

export async function startProfileWindow(page, cdp, options = {}) {
  await page.evaluate(() => {
    window.__runlabFrames = []
    window.__runlabFramesActive = true
    let previous = performance.now()
    const tick = (now) => {
      window.__runlabFrames.push(now - previous)
      previous = now
      if (window.__runlabFramesActive) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: options.samplingIntervalUs ?? 200 })
  await cdp.send('Profiler.start')
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    categories: options.traceCategories ?? TRACE_CATEGORIES,
    options: 'sampling-frequency=10000',
  })
  return performance.now()
}

export async function stopProfileWindow(page, cdp, options) {
  const durationMs = performance.now() - options.startedAt
  const { profile } = await cdp.send('Profiler.stop')
  const traceComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.end')
  const traceEvent = await traceComplete
  await copyCdpStream(cdp, traceEvent.stream, options.tracePath)
  const frames = await stopFrameProbe(page)
  return { durationMs, profile, frames }
}

export async function stopFrameProbe(page) {
  return page.evaluate(() => {
    window.__runlabFramesActive = false
    const values = (window.__runlabFrames ?? []).filter((value) => value > 0).sort((a, b) => a - b)
    const percentile = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
    return {
      count: values.length,
      avgMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: values.at(-1) ?? 0,
      over33Ms: values.filter((value) => value > 33).length,
      over50Ms: values.filter((value) => value > 50).length,
      over100Ms: values.filter((value) => value > 100).length,
    }
  })
}

export async function copyCdpStream(cdp, handle, path) {
  const output = createWriteStream(path)
  while (true) {
    const chunk = await cdp.send('IO.read', { handle })
    output.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data)
    if (chunk.eof) break
  }
  output.end()
  await new Promise((resolve, reject) => { output.on('finish', resolve); output.on('error', reject) })
  await cdp.send('IO.close', { handle })
}

export function summarizeCpuProfile(profile, topN = 25) {
  const frames = new Map((profile.nodes ?? []).map((node) => [node.id, node.callFrame]))
  const totals = new Map()
  for (let index = 0; index < (profile.samples ?? []).length; index += 1) {
    const frame = frames.get(profile.samples[index])
    if (!frame) continue
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url?.split('/').pop() || '(native)'}:${(frame.lineNumber ?? -1) + 1}`
    totals.set(key, (totals.get(key) ?? 0) + Math.max(0, profile.timeDeltas?.[index] ?? 0) / 1000)
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([frame, selfMs]) => ({ frame, selfMs: Math.round(selfMs * 10) / 10 }))
}

export function resolveChrome() {
  const configured = process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH
  if (configured && existsSync(configured)) return configured
  return ['/usr/bin/chromium', '/snap/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(existsSync)
}
