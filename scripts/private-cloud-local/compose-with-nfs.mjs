#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { composeArgs, selectedProfile } from './profile.mjs'

const args = process.argv.slice(2)
if (args.length === 0) throw new Error('compose arguments are required')
const profile = selectedProfile()
process.stdout.write(`Using Kala deployment profile: ${profile}\n`)
const child = spawn('docker', ['compose', ...composeArgs(profile), ...args], { stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1) })
