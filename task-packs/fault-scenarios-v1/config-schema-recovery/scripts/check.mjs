import { readFile } from 'node:fs/promises'

import { parseServiceConfig } from '../src/config.mjs'

const path = process.argv[2]
if (!path) throw new Error('usage: node scripts/check.mjs <config>')
const config = parseServiceConfig(await readFile(path, 'utf8'))
process.stdout.write(JSON.stringify({ status: 'ok', port: config.port, greeting: config.greeting }) + '\n')
