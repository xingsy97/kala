import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeInterfaceScale, InterfaceScale } from './interface-scale.js'
import { PREF_INTERFACE_SCALE } from './prefs.js'
import { SizePreference } from '../features/settings/SizePreference.js'
import { useState } from 'react'

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.style.removeProperty('--ak-interface-scale')
})

describe('whole interface scale', () => {
  it('starts enlarged and honors a stored explicit preference before mount', () => {
    initializeInterfaceScale()
    expect(document.documentElement.style.getPropertyValue('--ak-interface-scale')).toBe('1.25')
    localStorage.setItem(PREF_INTERFACE_SCALE, '100')
    initializeInterfaceScale()
    expect(document.documentElement.style.getPropertyValue('--ak-interface-scale')).toBe('1')
  })

  it('updates cross-tab and restores the enlarged default when reset', () => {
    render(<InterfaceScale />)
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: PREF_INTERFACE_SCALE, newValue: '200' })))
    expect(document.documentElement.style.getPropertyValue('--ak-interface-scale')).toBe('2')
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: PREF_INTERFACE_SCALE, newValue: null })))
    expect(document.documentElement.style.getPropertyValue('--ak-interface-scale')).toBe('1.25')
  })

  it('allows clearing and typing a full number rather than clamping the first digit', () => {
    function Harness(): JSX.Element {
      const [value, setValue] = useState(15)
      return <SizePreference label="Size" description="Size help" value={value} onChange={setValue} min={10} max={48} defaultValue={15} unit="px" testId="size" />
    }
    render(<Harness />)
    const input = screen.getByTestId('size') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: '4' } })
    expect(input.value).toBe('4')
    fireEvent.change(input, { target: { value: '48' } })
    fireEvent.blur(input)
    expect(input.value).toBe('48')
    fireEvent.change(screen.getByTestId('size-slider'), { target: { value: '37' } })
    expect(input.value).toBe('37')
    fireEvent.click(screen.getByTestId('size-reset'))
    expect(input.value).toBe('15')
  })
})
