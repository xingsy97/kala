#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { RegressionGateDecisionSchema, ReportManifestSchema } from '@agent-kernel/eval-protocol'

const decisionPath = resolve(required('--decision', 'AGENT_EVAL_GATE_DECISION'))
const reportManifestPath = resolve(required('--report-manifest', 'AGENT_EVAL_REPORT_MANIFEST'))
const outputDirectory = resolve(option('--output-dir') ?? process.env.AGENT_EVAL_CI_OUTPUT_DIR ?? 'agent-evaluation-ci')
const reportUrl = option('--report-url') ?? process.env.AGENT_EVAL_REPORT_URL
const decision = RegressionGateDecisionSchema.parse(JSON.parse(await readFile(decisionPath, 'utf8')))
const reportManifest = ReportManifestSchema.parse(JSON.parse(await readFile(reportManifestPath, 'utf8')))
if (decision.evidenceRefs.length === 0) throw new Error('CI gate requires immutable evidence references')

const classification = decision.decision === 'indeterminate'
  ? decision.infrastructureFailures.length ? 'infrastructure' : 'insufficient-or-flaky-evidence'
  : decision.decision === 'block' ? 'regression' : decision.flakyTasks.length ? 'pass-with-flakes' : 'pass'
const contract = {
  schemaVersion: 1,
  decision: decision.decision,
  classification,
  exitCode: exitCode(decision.decision),
  baselineConfigHash: decision.baselineConfigHash,
  candidateConfigHash: decision.candidateConfigHash,
  pairedTasks: decision.pairedTasks,
  repeats: decision.repeats,
  flakyTasks: decision.flakyTasks,
  infrastructureFailures: decision.infrastructureFailures,
  violations: decision.violations,
  statistics: decision.statistics,
  evidenceRefs: decision.evidenceRefs,
  report: { reportId: reportManifest.reportId, inputEvidenceHash: reportManifest.inputEvidenceHash, semanticHash: reportManifest.semanticHash, formats: reportManifest.formats, url: reportUrl ?? null },
}
const outputs = new Map([
  ['gate.json', JSON.stringify(contract, null, 2) + '\n'],
  ['gate.csv', renderCsv(contract)],
  ['gate.junit.xml', renderJunit(contract)],
  ['gate.sarif.json', renderSarif(contract)],
  ['gate.md', renderMarkdown(contract)],
])
await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
for (const [name, content] of outputs) await writeFile(join(outputDirectory, name), content, { encoding: 'utf8', mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: decision.decision === 'pass', decision: decision.decision, classification, exitCode: contract.exitCode, outputDirectory }) + '\n')
process.exitCode = contract.exitCode

function renderCsv(value: typeof contract): string {
  const columns = ['decision', 'classification', 'baselineConfigHash', 'candidateConfigHash', 'pairedTasks', 'repeats', 'flakyTasks', 'infrastructureFailures', 'violations', 'reportId', 'inputEvidenceHash']
  const row = [value.decision, value.classification, value.baselineConfigHash, value.candidateConfigHash, value.pairedTasks, value.repeats, value.flakyTasks.join('|'), value.infrastructureFailures.join('|'), value.violations.map((entry) => entry.rule).join('|'), value.report.reportId, value.report.inputEvidenceHash]
  return columns.join(',') + '\n' + row.map(csv).join(',') + '\n'
}
function renderJunit(value: typeof contract): string {
  const failure = value.decision === 'block' ? '<failure type="agent-evaluation-regression" message="Release gate blocked">' + xml(value.violations.map((entry) => entry.rule + '=' + String(entry.observed)).join('; ')) + '</failure>' : ''
  const skipped = value.decision === 'indeterminate' ? '<skipped message="Agent evaluation gate is indeterminate">' + xml(value.classification) + '</skipped>' : ''
  return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="' + (value.decision === 'block' ? '1' : '0') + '" skipped="' + (value.decision === 'indeterminate' ? '1' : '0') + '"><testsuite name="agent-evaluation-release-gate" tests="1"><testcase classname="agent-evaluation" name="paired baseline candidate gate">' + failure + skipped + '<system-out>' + xml('baseline=' + value.baselineConfigHash + '; candidate=' + value.candidateConfigHash + '; report=' + value.report.reportId) + '</system-out></testcase></testsuite></testsuites>\n'
}
function renderSarif(value: typeof contract): string {
  const results = value.violations.map((violation) => ({ ruleId: violation.rule, level: 'error', message: { text: violation.rule + ' observed ' + String(violation.observed) + ' exceeds ' + String(violation.threshold) }, properties: { baselineConfigHash: value.baselineConfigHash, candidateConfigHash: value.candidateConfigHash, evidenceRefs: value.evidenceRefs } }))
  return JSON.stringify({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'Agent Evaluation Release Gate', semanticVersion: '1.0.0', rules: value.violations.map((entry) => ({ id: entry.rule })) } }, results, properties: { decision: value.decision, classification: value.classification, reportId: value.report.reportId } }] }, null, 2) + '\n'
}
function renderMarkdown(value: typeof contract): string {
  const report = value.report.url ? '[' + value.report.reportId + '](' + value.report.url + ')' : String.fromCharCode(96) + value.report.reportId + String.fromCharCode(96)
  const violations = value.violations.length ? value.violations.map((entry) => '- ' + entry.rule + ': ' + String(entry.observed) + ' (limit ' + String(entry.threshold) + ')').join('\n') : '- None'
  return '## Agent evaluation release gate\n\n| Result | Classification | Paired tasks | Repeats |\n|---|---|---:|---:|\n| **' + value.decision.toUpperCase() + '** | ' + value.classification + ' | ' + String(value.pairedTasks) + ' | ' + String(value.repeats) + ' |\n\n- Baseline config: ' + String.fromCharCode(96) + value.baselineConfigHash + String.fromCharCode(96) + '\n- Candidate config: ' + String.fromCharCode(96) + value.candidateConfigHash + String.fromCharCode(96) + '\n- Flaky tasks: ' + (value.flakyTasks.join(', ') || 'none') + '\n- Infrastructure failures: ' + (value.infrastructureFailures.join(', ') || 'none') + '\n- Report: ' + report + '\n\n### Violations\n\n' + violations + '\n'
}
function exitCode(decision: 'pass' | 'block' | 'indeterminate'): number { return decision === 'pass' ? 0 : decision === 'block' ? 1 : 2 }
function csv(value: unknown): string { const text = String(value); return /[",\n\r]/u.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') }
function required(name: string, environmentName: string): string { const value = option(name) ?? process.env[environmentName]; if (!value) throw new Error(name + ' or ' + environmentName + ' is required'); return value }
function option(name: string): string | undefined { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index]!.slice(name.length + 1) }
