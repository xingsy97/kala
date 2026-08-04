#!/usr/bin/env node
const names = process.argv.slice(2)
if (names.length !== 1) {
  process.stderr.write('usage: program <name>\n')
  process.exitCode = 2
} else {
  process.stdout.write(`hello ${names[0]}\n`)
}
