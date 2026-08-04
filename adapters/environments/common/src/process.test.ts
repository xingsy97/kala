import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runProcess, runProcessToFile } from './process.js'

describe('runProcess live output', () => {
  it('observes complete UTF-8 output before process completion', async () => {
    const chunks: string[] = []
    let completed = false
    const running = runProcess({
      command: process.execPath, args: ['-e', "process.stdout.write(Buffer.from([0xe4,0xbd])); setTimeout(() => { process.stdout.write(Buffer.from([0xa0,0x0a])); setTimeout(() => {}, 40) }, 10)"], timeoutMs: 2_000,
      onStdout: (chunk) => { chunks.push(chunk); expect(completed).toBe(false) },
    }).then((result) => { completed = true; return result })
    const result = await running
    expect(chunks.join('')).toBe('你\n')
    expect(result.stdout).toBe('你\n')
  })

  it('terminates the process when an output observer fails', async () => {
    await expect(runProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('event\n'); setInterval(() => {}, 1000)"], timeoutMs: 5_000,
      onStdout: () => { throw new Error('observer failed') },
    })).rejects.toThrow('observer failed')
  })

  it('streams binary stdout to an atomically committed file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-process-output-'))
    const destination = join(directory, 'archive.bin')
    try {
      const result = await runProcessToFile({
        command: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([0, 255, 128, 10]))'],
        destination, timeoutMs: 2_000,
      })
      expect(result).toMatchObject({ exitCode: 0, stdout: '', timedOut: false })
      expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 128, 10]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not commit partial output from a failed producer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-process-output-'))
    const destination = join(directory, 'archive.bin')
    try {
      const result = await runProcessToFile({
        command: process.execPath, args: ['-e', "process.stdout.write('partial'); process.exitCode = 7"],
        destination, timeoutMs: 2_000,
      })
      expect(result.exitCode).toBe(7)
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
