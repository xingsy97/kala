#!/usr/bin/env node
/**
 * Ad-hoc OBJECTIVE probe for the streaming fade-in, built because unit tests /
 * DOM-churn counts cannot prove the *visual* behaviour the user reported:
 *   1. fade barely visible,
 *   2. text racing ahead of the cursor,
 *   3. already-shown text flashing (opacity dropping then returning).
 *
 * It boots the real dashboard + scripted streaming LLM, then samples, every
 * animation frame, the computed opacity of every `.ak-char-in` span keyed by the
 * span's absolute character offset in the streaming container. From that trace
 * it derives:
 *   - flashes: characters whose opacity went visible -> dropped -> visible again
 *   - fade visibility: how long (ms) a character's opacity spends mid-fade
 *   - min opacity seen after a char first became visible (should stay ~1)
 *
 * Usage: pnpm --filter @agent-kernel/perf-harness tsx bin/probe-fade.ts
 */
import { writeFileSync } from 'node:fs'

import { startLocalStack } from '../src/fixtures/index.js'
import { openDashboard } from '../src/probes/index.js'
import { streamingMarkdownLlm } from '../src/fixtures/index.js'

async function main(): Promise<void> {
  const stack = await startLocalStack({ llm: streamingMarkdownLlm({ chunkChars: 4, chunkMs: 20 }) })
  const session = await openDashboard({ url: stack.dashboardUrl })
  try {
    await session.waitForComposer()

    // Install an in-page per-frame sampler BEFORE streaming starts. We trace the
    // opacity of each fading SPAN ELEMENT by a stable per-element id (offsets in a
    // growing container are not stable identities), so we can see whether a span's
    // opacity actually animates 0 -> 1 over time or snaps in one frame.
    await session.page.evaluate(() => {
      type Sample = { t: number; op: number }
      const traces = new Map<number, Sample[]>() // key: stable element id
      ;(window as unknown as { __fadeTraces: Map<number, Sample[]> }).__fadeTraces = traces
      const t0 = performance.now()
      let running = true
      let nextId = 0
      const idOf = new WeakMap<Element, number>()
      ;(window as unknown as { __stopFade: () => void }).__stopFade = () => { running = false }

      const sample = (): void => {
        const spans = document.querySelectorAll<HTMLElement>('.ak-char-in')
        spans.forEach((span) => {
          let id = idOf.get(span)
          if (id === undefined) { id = nextId++; idOf.set(span, id) }
          const op = Number(getComputedStyle(span).opacity)
          let arr = traces.get(id)
          if (!arr) { arr = []; traces.set(id, arr) }
          arr.push({ t: performance.now() - t0, op })
        })
        if (running) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })

    await session.sendPrompt('stream a markdown answer')
    await new Promise((r) => setTimeout(r, 9000))
    await session.page.evaluate(() => (window as unknown as { __stopFade: () => void }).__stopFade())

    const traces = (await session.page.evaluate(() => {
      const m = (window as unknown as { __fadeTraces: Map<number, { t: number; op: number }[]> }).__fadeTraces
      return Array.from(m.entries()).map(([id, samples]) => ({ offset: id, samples }))
    })) as { offset: number; samples: { t: number; op: number }[] }[]

    // --- Analysis ---
    const VISIBLE = 0.9
    const GONE = 0.5
    let flashes = 0
    const flashOffsets: number[] = []
    let climbed = 0 // elements whose opacity rose from <0.5 to >=0.9 (a real fade)
    let stuckLow = 0 // elements never reaching visible (bad: fade never completes)
    const climbMs: number[] = []

    for (const { offset, samples } of traces) {
      if (samples.length === 0) continue
      const ops = samples.map((s) => s.op)
      const minOp = Math.min(...ops)
      const maxOp = Math.max(...ops)
      if (minOp < GONE && maxOp >= VISIBLE) {
        climbed += 1
        const start = samples.find((s) => s.op < GONE)
        const end = samples.find((s) => start && s.t > start.t && s.op >= VISIBLE)
        if (start && end) climbMs.push(end.t - start.t)
      } else if (maxOp < VISIBLE) {
        stuckLow += 1
      }
      // Flash: opacity became visible, then dropped below GONE, then visible again.
      let phase = 0
      for (const o of ops) {
        if (phase === 0 && o >= VISIBLE) phase = 1
        else if (phase === 1 && o < GONE) phase = 2
        else if (phase === 2 && o >= VISIBLE) { flashes += 1; flashOffsets.push(offset); phase = 1 }
      }
    }

    const med = (a: number[]): number => {
      if (a.length === 0) return 0
      const s = [...a].sort((x, y) => x - y)
      return Math.round(s[Math.floor(s.length / 2)])
    }

    const report = {
      spanElementsTracked: traces.length,
      climbedZeroToOne: climbed,
      stuckLowNeverVisible: stuckLow,
      medianFadeClimbMs: med(climbMs),
      flashes,
      flashOffsetsSample: flashOffsets.slice(0, 20),
    }
    console.log('\n=== streaming fade objective probe ===')
    console.log(JSON.stringify(report, null, 2))
    console.log('\ninterpretation:')
    console.log(`  flashes = ${flashes}  (MUST be 0: >0 means already-shown text opacity dropped then returned)`)
    console.log(`  climbedZeroToOne = ${climbed}/${traces.length} spans whose opacity actually rose 0 -> 1 (this is a VISIBLE fade)`)
    console.log(`  medianFadeClimbMs = ${report.medianFadeClimbMs} (should be roughly the CSS fade duration; ~0 or 'stuck' = broken)`)
    console.log(`  stuckLowNeverVisible = ${stuckLow} (MUST be ~0: spans that never reached full opacity = fade never completes)`)

    await session.page.screenshot({ path: '/tmp/fade-probe.png' }).catch(() => {})
    writeFileSync('/tmp/fade-traces.json', JSON.stringify(traces))
    console.log('\nscreenshot: /tmp/fade-probe.png   raw traces: /tmp/fade-traces.json')
  } finally {
    await session.close()
    await stack.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
