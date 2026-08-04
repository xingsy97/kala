#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { format } from './format.mjs'

const args = process.argv.slice(2)
if (args.length !== 1) {
  process.stderr.write('usage: cli <name>\n')
  process.exit(2)
}
const config = JSON.parse(await readFile(new URL('../config/runtime.json', import.meta.url), 'utf8'))
process.stdout.write(format(config.prefix, args[0]) + '\n')
