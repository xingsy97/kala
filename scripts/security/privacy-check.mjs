#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatFindings, loadPrivacyPolicy, loadPrivateDenylist, scanEntry } from './privacy-check-lib.mjs'

const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
if (rootResult.status !== 0) {
  process.stderr.write(rootResult.stderr || 'Privacy gate must run inside a Git worktree.\n')
  process.exit(rootResult.status ?? 1)
}
const root = rootResult.stdout.trim()
const mode = process.argv[2] ?? '--staged'
const policy = loadPrivacyPolicy(root)
const commonGitDir = git(['rev-parse', '--git-common-dir']).trim()
const denylistPath = resolve(root, commonGitDir, 'privacy-denylist')
const denylist = loadPrivateDenylist(root, process.env, denylistPath)
let findings = []

if (mode === '--staged') findings = scanStaged()
else if (mode === '--message') findings = scanMessage(process.argv[3])
else if (mode === '--range') findings = scanRange(process.argv[3])
else if (mode === '--pre-push') findings = scanPushInput(readFileSync(0, 'utf8'), process.argv[3])
else if (mode === '--repository') findings = scanWorktree()
else usage()

if (findings.length) {
  process.stderr.write(`${formatFindings(findings)}\nPrivacy gate blocked ${findings.length} finding(s); sensitive values were not printed.\n`)
  process.exit(1)
}
process.stdout.write(`PASS privacy gate (${mode})\n`)

function scanStaged() {
  const entries = parseNameStatus(gitBuffer(['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR']))
  const metadata = [
    ['AUTHOR', git(['var', 'GIT_AUTHOR_IDENT'])],
    ['COMMITTER', git(['var', 'GIT_COMMITTER_IDENT'])],
  ]
  const metadataFindings = metadata.flatMap(([label, identity]) => scanEntry({ path: label, content: identity, policy, denylist, source: 'message' }))
  return [...metadataFindings, ...scanPaths(entries.map(({ path }) => path), (path) => gitBuffer(['show', `:${path}`]))]
}

function scanMessage(path) {
  if (!path) usage()
  return scanEntry({ path: 'COMMIT_MESSAGE', content: readFileSync(resolve(path), 'utf8'), policy, denylist, source: 'message' })
}

function scanRange(range) {
  if (!range) usage()
  const commits = git(['rev-list', '--reverse', range]).trim().split('\n').filter(Boolean)
  return commits.flatMap(scanCommit)
}

function scanPushInput(input, remoteName) {
  const commitSets = []
  for (const line of input.trim().split(/\r?\n/).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(/\s+/)
    if (!localSha || isZeroOid(localSha)) continue
    if (remoteSha && !isZeroOid(remoteSha)) {
      const remoteExists = spawnSync('git', ['cat-file', '-e', `${remoteSha}^{commit}`], { cwd: root }).status === 0
      commitSets.push(git(['rev-list', '--reverse', ...(remoteExists ? [`${remoteSha}..${localSha}`] : [localSha])]))
    } else {
      const exclusions = remoteName ? git(['for-each-ref', '--format=%(refname)', `refs/remotes/${remoteName}/`]).trim().split('\n').filter(Boolean) : []
      commitSets.push(git(['rev-list', '--reverse', localSha, ...(exclusions.length ? ['--not', ...exclusions] : [])]))
    }
  }
  const commits = [...new Set(commitSets.flatMap((value) => value.trim().split('\n').filter(Boolean)))]
  return commits.flatMap(scanCommit)
}

function scanCommit(commit) {
  const message = gitBuffer(['show', '-s', '--format=%B', commit])
  const messageFindings = scanEntry({ path: `COMMIT_MESSAGE@${commit.slice(0, 12)}`, content: message, policy, denylist, source: 'message' })
  const metadata = git(['show', '-s', '--format=%aE%n%cE', commit]).trim().split('\n')
  const metadataFindings = metadata.flatMap((email, index) => scanEntry({ path: `${index ? 'COMMITTER' : 'AUTHOR'}@${commit.slice(0, 12)}`, content: email, policy, denylist, source: 'message' }))
  const entries = parseNameStatus(gitBuffer(['diff-tree', '--root', '-m', '--no-commit-id', '--name-status', '-r', '-z', '--diff-filter=ACMR', commit]))
  const paths = entries.map(({ path }) => path)
  return [...messageFindings, ...metadataFindings, ...scanPaths(paths, (path) => gitBuffer(['show', `${commit}:${path}`]), 'history-file')]
}

function scanTree(tree) {
  const paths = gitBuffer(['ls-tree', '-r', '-z', '--name-only', tree]).toString('utf8').split('\0').filter(Boolean)
  return scanPaths(paths, (path) => gitBuffer(['show', `${tree}:${path}`]))
}

function scanWorktree() {
  const tracked = gitBuffer(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)
  const untracked = gitBuffer(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)
  const paths = [...new Set([...tracked, ...untracked])].filter((path) => {
    try { const stat = lstatSync(resolve(root, path)); return stat.isFile() || stat.isSymbolicLink() }
    catch { return false }
  })
  return scanPaths(paths, (path) => {
    const fullPath = resolve(root, path)
    return lstatSync(fullPath).isSymbolicLink() ? Buffer.from(readlinkSync(fullPath)) : readFileSync(fullPath)
  })
}

function scanPaths(paths, read, source = 'file') {
  return [...new Set(paths)].flatMap((path) => [
    ...scanEntry({ path, content: read(path), policy, denylist, source }),
    ...scanEntry({ path, content: path, policy, denylist, source: 'path' }),
  ])
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (status.startsWith('R') || status.startsWith('C')) index++
    entries.push({ status, path: fields[index++] })
  }
  return entries
}

function git(args) { return gitBuffer(args).toString('utf8') }
function gitBuffer(args) {
  const result = spawnSync('git', args, { cwd: root || process.cwd(), encoding: null, maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString('utf8') || `git ${args[0]} failed\n`)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}
function isZeroOid(value) { return /^0+$/.test(value) }

function usage() {
  process.stderr.write('Usage: privacy-check.mjs --staged | --message <file> | --range <revision-range> | --pre-push | --repository\n')
  process.exit(2)
}
