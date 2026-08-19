import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/i
const PRIVATE_IPV4 = /(?<!\d)(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?!\d)/g
const HOME_PATH = /(?:\/home\/([^/:;\s"']+)|\/Users\/([^/:;\s"']+)|[A-Za-z]:\\Users\\([^\\:;\s"']+))/g
const EMAIL = /(?<![\w.-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\w.-])/g
const UUID = /(?<![0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?![0-9a-f])/gi
const URL = /\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi
const SECRET_RULES = [
  ['privacy.aws-access-key', /AKIA[0-9A-Z]{16}/g],
  ['privacy.github-token', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['privacy.api-token', /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g],
  ['privacy.product-token', /(?<![A-Za-z0-9])ak_(?:exec|invite)_[A-Za-z0-9_-]{12,}/gi],
  ['privacy.private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32,}/g],
]

export function loadPrivacyPolicy(root) {
  const path = resolve(root, 'security/privacy-policy.json')
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  if (policy.version !== 1) throw new Error(`Unsupported privacy policy version: ${policy.version}`)
  for (const entry of policy.ruleExceptions) {
    if (!entry.rule || !entry.path || !entry.reason || !/^[0-9a-f]{64}$/.test(entry.contentSha256 ?? '') || /[*?\[\]]/.test(entry.path)) {
      throw new Error('Privacy policy exceptions require an exact rule, exact path, content SHA-256, and public reason.')
    }
  }
  return {
    ...policy,
    allowedHomeUsers: new Set(policy.allowedHomeUsers),
    allowedEmailDomains: new Set(policy.allowedEmailDomains),
    allowedUuidPrefixes: new Set(policy.allowedUuidPrefixes),
    allowedImagePaths: new Set(policy.allowedImagePaths),
    allowedBinaryPaths: new Set(policy.allowedBinaryPaths),
    allowedCredentialFixtureHashes: new Set(policy.allowedCredentialFixtureHashes),
    exceptionKeys: new Set(policy.ruleExceptions.map(({ rule, path, contentSha256 }) => `${rule}\0${path}\0${contentSha256}`)),
  }
}

export function loadPrivateDenylist(root, env = process.env, gitLocalPath) {
  const paths = []
  const gitLocal = gitLocalPath ? resolve(root, gitLocalPath) : resolve(root, '.git/privacy-denylist')
  if (existsSync(gitLocal)) paths.push(gitLocal)
  if (env.PRIVACY_DENYLIST_FILE) paths.push(resolve(env.PRIVACY_DENYLIST_FILE))
  const values = []
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const value = line.trim()
      if (value && !value.startsWith('#')) values.push(value)
    }
  }
  if (env.PRIVACY_DENYLIST) {
    for (const line of env.PRIVACY_DENYLIST.split(/\r?\n/)) {
      const value = line.trim()
      if (value) values.push(value)
    }
  }
  return [...new Set(values)]
}

export function scanEntry({ path, content, policy, denylist = [], source = 'file' }) {
  const findings = []
  const binary = Buffer.isBuffer(content) && content.subarray(0, 8192).includes(0)
  const text = binary ? '' : Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
  const contentSha256 = createHash('sha256').update(content).digest('hex')
  const safePath = denylist.reduce((value, privateValue) => value.split(privateValue).join('<private>'), path)
  const add = (rule, index = 0, advice) => {
    if (policy.exceptionKeys.has(`${rule}\0${path}\0${contentSha256}`)) return
    const line = text ? text.slice(0, index).split('\n').length : undefined
    findings.push({ rule, path: safePath, line, source, advice, fingerprint: fingerprint(`${rule}\0${safePath}\0${line ?? 0}`) })
  }

  if (source === 'path') {
    for (const value of denylist) {
      if (path.includes(value)) add('privacy.private-denylist', 0, 'Replace the private path segment with a public example.')
    }
  }

  if (source === 'file') {
    if (/^(?:tmp|\.tmp)\//.test(path)) add('privacy.temporary-path', 0, 'Move generated output outside Git.')
    if (/^docs\/design\/.*\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) || /(?:^|\/)screenshots?\//i.test(path)) {
      add('privacy.design-image', 0, 'Do not commit design previews or product screenshots.')
    }
    if (IMAGE_EXTENSION.test(path) && !policy.allowedImagePaths.has(path)) {
      add('privacy.unregistered-image', 0, 'Register a runtime asset explicitly or keep the image outside Git.')
    }
    if (binary && !policy.allowedBinaryPaths.has(path) && !policy.allowedImagePaths.has(path)) {
      add('privacy.unregistered-binary', 0, 'Register a required fixture explicitly or keep the binary outside Git.')
      return findings
    }
    if ((policy.allowedBinaryPaths.has(path) || policy.allowedImagePaths.has(path)) && policy.allowedBinaryHashes[path] !== contentSha256) {
      add('privacy.asset-content-drift', 0, 'Review the asset change and update its approved SHA-256 explicitly.')
      return findings
    }
  }

  for (const value of denylist) {
    const index = text.indexOf(value)
    if (index >= 0) add('privacy.private-denylist', index, 'Replace the private value with a public example.')
  }
  for (const match of text.matchAll(PRIVATE_IPV4)) add('privacy.private-ipv4', match.index, 'Use an RFC 5737 documentation address.')
  for (const match of text.matchAll(HOME_PATH)) {
    const user = match.slice(1).find(Boolean)
    const template = /[$%{}<>…]/.test(user)
    if (!template && user.length >= 3 && !policy.allowedHomeUsers.has(user.toLowerCase())) add('privacy.personal-home', match.index, 'Use a documented example home directory.')
  }
  for (const match of text.matchAll(EMAIL)) {
    const domain = match[2].toLowerCase()
    const allowed = [...policy.allowedEmailDomains].some((item) => domain === item || domain.endsWith(`.${item}`))
      || domain.endsWith('.example') || domain.endsWith('.test') || domain.endsWith('.invalid')
    if (!allowed) add('privacy.non-example-email', match.index, 'Use an example-domain address.')
  }
  for (const match of text.matchAll(UUID)) {
    const value = match[1].toLowerCase()
    if (![...policy.allowedUuidPrefixes].some((prefix) => value.startsWith(prefix))) {
      add('privacy.runtime-uuid', match.index, 'Use the canonical example UUID or a shared fixture.')
    }
  }
  for (const match of text.matchAll(URL)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase()
      if (!host || host === 'localhost' || host.endsWith('.example') || host.endsWith('.test') || host.endsWith('.invalid')) continue
      if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) {
        add('privacy.private-host', match.index, 'Use localhost or an example-domain host.')
      }
    } catch { /* malformed URLs are handled by their owning parser */ }
  }
  for (const [rule, pattern] of SECRET_RULES) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const matchHash = createHash('sha256').update(match[0]).digest('hex')
      if (policy.allowedCredentialFixtureHashes.has(matchHash)) continue
      add(rule, match.index, 'Replace credential-shaped data with an unmistakable invalid fixture.')
    }
  }
  return dedupe(findings)
}

export function formatFindings(findings) {
  return findings.map((finding) => {
    const location = finding.line ? `${finding.path}:${finding.line}` : finding.path
    return `BLOCK ${finding.rule} ${location}\n  ${finding.advice}\n  Fingerprint: ${finding.fingerprint}`
  }).join('\n')
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function dedupe(findings) {
  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${finding.rule}\0${finding.path}\0${finding.line ?? 0}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
