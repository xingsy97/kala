import { describe, expect, it } from 'vitest'
import { compareDesktopVersions } from './desktop-updates.js'

describe('desktop version comparisons', () => {
  it.each([
    ['0.2.0~rc.4', '0.2.0-rc.3', 1],
    ['0.2.0~rc.3', '0.2.0-rc.4', -1],
    ['0.2.0~rc.4', '0.2.0-rc.4', 0],
    ['0.2.0~rc.10', '0.2.0-rc.4', 1],
    ['0.2.0', '0.2.0-rc.4', 1],
    ['0.2.0~rc.4', '0.2.0', -1],
    ['0.2.0', '0.2.0+build.2', 0],
    ['0.2.0~rc.01', '0.2.0-rc.1', 0],
    ['1.0.0', '0.99.99', 1],
  ])('compares %s to %s', (left, right, expected) => expect(compareDesktopVersions(left, right)).toBe(expected))
  it.each(['', 'unknown', '../0.2.0', '0.2', '1.2.3~', '1.2.3-rc..1'])('rejects malformed version %s', (version) => expect(compareDesktopVersions(version, '0.2.0')).toBeNull())
})
