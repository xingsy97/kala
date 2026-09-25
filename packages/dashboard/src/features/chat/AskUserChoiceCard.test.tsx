import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AskUserChoiceRequest } from '@agent-kernel/shared'

import { AskUserChoiceCard } from './AskUserChoiceCard.js'

const firstRequest: AskUserChoiceRequest = {
  sessionId: 's',
  callId: 'choice-1',
  intent: 'Choose the implementation scope.',
  message: 'Which path should I take?',
  choices: [
    { value: 'small', label: 'Small change', description: 'Minimal surface area.' },
    { value: 'complete', label: 'Complete change' },
  ],
  defaultValue: 'small',
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AskUserChoiceCard', () => {
  it('renders nothing when there are no pending choice requests', () => {
    const { container } = render(
      <AskUserChoiceCard sessionScope="s" requests={[]} onSubmit={vi.fn()} onReject={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })

  it('uses one responsive card layout and one confirmation action', () => {
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={vi.fn()} onReject={vi.fn()} />,
    )

    expect(screen.getByTestId('ask-user-choice-card').className).toContain('min-w-0')
    expect(screen.getByRole('group').className).toContain('sm:grid-cols-2')
    expect(screen.getByText('Choose the implementation scope.')).toBeTruthy()
    expect(screen.getByText('Minimal surface area.')).toBeTruthy()
    expect(screen.getAllByText('Confirm')).toHaveLength(1)
    expect(screen.queryByTestId('ask-user-choice-custom-submit')).toBeNull()
  })

  it('clicking an option selects it and the unified button submits that choice', async () => {
    const onSubmit = vi.fn(async () => {})
    const { rerender } = render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    const small = screen.getByTestId('ask-user-choice-option-small')
    const complete = screen.getByTestId('ask-user-choice-option-complete')
    expect(small.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(complete)
    expect(small.getAttribute('aria-checked')).toBe('false')
    expect(complete.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Selected: Complete change')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    expect(onSubmit).toHaveBeenCalledWith('choice-1', { kind: 'choice', value: 'complete' })
    await screen.findByText('Answer submitted — agent continuing…')
    rerender(<AskUserChoiceCard sessionScope="s" requests={[]} onSubmit={onSubmit} onReject={vi.fn()} />)
    expect(screen.queryByTestId('ask-user-choice-card')).toBeNull()
  })

  it('requires explicit custom selection and clears every predefined option', async () => {
    const onSubmit = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    const input = screen.getByTestId('ask-user-choice-custom-input')
    expect((input as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('ask-user-choice-custom-option'))
    expect(screen.getByTestId('ask-user-choice-custom').getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('ask-user-choice-option-small').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('ask-user-choice-option-complete').getAttribute('aria-checked')).toBe('false')
    expect((screen.getByTestId('ask-user-choice-submit') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: '  Please do something else instead.  ' } })
    expect(screen.getByText('Selected: Custom response')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    expect(onSubmit).toHaveBeenCalledWith('choice-1', {
      kind: 'custom',
      text: 'Please do something else instead.',
    })
    await screen.findByText('Answer submitted — agent continuing…')
  })

  it('locks immediately, disables every control, and ignores duplicate click or Enter while awaiting ACK', async () => {
    const pending = deferred()
    const onSubmit = vi.fn(() => pending.promise)
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    const card = screen.getByTestId('ask-user-choice-card')
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Submitting answer…')).toBeTruthy()
    expect(screen.getByTestId('ask-user-choice-status').querySelector('.animate-spin')).toBeTruthy()
    for (const control of [
      screen.getByTestId('ask-user-choice-option-small'),
      screen.getByTestId('ask-user-choice-option-complete'),
      screen.getByTestId('ask-user-choice-custom-input'),
      screen.getByTestId('ask-user-choice-reject-all'),
      screen.getByTestId('ask-user-choice-submit'),
    ]) {
      expect((control as HTMLButtonElement | HTMLTextAreaElement).disabled).toBe(true)
    }

    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.getByText('Answer submitted — agent continuing…')).toBeTruthy()
    expect(card.getAttribute('aria-busy')).toBe('false')
  })

  it('catches RPC failure, restores controls, shows an inline error, and permits retry', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValueOnce(undefined)
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('broker unavailable')
    expect(screen.getByRole('alert').textContent).toContain('Try again')
    expect((screen.getByTestId('ask-user-choice-submit') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('ask-user-choice-option-complete') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByTestId('ask-user-choice-custom-input') as HTMLTextAreaElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    await screen.findByText('Answer submitted — agent continuing…')
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('awaits rejection and prevents duplicate reject or confirm actions', async () => {
    const pending = deferred()
    const onReject = vi.fn(() => pending.promise)
    const onSubmit = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={onReject} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    fireEvent.keyDown(screen.getByTestId('ask-user-choice-card'), { key: 'Enter' })
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Rejecting request…')).toBeTruthy()

    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.getByText('Request rejected — stopping agent…')).toBeTruthy()
  })

  it('does not turn Enter on an option or reject into the dialog default submit', () => {
    const onSubmit = vi.fn(async () => {})
    const onReject = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={onReject} />,
    )

    fireEvent.keyDown(screen.getByTestId('ask-user-choice-option-complete'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('ask-user-choice-reject-all'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('surfaces cancellation ACK failure and permits retry', async () => {
    const onReject = vi.fn().mockRejectedValueOnce(new Error('cancel failed')).mockResolvedValueOnce(undefined)
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={vi.fn()} onReject={onReject} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    expect((await screen.findByRole('alert')).textContent).toContain('cancel failed')
    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    await screen.findByText('Request rejected — stopping agent…')
    expect(onReject).toHaveBeenCalledTimes(2)
  })

  it('resets for same-call replacement and ignores the stale promise completion', async () => {
    const pending = deferred()
    const replacement: AskUserChoiceRequest = {
      ...firstRequest,
      message: 'Replacement request',
      choices: [{ value: 'new', label: 'New option' }],
      defaultValue: 'new',
    }
    const onSubmit = vi.fn(() => pending.promise)
    const { rerender } = render(
      <AskUserChoiceCard sessionScope="session-a" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    rerender(<AskUserChoiceCard sessionScope="session-b" requests={[replacement]} onSubmit={onSubmit} onReject={vi.fn()} />)
    expect(screen.getByTestId('ask-user-choice-message').textContent).toBe('Replacement request')
    expect((screen.getByTestId('ask-user-choice-submit') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.queryByText('Answer submitted — agent continuing…')).toBeNull()
    expect((screen.getByTestId('ask-user-choice-option-new') as HTMLInputElement).checked).toBe(true)
  })

  it('preserves multiple-request progression and resets the draft for the next request', async () => {
    const secondRequest: AskUserChoiceRequest = {
      sessionId: 's',
      callId: 'choice-2',
      message: 'Pick the follow-up?',
      choices: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }],
      defaultValue: 'b',
    }
    const onSubmit = vi.fn(async () => {})
    const { rerender } = render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest, secondRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    expect(screen.getByText('1 of 2')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-custom-option'))
    fireEvent.change(screen.getByTestId('ask-user-choice-custom-input'), { target: { value: 'custom first' } })
    rerender(<AskUserChoiceCard sessionScope="s" requests={[secondRequest]} onSubmit={onSubmit} onReject={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('ask-user-choice-message').textContent).toBe('Pick the follow-up?'))
    expect(screen.queryByText('1 of 2')).toBeNull()
    expect(screen.getByTestId('ask-user-choice-option-b').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId('ask-user-choice-custom-input') as HTMLTextAreaElement).value).toBe('')
  })
})
