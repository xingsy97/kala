import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Laptop } from 'lucide-react'
import { Button } from '../../components/ui/button.js'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'

export type ExecutorPairing = { id:string; code:string; workspaceId:string; label?:string; createdAt:string; expiresAt:string; status:string }
export async function fetchExecutorPairings():Promise<ExecutorPairing[]>{
  const response=await fetch('/auth/executor-pairings',{headers:{accept:'application/json'}})
  const type=response.headers.get('content-type')??''
  if(!response.ok||!type.includes('application/json'))throw new Error(`Unable to load executor pairing requests (HTTP ${response.status}). Verify this Dashboard and executor use the same Host.`)
  const payload=await response.json() as {pairings?:ExecutorPairing[]}
  return payload.pairings??[]
}
export function ExecutorPairingPrompt():JSX.Element|null{
  const client=useQueryClient()
  const query=useQuery({queryKey:['executor-pairings'],queryFn:fetchExecutorPairings,refetchInterval:2000})
  const pairing=query.data?.find((item)=>item.status==='pending')
  const decision=useMutation({mutationFn:async(input:{id:string;action:'approve'|'reject'})=>{const response=await fetch(`/auth/executor-pairings/${encodeURIComponent(input.id)}/${input.action}`,{method:'POST',headers:{accept:'application/json'}});if(!response.ok)throw new Error(`Unable to ${input.action} executor (HTTP ${response.status})`)},onSuccess:async()=>{await client.invalidateQueries({queryKey:['executor-pairings']})}})
  if(!pairing)return null
  return <Dialog open><DialogContent className="max-w-md" data-testid="executor-pairing-prompt"><DialogHeader><DialogTitle className="flex items-center gap-2"><Laptop className="h-5 w-5"/>Approve new executor?</DialogTitle><DialogDescription>A device is waiting to connect to this Agent RunLab Host. Confirm that the code below matches the code shown on that device.</DialogDescription></DialogHeader><div className="rounded-lg border bg-muted/40 p-5 text-center"><div className="font-mono text-3xl font-semibold tracking-[0.3em]" data-testid="executor-pairing-code">{pairing.code}</div><div className="mt-2 text-xs text-muted-foreground">{pairing.label||pairing.workspaceId}</div></div>{decision.error?<p className="text-sm text-destructive">{(decision.error as Error).message}</p>:null}<div className="flex justify-end gap-2"><Button variant="outline" disabled={decision.isPending} onClick={()=>decision.mutate({id:pairing.id,action:'reject'})}>Reject</Button><Button disabled={decision.isPending} onClick={()=>decision.mutate({id:pairing.id,action:'approve'})}>Approve executor</Button></div></DialogContent></Dialog>
}
