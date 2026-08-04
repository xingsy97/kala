import { mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'

await rm('release', { recursive: true, force: true })
await mkdir('release', { recursive: true })
const child = spawn('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', 'release/service.tar', '-C', 'dist', '.'], { stdio: 'inherit' })
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
if (code !== 0) throw new Error('release archive creation failed with exit code ' + String(code))
