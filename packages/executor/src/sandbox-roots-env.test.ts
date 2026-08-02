import { describe, expect, it } from 'vitest'
import { parseSandboxRootsEnv } from './sandbox-roots-env.js'

describe('parseSandboxRootsEnv',()=>{
  it('preserves Windows drive letters and separates roots with semicolons',()=>{
    expect(parseSandboxRootsEnv('C:\\Users\\admin;D:\\work','win32')).toEqual(['C:\\Users\\admin','D:\\work'])
  })
  it('uses colon-separated roots on Unix',()=>{
    expect(parseSandboxRootsEnv('/home/user:/workspace','linux')).toEqual(['/home/user','/workspace'])
  })
})
