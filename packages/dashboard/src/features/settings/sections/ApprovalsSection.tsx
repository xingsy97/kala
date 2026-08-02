import { useTranslation } from 'react-i18next'
import { SectionHeader } from '../controls.js'
export function ApprovalsSection(): JSX.Element {
 const {t}=useTranslation();const modes=[
  {key:'auto',tone:'border-sky-500/30 bg-sky-500/5',title:t('composer.approvalModes.auto.label'),body:t('settings.approvals.auto')},
  {key:'ask',tone:'border-amber-500/30 bg-amber-500/5',title:t('composer.approvalModes.ask.label'),body:t('settings.approvals.ask')},
  {key:'deny',tone:'border-emerald-500/30 bg-emerald-500/5',title:t('composer.approvalModes.deny.label'),body:t('settings.approvals.deny')},
  {key:'allow',tone:'border-rose-500/40 bg-rose-500/5',title:t('composer.approvalModes.allowAll.label'),body:t('settings.approvals.allowAll'),dangerous:true},
 ]
 return <div><SectionHeader title={t('settings.sections.approvals.label')} subtitle={t('settings.approvals.subtitle')}/><div className="grid gap-3 sm:grid-cols-2">{modes.map(mode=><article key={mode.key} className={`rounded-xl border p-4 ${mode.tone}`}><div className="flex items-center justify-between"><h4 className="text-sm font-semibold">{mode.title}</h4>{mode.dangerous?<span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-600">HIGH RISK</span>:null}</div><p className="mt-2 text-xs leading-5 text-muted-foreground">{mode.body}</p>{mode.dangerous?<code className="mt-3 block rounded bg-background/80 px-2 py-1.5 font-mono text-[11px]">AK_ALLOW_ALL_OK=1</code>:null}</article>)}</div></div>
}
