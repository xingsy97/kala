import { describe, expect, it } from 'vitest'
import { createBuiltinTools } from './builtin-tools.js'

describe('built-in tool intent schema',()=>{
  it('keeps websearch execution on the Host',()=>{
    expect(createBuiltinTools().find((tool)=>tool.name==='websearch')).toMatchObject({
      executionKind: 'host',
      executionHandler: 'websearch',
    })
  })

  it('registers multi_grep as a bounded executor read tool',()=>{
    const tool=createBuiltinTools().find((candidate)=>candidate.name==='multi_grep')!
    expect(tool).toMatchObject({executionKind:'executor',executionHandler:'multi_grep',requiresApproval:false})
    const searches=(tool.inputSchema.properties as Record<string,any>).searches
    expect(searches).toMatchObject({type:'array',minItems:1,maxItems:20})
    expect(createBuiltinTools().some((candidate)=>candidate.name==='grep')).toBe(false)
    expect((tool.inputSchema.properties as Record<string,any>).max_bytes).toBeUndefined()
  })

  it('registers todo_graph as the only planning tool',()=>{
    const planningTools=createBuiltinTools().filter((tool)=>tool.toolsetId==='planning')
    expect(planningTools.map((tool)=>tool.name)).toEqual(['todo_graph'])
    expect(planningTools[0]).toMatchObject({executionKind:'host',executionHandler:'todo_graph'})
  })

  it('exposes an explicit bounded subagent intention while retaining objective compatibility',()=>{
    const agent=createBuiltinTools().find((tool)=>tool.name==='agent')!
    const properties=agent.inputSchema.properties as Record<string,any>
    expect(properties.intention).toMatchObject({type:'string',minLength:12,maxLength:240})
    expect(properties.objective.description).toContain('Backward-compatible')
  })

  it('requires a natural-language intent on every tool call',()=>{
    for(const tool of createBuiltinTools()){
      const intent=(tool.inputSchema.properties as Record<string,any>)._intent
      expect(intent).toMatchObject({type:'string',minLength:12,maxLength:240})
      expect(intent.description).toContain('user’s current language')
      expect(intent.description).toContain('concrete user- or product-facing objective')
      expect(intent.description).toContain('Do not merely name the tool or operation')
      expect((tool.inputSchema.required as string[]|undefined)?.filter((key)=>key==='_intent')).toEqual(['_intent'])
    }
  })
})
