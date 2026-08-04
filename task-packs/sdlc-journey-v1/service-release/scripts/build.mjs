import { cp, mkdir, rm, writeFile } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await cp('src/service.mjs', 'dist/service.mjs')
await writeFile('dist/package.json', JSON.stringify({ name: 'sdlc-service-release', private: true, type: 'module' }, null, 2) + '\n')
