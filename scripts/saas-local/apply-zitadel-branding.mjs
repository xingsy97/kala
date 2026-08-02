#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const origin = process.env.ZITADEL_ADMIN_ORIGIN ?? 'http://localhost:13002'
const instanceHost = process.env.ZITADEL_PUBLIC_HOST ?? 'localhost:13002'
const root = resolve(process.env.SAAS_BRANDING_DIR ?? 'deploy/saas/branding')
const pat = process.env.ZITADEL_PAT?.trim() || execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${process.env.ZITADEL_BOOTSTRAP_VOLUME ?? 'agent-runlab-saas_zitadel-bootstrap'}:/bootstrap:ro`, 'alpine:3.22.2', 'cat', '/bootstrap/bootstrap.pat'], { encoding: 'utf8' }).trim()
if (!pat) throw new Error('ZITADEL bootstrap PAT is empty')
const headers = { authorization: `Bearer ${pat}`, 'x-zitadel-instance-host': instanceHost }
async function request(path, init = {}, options = {}) { const response = await fetch(`${origin}${path}`, { ...init, headers: { ...headers, ...init.headers } }); if (!response.ok) { const text = await response.text(); if (options.allowUnchanged && response.status === 400 && text.includes('has not been changed')) return response; throw new Error(`${path} ${response.status}: ${text}`) } return response }
await request('/admin/v1/policies/label', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ primaryColor: '#0f766e', warnColor: '#dc2626', backgroundColor: '#f8fafc', fontColor: '#0f172a', primaryColorDark: '#2dd4bf', backgroundColorDark: '#09090b', warnColorDark: '#f87171', fontColorDark: '#f8fafc', hideLoginNameSuffix: true, disableWatermark: true, themeMode: 'THEME_MODE_AUTO' }) }, { allowUnchanged: true })
for (const [file, path] of [['logo-light.svg','logo'],['logo-dark.svg','logo/dark'],['icon.svg','icon'],['icon-dark.svg','icon/dark']]) { const form = new FormData(); form.set('file', new Blob([await readFile(resolve(root, file))], { type: 'image/svg+xml' }), file); await request(`/assets/v1/instance/policy/label/${path}`, { method: 'POST', body: form }) }
const loginText = resolve(root, 'login-text-en.json'); await request('/admin/v1/text/login/en', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: await readFile(loginText, 'utf8') })
await request('/admin/v1/policies/label/_activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
console.log(JSON.stringify({ ok: true, origin, assets: ['logo','logo/dark','icon','icon/dark'] }))
