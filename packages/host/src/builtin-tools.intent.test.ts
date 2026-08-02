import { describe, expect, it } from 'vitest'
import { createBuiltinTools } from './builtin-tools.js'

describe('built-in tool intent schema',()=>{
  it('adds an English optional intent description to every tool',()=>{
    for(const tool of createBuiltinTools()){
      const intent=(tool.inputSchema.properties as Record<string,any>)._intent
      expect(intent).toMatchObject({type:'string',maxLength:160})
      expect(intent.description).toContain('user’s current language')
      expect((tool.inputSchema.required as string[]|undefined)?.includes('_intent')??false).toBe(false)
    }
  })
})
