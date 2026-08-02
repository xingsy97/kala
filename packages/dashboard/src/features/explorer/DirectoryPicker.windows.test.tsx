import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DirectoryPicker } from './DirectoryPicker.js'

describe('DirectoryPicker Windows paths',()=>{
  it('loads drive-letter roots and accepts typed child paths',async()=>{
    const root='C:\\Users\\admin'
    const child=`${root}\\project`
    const listeners=new Map<string,(value:any)=>void>()
    const emit=vi.fn((event:string,payload:any)=>{if(event==='client:list_dirs')queueMicrotask(()=>listeners.get('server:dir_list')?.({requestId:payload.requestId,workspaceId:'ws',path:payload.path??root,roots:[root],entries:[]}))})
    const socket={emit,on:(event:string,fn:(value:any)=>void)=>listeners.set(event,fn),off:vi.fn()} as any
    function Harness(){const [value,setValue]=useState(root);return <DirectoryPicker socket={socket} workspaceId="ws" initialPath={root} value={value} onChange={setValue}/>}
    render(<Harness/>)
    await waitFor(()=>expect(emit).toHaveBeenCalledWith('client:list_dirs',expect.objectContaining({path:root})))
    const input=screen.getByDisplayValue(root)
    fireEvent.change(input,{target:{value:child}})
    fireEvent.keyDown(input,{key:'Enter'})
    expect(emit).toHaveBeenCalledWith('client:list_dirs',expect.objectContaining({path:child}))
  })
})
