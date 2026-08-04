#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const ciRoot = join(root, 'deploy/evaluation/ci')
const fixtures = join(ciRoot, 'fixtures')
const cli = join(root, 'packages/eval-orchestrator/dist/bin/eval-ci.js')
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-ci-integrations-'))
const standaloneContractClaim = 'three CI examples consuming one versioned standalone machine-readable gate contract'

try {
  const integrations = [
    { id: 'github-actions', file: 'github-actions.yml', extract: githubCommands, artifact: verifyGithubArtifacts },
    { id: 'gitlab-ci', file: 'gitlab-ci.yml', extract: gitlabCommands, artifact: verifyGitlabArtifacts },
    { id: 'jenkins', file: 'Jenkinsfile', extract: jenkinsCommands, artifact: verifyJenkinsArtifacts },
  ]
  const executions = []
  for (const integration of integrations) {
    const source = await readFile(join(ciRoot, integration.file), 'utf8')
    if (source.includes('regression.evaluate') || source.includes('decideRegressionGate')) throw new Error(integration.id + ' duplicates gate decision logic')
    const declaredCommands = integration.extract(source)
    const gateCommands = declaredCommands.filter((command) => command.includes('packages/eval-orchestrator/dist/bin/eval-ci.js'))
    if (gateCommands.length !== 1) throw new Error(integration.id + ' must declare exactly one eval-ci command, found ' + String(gateCommands.length))
    const gateCommand = gateCommands[0]
    assertGateCommand(gateCommand, integration.id)
    const artifactContract = integration.artifact(source)
    const workspace = join(temporary, integration.id)
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    await symlink(join(root, 'packages'), join(workspace, 'packages'), 'dir')
    const result = await run('/bin/sh', ['-eu', '-c', gateCommand], [0], {
      cwd: workspace,
      env: { ...process.env, AGENT_EVAL_GATE_DECISION: join(fixtures, 'pass-decision.json'), AGENT_EVAL_REPORT_MANIFEST: join(fixtures, 'report-manifest.json'), AGENT_EVAL_REPORT_URL: 'https://reports.example.invalid/ci-fixture-report' },
    })
    const output = join(workspace, 'agent-evaluation-ci')
    executions.push({
      integration: integration.id,
      file: 'deploy/evaluation/ci/' + integration.file,
      declaredCommands,
      executedCommand: gateCommand,
      executedCommandSha256: createHash('sha256').update(gateCommand).digest('hex'),
      executionCwd: '<isolated-workspace>',
      artifactContract,
      exitCode: result.code,
      stdout: JSON.parse(result.stdout),
      outputs: await verifyOutputs(output, 'pass'),
    })
  }
  const block = await executeOutcome('block', 1)
  const indeterminate = await executeOutcome('indeterminate', 2)
  if (executions.length !== 3 || new Set(executions.map((entry) => entry.integration)).size !== 3) throw new Error('standalone CI contract requires exactly three distinct platform executions')
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'commands extracted from each CI platform file and executed verbatim in isolated workspaces against one versioned standalone gate contract; no Host sessions or historical evaluation artifacts',
    acceptanceClaim: standaloneContractClaim,
    contract: { cli: 'agent-eval-ci', outputs: ['gate.json', 'gate.csv', 'gate.junit.xml', 'gate.sarif.json', 'gate.md'], exitCodes: { pass: 0, block: 1, indeterminate: 2 } },
    integrations,
    passExecutions: executions,
    blockExecution: block,
    indeterminateExecution: indeterminate,
    sourceHashes: await sourceHashes([
      'packages/eval-orchestrator/bin/eval-ci.ts', 'deploy/evaluation/ci/github-actions.yml', 'deploy/evaluation/ci/gitlab-ci.yml', 'deploy/evaluation/ci/Jenkinsfile',
      'deploy/evaluation/ci/fixtures/pass-decision.json', 'deploy/evaluation/ci/fixtures/block-decision.json', 'deploy/evaluation/ci/fixtures/indeterminate-decision.json', 'deploy/evaluation/ci/fixtures/report-manifest.json',
      'scripts/evaluation/verify-ci-integrations.mjs',
    ]),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, integrations: executions.map((entry) => entry.integration), outputs: evidence.contract.outputs, exitCodes: evidence.contract.exitCodes, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function executeOutcome(name, expectedCode) {
  const output = join(temporary, name)
  const result = await run(process.execPath, [cli, '--decision', join(fixtures, name + '-decision.json'), '--report-manifest', join(fixtures, 'report-manifest.json'), '--output-dir', output], [expectedCode])
  if (result.code !== expectedCode) throw new Error(name + ' returned ' + String(result.code) + ', expected ' + String(expectedCode))
  return { exitCode: result.code, stdout: JSON.parse(result.stdout), outputs: await verifyOutputs(output, name) }
}

async function verifyOutputs(directory, expectedDecision) {
  const files = ['gate.json', 'gate.csv', 'gate.junit.xml', 'gate.sarif.json', 'gate.md']
  const values = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(directory, file), 'utf8')])))
  const contract = JSON.parse(values['gate.json'])
  if (contract.decision !== expectedDecision || contract.baselineConfigHash !== 'a'.repeat(64) || typeof contract.candidateConfigHash !== 'string' || contract.report.inputEvidenceHash !== 'e'.repeat(64)) throw new Error('invalid machine-readable CI gate contract for ' + expectedDecision)
  if (!values['gate.csv'].includes('baselineConfigHash,candidateConfigHash') || !values['gate.junit.xml'].includes('<testsuites') || JSON.parse(values['gate.sarif.json']).version !== '2.1.0' || !values['gate.md'].includes('Agent evaluation release gate')) throw new Error('missing CI output semantics for ' + expectedDecision)
  return Object.fromEntries(files.map((file) => [file, { bytes: Buffer.byteLength(values[file]), sha256: createHash('sha256').update(values[file]).digest('hex') }]))
}

async function run(binary, args, permittedCodes = [0], options = {}) {
  const child = spawn(binary, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []; const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk))
  const code = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('close', resolvePromise) })
  const result = { code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() }
  if (!permittedCodes.includes(code)) throw new Error(binary + ' failed with ' + String(code) + ': ' + result.stderr)
  return result
}
function githubCommands(source) {
  return source.split('\n').flatMap((line) => { const match = /^\s*run:\s*(.+?)\s*$/u.exec(line); return match ? [unquoteYaml(match[1])] : [] })
}
function gitlabCommands(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /^\s{2}script:\s*$/u.test(line))
  if (start < 0) throw new Error('GitLab fixture lacks a script sequence')
  const commands = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line) || /^\s{2}\S/u.test(line)) break
    const match = /^\s{4}-\s+(.+?)\s*$/u.exec(line)
    if (match) commands.push(unquoteYaml(match[1]))
  }
  return commands
}
function jenkinsCommands(source) {
  return [...source.matchAll(/^\s*sh\s+'((?:[^'\\]|\\.)*)'\s*$/gmu)].map((match) => match[1].replaceAll("\\'", "'"))
}
function unquoteYaml(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value)
  return value
}
function assertGateCommand(command, integration) {
  const required = ['node packages/eval-orchestrator/dist/bin/eval-ci.js', '--decision "$AGENT_EVAL_GATE_DECISION"', '--report-manifest "$AGENT_EVAL_REPORT_MANIFEST"', '--report-url "$AGENT_EVAL_REPORT_URL"', '--output-dir agent-evaluation-ci']
  for (const token of required) if (!command.includes(token)) throw new Error(integration + ' declared gate command lacks exact token: ' + token)
  if (/[;&|]/u.test(command) || command.includes(String.fromCharCode(96)) || command.includes('$(')) throw new Error(integration + ' gate command contains undeclared shell composition')
}
function verifyGithubArtifacts(source) {
  if (!source.includes('uses: actions/upload-artifact@v4') || !source.includes('github/codeql-action/upload-sarif@v3') || !/if:\s*always\(\)/u.test(source) || !/name:\s*agent-evaluation-ci/u.test(source) || !/path:\s*agent-evaluation-ci/u.test(source)) throw new Error('GitHub artifact/SARIF preservation contract is incomplete')
  return { mechanism: 'actions/upload-artifact@v4', always: true, path: 'agent-evaluation-ci' }
}
function verifyGitlabArtifacts(source) {
  if (!/artifacts:\s*[\s\S]*?when:\s*always/u.test(source) || !/paths:\s*\[agent-evaluation-ci\]/u.test(source) || !/junit:\s*agent-evaluation-ci\/gate\.junit\.xml/u.test(source)) throw new Error('GitLab artifact/JUnit preservation contract is incomplete')
  return { mechanism: 'artifacts', always: true, path: 'agent-evaluation-ci', junit: 'agent-evaluation-ci/gate.junit.xml' }
}
function verifyJenkinsArtifacts(source) {
  if (!/post\s*\{\s*always\s*\{/u.test(source) || !/archiveArtifacts artifacts:\s*'agent-evaluation-ci\/\*\*'/u.test(source) || !/junit testResults:\s*'agent-evaluation-ci\/gate\.junit\.xml'/u.test(source) || !/sarif\(pattern:\s*'agent-evaluation-ci\/gate\.sarif\.json'\)/u.test(source)) throw new Error('Jenkins artifact/JUnit/SARIF preservation contract is incomplete')
  return { mechanism: 'post/always', always: true, path: 'agent-evaluation-ci/**', junit: 'agent-evaluation-ci/gate.junit.xml' }
}
async function sourceHashes(paths) { return await Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') }))) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
