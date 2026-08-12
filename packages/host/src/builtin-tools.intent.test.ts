import { describe, expect, it } from 'vitest'
import { createBuiltinTools } from './builtin-tools.js'

describe('built-in tool intent schema',()=>{
  it('keeps websearch execution on the Host',()=>{
    expect(createBuiltinTools().find((tool)=>tool.name==='websearch')).toMatchObject({
      executionKind: 'host',
      executionHandler: 'websearch',
    })
  })

  it('requires a natural-language intent on every tool call',()=>{
    for(const tool of createBuiltinTools()){
      const intent=(tool.inputSchema.properties as Record<string,any>)._intent
      expect(intent).toMatchObject({type:'string',minLength:1,maxLength:160})
      expect(intent.description).toContain('user’s current language')
      expect((tool.inputSchema.required as string[]|undefined)?.filter((key)=>key==='_intent')).toEqual(['_intent'])
    }
  })
})
