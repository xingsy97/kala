import { describe, expect, it } from 'vitest'
import { initialLocale, translate } from './index.js'

describe('evaluation Dashboard internationalization', () => {
  it('selects an explicit locale and translates persistent product chrome', () => {
    history.replaceState({}, '', '/?locale=zh-CN')
    expect(initialLocale()).toBe('zh-CN')
    expect(translate('zh-CN', 'route.leaderboard')).toBe('排行榜')
    expect(translate('zh-CN', 'app.updated', { time: '10:00' })).toBe('更新于 10:00')
    expect(translate('zh-CN', 'admin.authTitle')).toBe('认证主体与服务密钥')
    expect(translate('zh-CN', 'admin.governanceEyebrow')).toBe('传递性治理')
  })

  it('falls back to the canonical English locale', () => {
    history.replaceState({}, '', '/')
    localStorage.removeItem('agent-eval-locale')
    expect(translate('en', 'state.unsupported')).toBe('Capability unavailable')
  })
})
