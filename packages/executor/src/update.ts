import { createHash } from 'node:crypto'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import process from 'node:process'

import type { Logger } from 'pino'

type LatestRelease = {
  tag_name?: string
  html_url?: string
}

type Options = {
  repo: string
  currentTag?: string
  autoUpdate: boolean
  argv: readonly string[]
  logger: Logger
}

const EXECUTOR_ASSET = 'agent-kernel-executor.cjs'

export async function checkExecutorUpdate(opts: Options): Promise<void> {
  const latest = await latestRelease(opts.repo)
  if (!latest.tag_name) return
  const current = normalizeTag(opts.currentTag)
  const latestTag = normalizeTag(latest.tag_name)
  if (!latestTag) return
  if (current && current === latestTag) return

  if (!opts.autoUpdate) {
    opts.logger.info(
      {
        current: current ?? 'unknown',
        latest: latestTag,
        url: latest.html_url ?? `https://github.com/${opts.repo}/releases/latest`,
      },
      'executor update available; set AGENT_KERNEL_AUTO_UPDATE=1 or pass --auto-update to update automatically',
    )
    return
  }

  const target = currentExecutablePath()
  if (!target || basename(target) !== EXECUTOR_ASSET) {
    opts.logger.warn(
      { current: current ?? 'unknown', latest: latestTag },
      'executor auto-update skipped because this process is not running the release asset',
    )
    return
  }

  const updated = await downloadAndVerify(opts.repo, latestTag)
  const nextPath = `${target}.next`
  await writeFile(nextPath, updated)
  await chmod(nextPath, 0o755)
  await rename(nextPath, target)
  opts.logger.info({ latest: latestTag, path: target }, 'executor updated; restarting')
  process.env.AGENT_KERNEL_RELEASE_TAG = latestTag
  process.env.AGENT_KERNEL_SKIP_UPDATE_ONCE = '1'
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [target, ...opts.argv], {
    stdio: 'inherit',
    env: process.env,
    detached: false,
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  return await new Promise(() => {})
}

async function latestRelease(repo: string): Promise<LatestRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-kernel-executor' },
  })
  if (!res.ok) throw new Error(`GitHub latest release request failed: ${res.status}`)
  return (await res.json()) as LatestRelease
}

async function downloadAndVerify(repo: string, tag: string): Promise<Buffer> {
  const base = `https://github.com/${repo}/releases/download/${tag}`
  const [asset, sumsText] = await Promise.all([
    downloadBuffer(`${base}/${EXECUTOR_ASSET}`),
    downloadText(`${base}/SHA256SUMS`),
  ])
  const expected = checksumFor(sumsText, EXECUTOR_ASSET)
  if (!expected) throw new Error(`SHA256SUMS does not include ${EXECUTOR_ASSET}`)
  const actual = createHash('sha256').update(asset).digest('hex')
  if (actual !== expected) throw new Error(`checksum mismatch for ${EXECUTOR_ASSET}`)
  return asset
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': 'agent-kernel-executor' } })
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'agent-kernel-executor' } })
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status}`)
  return await res.text()
}

export function checksumFor(text: string, asset: string): string | null {
  for (const line of text.split('\n')) {
    const [sum, file] = line.trim().split(/\s+/, 2)
    if (file === asset && sum) return sum
  }
  return null
}

function currentExecutablePath(): string | null {
  const entry = process.argv[1]
  if (!entry) return null
  return entry
}

export function normalizeTag(tag: string | undefined): string | null {
  if (!tag || tag === 'latest') return null
  return tag.trim()
}
