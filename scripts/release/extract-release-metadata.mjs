#!/usr/bin/env node
import { resolve } from 'node:path'
import { extractReleaseMetadataArchive } from './release-archives.mjs'

const args = process.argv.slice(2)
if (args.length !== 2 || args.includes('--help') || args.includes('-h')) {
  process.stderr.write('Usage: node scripts/release/extract-release-metadata.mjs <kala-release-metadata.tar.gz> <empty-output-directory>\n')
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 2)
}

extractReleaseMetadataArchive(resolve(args[0]), resolve(args[1]))
