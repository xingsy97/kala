import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AskUserChoiceCard } from './AskUserChoiceCard.js'

describe('AskUserChoiceCard', () => {
  it('renders nothing when there are no pending choice requests', () => {
    const { container } = render(<AskUserChoiceCard requests={[]} onChoose={vi.fn()} />)
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
      />,
    )

    expect(screen.getByTestId('ask-user-choice-message').textContent).toBe('Which path should I take?')
    expect(screen.getByText('Selected: Small change')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-option-complete'))
    expect(screen.getByText('Selected: Complete change')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    expect(onChoose).toHaveBeenCalledWith('choice-1', 'complete')
  })
})
