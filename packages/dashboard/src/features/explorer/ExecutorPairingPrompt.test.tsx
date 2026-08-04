import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutorPairingPrompt } from './ExecutorPairingPrompt.js'

describe('ExecutorPairingPrompt',()=>{
  beforeEach(()=>vi.stubGlobal('fetch',vi.fn()))
  it('globally shows and approves a pending executor',async()=>{
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      if(String(input)==='/auth/executor-pairings'&&(!init?.method||init.method==='GET'))return new Response(JSON.stringify({pairings:[{id:'pair_1',code:'119732',workspaceId:'ws1',status:'pending',createdAt:'x',expiresAt:'y'}]}),{status:200,headers:{'content-type':'application/json'}})
      return new Response(JSON.stringify({status:'approved'}),{status:200,headers:{'content-type':'application/json'}})
    })
    render(<ExecutorPairingPrompt/>)
    expect((await screen.findByTestId('executor-pairing-code')).textContent).toBe('119732')
    fireEvent.click(screen.getByRole('button',{name:'Approve executor'}))
    await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/auth/executor-pairings/pair_1/approve',expect.objectContaining({method:'POST'})))
  })
})
