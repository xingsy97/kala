import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button.js'
import { ProductState } from '../../components/ui/product-state.js'

type Row = Record<string, any>
type TFunction = ReturnType<typeof useTranslation>['t']
export type OrganizationSnapshot = { organization: Row; role: 'owner' | 'admin' | 'member' | 'viewer'; permissions: string[]; members: Row[]; entitlement?: Row; retention?: Row; usage?: Row; workspaces: Row[]; executorPools: Row[]; executors: Row[]; invites: Row[]; browserSessions: Row[]; serviceAccounts: Row[]; webhooks: Row[]; audit: Row[]; integrations: Row }
const tabs = ['overview', 'members', 'workspaces', 'executors', 'policies', 'usage', 'integrations'] as const
type AdminTab = (typeof tabs)[number]

async function mutate(path: string, method: string, body?: unknown): Promise<void> {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
}

export function AdminCenter({ onClose }: { onClose(): void }): JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<OrganizationSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<AdminTab>('overview')
  const load = async (): Promise<void> => {
    setError(null)
    try {
      const response = await fetch('/organization', { cache: 'no-store' })
      if (!response.ok) throw new Error(t('admin.loadFailed'))
      setSnapshot(await response.json())
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  useEffect(() => { void load() }, [])
  const canManage = snapshot?.permissions.includes('organization:manage') ?? false
  const canPolicy = snapshot?.permissions.includes('policy:manage') ?? false
  return <div className="fixed inset-0 z-[71] overflow-y-auto bg-background" data-testid="admin-center">
    <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between border-b bg-background/95 px-4"><div><h1 className="font-semibold">{t('admin.title')}</h1><p className="text-xs text-muted-foreground">{t('admin.subtitle')}</p></div><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></header>
    <main className="mx-auto max-w-6xl p-4 md:p-6">{error ? <ProductState kind="forbidden" title={t('admin.unavailable')} description={error} primary={{ label: t('common.retry'), onClick: () => void load() }} /> : !snapshot ? <ProductState kind="loading" title={t('admin.loading')} description={t('admin.resolving')} /> : <>
      <nav className="mb-5 flex gap-1 overflow-x-auto">{tabs.map((item) => <Button key={item} size="sm" variant={tab === item ? 'outline' : 'ghost'} onClick={() => setTab(item)}>{t(`admin.tabs.${item}`)}</Button>)}</nav>
      {tab === 'overview' ? <Overview snapshot={snapshot} t={t} /> : null}
      {tab === 'members' ? <Members snapshot={snapshot} canManage={canManage} load={load} setError={setError} t={t} /> : null}
      {tab === 'workspaces' ? <Workspaces snapshot={snapshot} t={t} /> : null}
      {tab === 'executors' ? <Executors snapshot={snapshot} t={t} /> : null}
      {tab === 'policies' ? <Policies snapshot={snapshot} canPolicy={canPolicy} load={load} setError={setError} t={t} /> : null}
      {tab === 'usage' ? <UsageSecurity snapshot={snapshot} t={t} /> : null}
      {tab === 'integrations' ? <Integrations snapshot={snapshot} t={t} /> : null}
    </>}</main>
  </div>
}

function Overview({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element {
  return <Grid><Card title={snapshot.organization.name}><KV rows={{ [t('admin.labels.status')]: snapshot.organization.status, [t('admin.labels.role')]: snapshot.role, [t('admin.labels.runtimeUnit')]: snapshot.organization.runtime_unit_id }} /></Card><Card title={t('admin.contract')}><KV rows={{ [t('admin.labels.reference')]: snapshot.entitlement?.contract_reference, [t('admin.labels.tier')]: snapshot.entitlement?.support_tier, [t('admin.labels.ends')]: snapshot.entitlement?.ends_at, [t('admin.labels.seats')]: snapshot.entitlement?.seat_limit, [t('admin.labels.concurrentSessions')]: snapshot.entitlement?.concurrent_session_limit, [t('admin.labels.monthlyTokens')]: snapshot.entitlement?.monthly_token_limit ?? t('admin.unlimited') }} /></Card><Card title={t('admin.currentMonth')}><KV rows={{ [t('admin.labels.tokens')]: snapshot.usage?.tokens ?? 0, [t('admin.labels.sessions')]: snapshot.usage?.sessions ?? 0, [t('admin.labels.ledger')]: snapshot.usage?.entries ?? 0 }} /></Card></Grid>
}
function Members({ snapshot, canManage, load, setError, t }: { snapshot: OrganizationSnapshot; canManage: boolean; load(): Promise<void>; setError(value: string): void; t: TFunction }): JSX.Element {
  return <Card title={t('admin.tabs.members')} action={canManage ? <Button size="sm" onClick={() => void addMember(snapshot, load, setError, t)}>{t('admin.addMember')}</Button> : undefined}>{snapshot.members.map((member) => <Line key={`${member.issuer}:${member.subject}`} title={member.displayName || member.email || member.subject} subtitle={member.email || member.subject} right={<div className="flex gap-2"><select disabled={!canManage || member.role === 'owner'} value={member.role} onChange={(event) => void mutate('/organization/members', 'PATCH', { issuer: member.issuer, subject: member.subject, role: event.target.value }).then(load).catch((reason) => setError(String(reason)))} className="rounded border bg-background px-2"><option>admin</option><option>member</option><option>viewer</option><option>owner</option></select>{canManage && member.role !== 'owner' ? <Button size="sm" variant="destructive" onClick={() => void mutate('/organization/members', 'DELETE', { issuer: member.issuer, subject: member.subject }).then(load)}>{t('admin.remove')}</Button> : null}</div>} />)}</Card>
}
function Workspaces({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <Grid><Card title={t('admin.tabs.workspaces')}>{snapshot.workspaces.length ? snapshot.workspaces.map((workspace) => <Line key={workspace.id} title={workspace.name} subtitle={`${workspace.status} · policy v${workspace.policy_version}`} />) : <Empty text={t('admin.noWorkspaces')} />}</Card><Card title={t('admin.executorPools')}>{snapshot.executorPools.map((pool) => <Line key={pool.id} title={pool.name} subtitle={`${pool.mode}${pool.workspace_id ? ` · ${pool.workspace_id}` : ''}`} />)}</Card></Grid> }
function Executors({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <Grid><Card title={t('admin.tabs.executors')}>{snapshot.executors.length ? snapshot.executors.map((executor) => <Line key={executor.id} title={executor.name} subtitle={`${executor.status} · ${t('admin.lastSeen', { value: executor.last_seen_at || t('admin.never') })}`} />) : <Empty text={t('admin.noExecutors')} />}</Card><Card title={t('admin.pendingInvites')}>{snapshot.invites.length ? snapshot.invites.map((invite) => <Line key={invite.id} title={invite.email_normalized} subtitle={`${invite.role} · ${t('admin.expires', { value: invite.expires_at })}`} />) : <Empty text={t('admin.noInvites')} />}</Card></Grid> }
function Policies({ snapshot, canPolicy, load, setError, t }: { snapshot: OrganizationSnapshot; canPolicy: boolean; load(): Promise<void>; setError(value: string): void; t: TFunction }): JSX.Element { return <Card title={t('admin.retention')} action={canPolicy ? <Button size="sm" onClick={() => void editRetention(snapshot, load, setError, t)}>{t('admin.edit')}</Button> : undefined}><KV rows={{ [t('admin.labels.sessionDays')]: snapshot.retention?.session_days, [t('admin.labels.artifactDays')]: snapshot.retention?.artifact_days, [t('admin.labels.auditDays')]: snapshot.retention?.audit_days, [t('admin.labels.deletedGrace')]: snapshot.retention?.deleted_resource_grace_days, [t('admin.labels.version')]: snapshot.retention?.version }} /></Card> }
function UsageSecurity({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <Grid><Card title={t('admin.browserSessions')}>{snapshot.browserSessions.map((session) => <Line key={session.id} title={session.device?.browser || 'Browser'} subtitle={`${t('admin.lastActive', { value: session.last_seen_at })}${session.revoked_at ? ` · ${t('admin.revoked')}` : ''}`} />)}</Card><Card title={t('admin.serviceAccounts')}>{snapshot.serviceAccounts.length ? snapshot.serviceAccounts.map((account) => <Line key={account.id} title={account.display_name || account.email || account.id} subtitle={(account.scopes || []).join(', ')} />) : <Empty text={t('admin.noServiceAccounts')} />}</Card><Card title={t('admin.webhooks')}>{snapshot.webhooks.length ? snapshot.webhooks.map((webhook) => <Line key={webhook.id} title={webhook.url} subtitle={`${t(webhook.enabled ? 'admin.enabled' : 'admin.disabled')} · ${(webhook.topics || []).join(', ')}`} />) : <Empty text={t('admin.noWebhooks')} />}</Card><Card title={t('admin.auditLog')}>{snapshot.audit.length ? snapshot.audit.map((event) => <Line key={event.id} title={event.action} subtitle={`${event.result} · ${event.occurred_at}`} />) : <Empty text={t('admin.noAudit')} />}</Card></Grid> }
function Integrations({ snapshot, t }: { snapshot: OrganizationSnapshot; t: TFunction }): JSX.Element { return <Card title={t('admin.adapters')}><KV rows={{ [t('admin.labels.secrets')]: snapshot.integrations?.secrets, [t('admin.labels.artifacts')]: snapshot.integrations?.artifacts, [t('admin.labels.telemetry')]: t(snapshot.integrations?.telemetry ? 'admin.connected' : 'admin.notConfigured'), [t('admin.labels.errorReporting')]: t(snapshot.integrations?.errorReporting ? 'admin.connected' : 'admin.notConfigured'), [t('admin.labels.ticketing')]: t(snapshot.integrations?.ticketing ? 'admin.connected' : 'admin.notConfigured') }} /><p className="mt-3 text-xs text-muted-foreground">{t('admin.adaptersDescription')}</p></Card> }

function Grid({ children }: { children: React.ReactNode }): JSX.Element { return <div className="grid gap-5 md:grid-cols-2">{children}</div> }
function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element { return <section className="rounded-xl border bg-card/70 p-5"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2>{action}</div>{children}</section> }
function Line({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }): JSX.Element { return <div className="flex items-center justify-between gap-3 border-t py-3 first:border-0"><div className="min-w-0"><div className="truncate text-sm font-medium">{title}</div>{subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}</div>{right}</div> }
function KV({ rows }: { rows: Record<string, unknown> }): JSX.Element { return <dl className="grid gap-2 text-sm">{Object.entries(rows).map(([key, value]) => <div key={key} className="flex justify-between gap-4"><dt className="text-muted-foreground">{key}</dt><dd className="text-right">{String(value ?? '—')}</dd></div>)}</dl> }
function Empty({ text }: { text: string }): JSX.Element { return <p className="text-sm text-muted-foreground">{text}</p> }
async function addMember(snapshot: OrganizationSnapshot, reload: () => Promise<void>, fail: (value: string) => void, t: TFunction): Promise<void> { const issuer = prompt(t('admin.prompts.issuer')); const subject = prompt(t('admin.prompts.subject')); const email = prompt(t('admin.prompts.email')); const role = prompt(t('admin.prompts.role'), 'member'); if (!issuer || !subject || !role) return; try { await mutate('/organization/members', 'POST', { issuer, subject, email, role }); await reload() } catch (reason) { fail(String(reason)) } }
async function editRetention(snapshot: OrganizationSnapshot, reload: () => Promise<void>, fail: (value: string) => void, t: TFunction): Promise<void> { const value = (label: string, key: string): number => Number(prompt(label, String(snapshot.retention?.[key] ?? 30))); try { await mutate('/organization/retention', 'PUT', { sessionDays: value(t('admin.labels.sessionDays'), 'session_days'), artifactDays: value(t('admin.labels.artifactDays'), 'artifact_days'), auditDays: value(t('admin.labels.auditDays'), 'audit_days'), deletedResourceGraceDays: value(t('admin.labels.deletedGrace'), 'deleted_resource_grace_days') }); await reload() } catch (reason) { fail(String(reason)) } }
