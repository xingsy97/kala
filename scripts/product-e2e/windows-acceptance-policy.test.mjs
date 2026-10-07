import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const read = async (path) => await readFile(resolve(root, path), 'utf8')

function job(source, name, nextName) {
  const start = source.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `missing ${name} job`)
  const end = nextName ? source.indexOf(`  ${nextName}:`, start) : source.length
  assert.notEqual(end, -1, `missing ${nextName} job boundary`)
  return source.slice(start, end)
}

test('Windows Host CJS stages only a matching Windows x64 Copilot runtime', async () => {
  const builder = await read('scripts/release/build-release-assets.mjs')
  assert.match(builder, /const copilotRuntimeTargets = nativeTargets/u)
  assert.match(builder, /const packageName = `@github\/copilot-sdk-\$\{target\}`/u)
  assert.match(builder, /const wrapperName = process\.platform === 'win32' \? 'copilot-runtime\.exe' : 'copilot-runtime'/u)
  assert.match(builder, /stageCopilotRuntime\(nativeTarget \?\? detectNativeTarget\(\)\)/u)
  assert.doesNotMatch(builder, /stageCopilotRuntime\(['"]linux-x64['"]\)/u)
})

test('hosted Windows acceptance keeps Host CJS and native Executor targets separate and never uses Box', async () => {
  const workflow = await read('.github/workflows/product-system-e2e.yml')
  const host = job(workflow, 'windows-host-cjs-e2e', 'windows-executor-conpty-e2e')
  const executor = job(workflow, 'windows-executor-conpty-e2e', 'linux-system-e2e')

  for (const source of [host, executor]) {
    assert.match(source, /^    runs-on: windows-latest$/mu)
    assert.doesNotMatch(source, /if:\s*false|self-hosted|\bbox\b|docker|podman|playwright|chromium/iu)
    assert.match(source, /Require GNU tar and gzip from Git for Windows for reproducible archives/u)
    assert.match(source, /Git\\usr\\bin[\s\S]*GITHUB_PATH/u)
    assert.match(source, /TAR_OPTIONS=--force-local/u)
  }
  assert.match(host, /--component host/u)
  assert.match(host, /PRODUCT_E2E_WINDOWS_TARGET: host/u)
  assert.doesNotMatch(host, /--native-only|PRODUCT_E2E_WINDOWS_TARGET: executor/u)

  assert.match(executor, /--component executor --native-only --native-target win32-x64/u)
  assert.match(executor, /kala-executor-win32-x64\.exe/u)
  assert.match(executor, /node-pty-win32-x64\.tar\.gz/u)
  assert.match(executor, /prepare-windows-release-fixture\.mjs --host-release/u)
  assert.match(executor, /PRODUCT_E2E_WINDOWS_TARGET: executor/u)
  assert.match(executor, /PRODUCT_E2E_WINDOWS_SERVICE: '1'/u)
  assert.doesNotMatch(executor, /continue-on-error/u)
})

test('Windows verifier fails closed on missing payloads, missing ConPTY, and unsupported Host integration', async () => {
  const verifier = await read('scripts/product-e2e/verify-windows-terminal.mjs')
  assert.match(verifier, /KALA_RELEASE_ASSETS_DIR: hostRelease/u)
  for (const required of [
    'kala-dashboard-with-runtime.cjs',
    'kala-copilot-runtime-win32-x64',
    'kala-copilot-runtime-node-win32-x64.node',
    'kala-executor-win32-x64.exe',
    'conpty.node',
    'conpty_console_list.node',
    'pty.node',
    'winpty-agent.exe',
    'winpty.dll',
  ]) assert.match(verifier, new RegExp(required.replaceAll('.', '\\.'), 'u'))
  assert.match(verifier, /platform: 'windows'/u)
  assert.match(verifier, /windows_installation_unsupported/u)
  assert.match(verifier, /integrate the Windows assets into the global release inventory before accepting this target/u)
  assert.match(verifier, /\[Console\]::IsOutputRedirected/u)
  assert.match(verifier, /join\(process\.env\.ProgramFiles, 'Kala', 'Executor'\)/u)
  assert.match(verifier, /join\(process\.env\.ProgramData, 'Kala', 'Executor'\)/u)
  assert.doesNotMatch(verifier, /runlab-executor|Agent RunLab/u)
  assert.match(verifier, /process\.platform !== 'win32' \|\| process\.arch !== 'x64'/u)
})
