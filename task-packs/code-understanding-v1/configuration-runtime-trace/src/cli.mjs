#!/usr/bin/env node
import { loadConfig } from './config.mjs'
import { createGreeting } from './runtime.mjs'

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error('usage: cli <name>')
  const config = await loadConfig()
  process.stdout.write(createGreeting(config, args[0]) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 2 })
