import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AskUserChoiceCard } from './AskUserChoiceCard.js'

describe('AskUserChoiceCard', () => {
  it('renders nothing when there are no pending choice requests', () => {
    const { container } = render(
      <AskUserChoiceCard requests={[]} onChoose={vi.fn()} onCustomText={vi.fn()} onRejectAll={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })

  it('lets the user select an option and submit it', () => {
    const onChoose = vi.fn()
    render(
      <AskUserChoiceCard
        requests={[{
          sessionId: 's',
          callId: 'choice-1',
          message: 'Which path should I take?',
          choices: [
            { value: 'small', label: 'Small change', description: 'Minimal surface area.' },
            { value: 'complete', label: 'Complete change' },
          ],
          defaultValue: 'small',
        }]}
        onChoose={onChoose}
        onCustomText={vi.fn()}
        onRejectAll={vi.fn()}
      />,
    )

    expect(screen.getByTestId('ask-user-choice-message').textContent).toBe('Which path should I take?')
    expect(screen.getByText('Selected: Small change')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-option-complete'))
    expect(screen.getByText('Selected: Complete change')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    expect(onChoose).toHaveBeenCalledWith('choice-1', 'complete')
  })

  it('submits a custom text response without choosing an option value', () => {
    const onCustomText = vi.fn()
    render(
      <AskUserChoiceCard
        requests={[{
          sessionId: 's',
          callId: 'choice-2',
          message: 'How should I proceed?',
          choices: [{ value: 'a' }, { value: 'b' }],
        }]}
        onChoose={vi.fn()}
        onCustomText={onCustomText}
        onRejectAll={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId('ask-user-choice-custom-input'), {
      target: { value: 'Please do something else instead.' },
    })
    fireEvent.click(screen.getByTestId('ask-user-choice-custom-submit'))

    expect(onCustomText).toHaveBeenCalledWith('choice-2', 'Please do something else instead.')
  })

  it('lets the user reject all options and stop', () => {
    const onRejectAll = vi.fn()
    render(
      <AskUserChoiceCard
        requests={[{
          sessionId: 's',
          callId: 'choice-3',
          message: 'Pick one?',
          choices: [{ value: 'a' }],
        }]}
        onChoose={vi.fn()}
        onCustomText={vi.fn()}
        onRejectAll={onRejectAll}
      />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))

    expect(onRejectAll).toHaveBeenCalledWith('choice-3')
  })
})
