/**
 * VAPID key loader.
 *
 * Web Push requires an application-server-generated key pair (VAPID, RFC 8292)
 * signed by the sender per request so browser push endpoints can trust the
 * origin. Keys come from three sources, in priority order:
 *
 * 1. AK_PUSH_VAPID_PUBLIC / AK_PUSH_VAPID_PRIVATE env vars.
 * 2. A JSON file at `<sessionsDir>/../push-vapid.json` — auto-generated the
 *    first time the host boots without env vars, so a fresh install starts
 *    working without a manual step. File is chmod 600.
 * 3. Neither → push endpoints degrade gracefully: /push/vapid-public-key
 *    returns { publicKey: null } and dispatchPush() short-circuits.
 *
 * The subject (`mailto:` / `https://`) identifies the sender to push
 * services; browsers do not display it, but Firefox has been known to log
 * abuse reports against it. AK_PUSH_VAPID_SUBJECT overrides the default.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import webpush from 'web-push'

export type VapidKeys = {
  publicKey: string
  privateKey: string
  subject: string
}

// Apple's push service (web.push.apple.com) rejects requests with a VAPID
// subject that is not a routable https:// URL or a syntactically valid
// mailto: at a real, resolvable domain. `.local` / `.invalid` /
// `example.com` and similar placeholder domains all produce
// HTTP 403 "BadJwtToken" (silently — the browser just never sees the
// notification). Default to an https:// URL of the project so a fresh
// install works on Apple devices without manual VAPID_SUBJECT config;
// operators with a public hostname can override via env.
const DEFAULT_SUBJECT = 'https://github.com/agent-kernel/agent-kernel'

/**
 * Some subjects (auto-generated on early versions, or copy-pasted from
 * examples) will silently break Apple push. Detect and rewrite them so
 * users don't have to delete push-vapid.json to escape.
 */
function normalizeSubject(subject: string | undefined | null): string {
  const raw = (subject ?? '').trim()
  if (!raw) return DEFAULT_SUBJECT
  // mailto:*@*.local / *.invalid / *.example / example.com / agent-kernel.local
  const badDomain = /^mailto:[^@]+@([^\s]+\.)?(local|invalid|example|test|agent-kernel\.local)(\s|$)/i
  if (badDomain.test(raw)) return DEFAULT_SUBJECT
  if (!raw.startsWith('mailto:') && !raw.startsWith('https://')) return DEFAULT_SUBJECT
  return raw
}

export function loadOrCreateVapidKeys(sessionsDir: string): VapidKeys | null {
  const envPublic = process.env.AK_PUSH_VAPID_PUBLIC?.trim()
  const envPrivate = process.env.AK_PUSH_VAPID_PRIVATE?.trim()
  const subject = normalizeSubject(process.env.AK_PUSH_VAPID_SUBJECT)

  if (envPublic && envPrivate) {
    return { publicKey: envPublic, privateKey: envPrivate, subject }
  }

  // If env is only partially set, refuse — mixing env + file would produce
  // an unauditable configuration.
  if (envPublic || envPrivate) {
    // eslint-disable-next-line no-console -- surfaced once at boot for triage
    console.warn('[push/vapid] both AK_PUSH_VAPID_PUBLIC and AK_PUSH_VAPID_PRIVATE must be set; ignoring partial env')
  }

  const filePath = join(dirname(sessionsDir), 'push-vapid.json')
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<VapidKeys>
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject: normalizeSubject(parsed.subject ?? subject) }
      }
    } catch {
      // Fall through to regeneration.
    }
  }

  // First boot: generate + persist. Fine to run at server start; both keys
  // are ~44 bytes.
  const generated = webpush.generateVAPIDKeys()
  const record: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject,
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8')
    // Keys are secrets; keep them owner-readable only. Best-effort — Windows
    // + noexec filesystems will silently ignore.
    try { chmodSync(filePath, 0o600) } catch {}
    // eslint-disable-next-line no-console
    console.info(`[push/vapid] generated new VAPID key pair at ${filePath}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[push/vapid] failed to persist generated keys; push subscriptions will not survive restart: ${err instanceof Error ? err.message : String(err)}`)
  }
  return record
}
