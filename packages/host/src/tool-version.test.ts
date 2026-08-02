import { describe,expect,it } from 'vitest'
import { compareToolVersions } from './tool-version.js'
describe('tool versions',()=>{it('reports observable compatibility without negotiation',()=>{expect(compareToolVersions('2.1.0','2.1.0')).toBe('exact');expect(compareToolVersions('2.1.0','2.9.0')).toBe('compatible');expect(compareToolVersions('2.1.0','3.0.0')).toBe('different');expect(compareToolVersions('2.1.0',undefined)).toBe('unknown')})})
