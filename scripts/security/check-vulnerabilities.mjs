#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const grypePath = option('--grype')
const trivyPath = option('--trivy')
const exceptionsPath = resolve(option('--exceptions') ?? 'security/vulnerability-exceptions.json')
const outputPath = option('--output')
if (!grypePath || !trivyPath) fail('usage: check-vulnerabilities.mjs --grype FILE --trivy FILE [--exceptions FILE] [--output FILE]')
const policy = json(exceptionsPath)
if (policy.schemaVersion !== 1 || !Array.isArray(policy.exceptions)) fail('invalid vulnerability exception policy')
const today = new Date().toISOString().slice(0, 10)
const exceptionKeys = new Set()
for (const entry of policy.exceptions) {
  const required = ['scanner', 'vulnerabilityId', 'package', 'installedVersion', 'trackingUrl', 'owner', 'rationale', 'expiresOn']
  if (required.some((key) => typeof entry[key] !== 'string' || !entry[key].trim())) fail('vulnerability exception is missing an exact required field')
  if (!['grype', 'trivy'].includes(entry.scanner) || [entry.vulnerabilityId, entry.package, entry.installedVersion].some((value) => value.includes('*'))) fail('vulnerability exception must bind an exact scanner, ID, package, and version')
  if (!/^https:\/\//u.test(entry.trackingUrl) || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expiresOn)) fail('vulnerability exception requires an HTTPS tracking URL and ISO expiry date')
  if (entry.expiresOn < today) fail(`expired vulnerability exception ${entry.vulnerabilityId}`)
  const key = exceptionKey(entry); if (exceptionKeys.has(key)) fail(`duplicate vulnerability exception ${entry.vulnerabilityId}`); exceptionKeys.add(key)
}
const findings = [...parseGrype(json(resolve(grypePath))), ...parseTrivy(json(resolve(trivyPath)))]
const normalized = findings.map((finding) => ({ ...finding, excepted: exceptionKeys.has(exceptionKey(finding)) }))
const blocking = normalized.filter((finding) => ['HIGH', 'CRITICAL'].includes(finding.severity) && !finding.excepted)
const report = { schemaVersion: 1, policy: { blockingSeverities: ['HIGH', 'CRITICAL'], exceptions: policy.exceptions.length }, summary: { findings: normalized.length, blocking: blocking.length, excepted: normalized.filter((finding) => finding.excepted).length }, findings: normalized }
if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
if (blocking.length) { for (const finding of blocking) process.stderr.write(`BLOCK ${finding.scanner} ${finding.vulnerabilityId} ${finding.package}@${finding.installedVersion} ${finding.severity}\n`); process.exit(1) }
process.stdout.write(`PASS vulnerability policy findings=${String(normalized.length)} excepted=${String(report.summary.excepted)}\n`)

function* parseGrype(document) {
  if (!Array.isArray(document.matches)) fail('invalid Grype JSON report')
  for (const match of document.matches) yield finding('grype', match.vulnerability?.id, match.artifact?.name, match.artifact?.version, match.vulnerability?.severity, match.vulnerability?.fix?.versions?.join(', ') ?? '', match.artifact?.locations?.[0]?.path ?? 'release')
}
function* parseTrivy(document) {
  // Trivy omits Results entirely when a successfully scanned target has no
  // findings; require its report identity before accepting that empty case.
  if (!Number.isInteger(document.SchemaVersion) || typeof document.ArtifactName !== 'string' || typeof document.ArtifactType !== 'string' || (document.Results !== undefined && !Array.isArray(document.Results))) fail('invalid Trivy JSON report')
  for (const result of document.Results ?? []) for (const item of result.Vulnerabilities ?? []) yield finding('trivy', item.VulnerabilityID, item.PkgName, item.InstalledVersion, item.Severity, item.FixedVersion ?? '', result.Target ?? 'release')
}
function finding(scanner, vulnerabilityId, packageName, installedVersion, severity, fixedVersion, target) {
  if (![vulnerabilityId, packageName, installedVersion, severity].every((value) => typeof value === 'string' && value)) fail(`invalid ${scanner} vulnerability entry`)
  return { scanner, vulnerabilityId, package: packageName, installedVersion, fixedVersion, severity: severity.toUpperCase(), target: basename(String(target)) }
}
function exceptionKey(value) { return [value.scanner, value.vulnerabilityId, value.package, value.installedVersion].join('\0') }
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { fail(`invalid JSON ${basename(path)}`) } }
function fail(message) { process.stderr.write(`FAIL ${message}\n`); process.exit(1) }
