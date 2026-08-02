import { useEffect, useState } from 'react'
import type { AccountOrganization, AccountProfile } from '../../auth-session.js'
import { Button } from '../../components/ui/button.js'

export type PublicBrowserSession = {
  id: string
  current: boolean
  device: { label: string }
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export function AccountCenter({ profile, organization, onClose }: { profile: AccountProfile; organization?: AccountOrganization; onClose(): void }): JSX.Element {
  const [sessions, setSessions] = useState<PublicBrowserSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = async (): Promise<void> => {
    setLoading(true); setError(null)
    try {
      const response = await fetch('/auth/sessions', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(response.status === 401 ? 'Your session expired. Sign in again.' : 'Signed-in devices could not be loaded.')
      setSessions(((await response.json()) as { sessions: PublicBrowserSession[] }).sessions)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const revoke = async (session: PublicBrowserSession): Promise<void> => {
    const response = await fetch(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
    if (!response.ok) { setError(`Unable to revoke session: HTTP ${response.status}`); return }
    if (session.current) { location.assign('/auth/login?prompt=login'); return }
    await load()
  }
  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-background" data-testid="account-center">
      <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur">
        <div><h1 className="text-base font-semibold">Account</h1><p className="text-xs text-muted-foreground">Profile, sessions, security, and product information</p></div>
        <Button type="button" variant="ghost" onClick={onClose} className="h-11" data-testid="account-center-close">Close</Button>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 px-4 py-6">
        <section className="rounded-lg bg-card/70 p-4 shadow-sm"><h2 className="font-semibold">Profile</h2><div className="mt-3 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-primary/15 font-semibold text-primary">{profile.initials}</span><div><div className="font-medium">{profile.displayName}</div>{profile.email ? <div className="text-sm text-muted-foreground">{profile.email}</div> : null}{organization ? <div className="mt-1 text-xs text-muted-foreground">{organization.name} · {organization.role}</div> : null}</div></div><p className="mt-3 text-xs text-muted-foreground">Password, MFA, Passkeys, and identity details are managed by your identity provider.</p></section>
        <section className="rounded-lg border border-border p-4"><h2 className="font-semibold">Signed-in devices</h2><p className="mt-1 text-xs text-muted-foreground">Revoke a browser session immediately.</p>{loading ? <div className="mt-4 text-sm text-muted-foreground" role="status">Loading sessions…</div> : error ? <div className="mt-4 text-sm text-destructive" role="alert">{error} <button type="button" onClick={() => void load()} className="underline">Retry</button></div> : <div className="mt-4 grid gap-2" data-testid="account-session-list">{sessions.map((session) => <div key={session.id} className="flex items-start justify-between gap-3 rounded-md bg-muted/30 p-3" data-testid={`account-session-${session.id}`}><div><div className="text-sm font-medium">{session.device.label}{session.current ? ' · This device' : ''}</div><div className="mt-1 text-xs text-muted-foreground">Last active {new Date(session.lastSeenAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</div></div><button type="button" onClick={() => void revoke(session)} className="min-h-10 rounded border border-border px-3 text-xs text-destructive hover:bg-destructive/10">Sign out</button></div>)}</div>}</section>
        <section className="rounded-lg border border-border p-4"><h2 className="font-semibold">Product and legal</h2><div className="mt-3 flex flex-wrap gap-3 text-sm"><a href="#/docs" className="text-primary underline">Help & documentation</a><a href="/privacy" className="text-primary underline">Privacy</a><a href="/terms" className="text-primary underline">Terms</a></div></section>
        <section className="rounded-lg border border-destructive/40 p-4"><h2 className="font-semibold">Sign out everywhere</h2><p className="mt-1 text-xs text-muted-foreground">Immediately revoke every Agent RunLab browser session for this account.</p><form method="post" action="/auth/logout-all" onSubmit={() => { setTimeout(() => location.replace('/signed-out'), 0) }} className="mt-3"><button type="submit" className="min-h-11 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground">Sign out all devices</button></form></section>
      </main>
    </div>
  )
}
