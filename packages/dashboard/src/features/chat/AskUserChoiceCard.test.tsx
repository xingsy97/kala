import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AskUserChoiceRequest } from '@agent-kernel/shared'

import { AskUserChoiceCard } from './AskUserChoiceCard.js'

const firstRequest: AskUserChoiceRequest = {
  sessionId: 's',
  callId: 'choice-1',
  intent: 'Choose the implementation scope.',
  message: 'Which path should I take when the available width is narrow?',
  choices: [
    {
      value: 'small',
      label: 'Small change',
      description: 'Keep the surface area minimal while preserving the existing production behavior.\nRetain the rollback path.',
    },
    { value: 'complete', label: 'Complete change' },
  ],
  defaultValue: 'small',
}

const multipleRequest: AskUserChoiceRequest = {
  sessionId: 's',
  callId: 'choice-2',
  message: 'Which validation layers should run?',
  choices: [
    { value: 'unit', label: 'Focused unit tests', description: 'Run the component and protocol tests affected by this change.' },
    { value: 'browser', label: 'Browser matrix', description: 'Exercise desktop and mobile layouts in a real browser.' },
  ],
  multiple: true,
  defaultValues: ['unit'],
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

  it('uses a neutral responsive hierarchy with readable descriptions and one submit action', () => {
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest, multipleRequest]} onSubmit={vi.fn()} onReject={vi.fn()} />,
    )

    const card = screen.getByTestId('ask-user-choice-card')
    expect(card.className).toContain('min-w-0')
    expect(card.className).toContain('max-w-full')
    expect(card.className).toContain('bg-card')
    expect(card.className).not.toContain('bg-amber')
    expect(screen.getByTestId('ask-user-choice-meta').className).toContain('items-center')
    expect(screen.getByTestId('ask-user-choice-meta').className).not.toContain('flex-wrap')
    expect(screen.getByTestId('ask-user-choice-index').textContent).toBe('1 / 2')
    const prompt = screen.getByTestId('ask-user-choice-message')
    expect(prompt.className).toContain('text-[15px]')
    expect(prompt.className).toContain('font-semibold')
    expect(screen.queryByText('Choose the implementation scope.')).toBeNull()
    expect(document.querySelectorAll('[data-testid="ask-user-choice-message"]')).toHaveLength(1)

    const description = screen.getByTestId('ask-user-choice-description-small')
    expect(description.className).toContain('text-[0.9375rem]')
    expect(description.className).toContain('leading-5')
    expect(description.className).toContain('text-muted-foreground')
    expect(description.className).toContain('flex-1')
    expect(description.className).toContain('line-clamp-2')
    expect(description.className).toContain('whitespace-pre-line')
    expect(description.className).toContain('break-words')
    expect(description.className).not.toContain('truncate')
    expect(description.getAttribute('title')).toContain('existing production behavior')
    expect(description.textContent).toContain('\nRetain the rollback path.')
    expect(screen.getByTestId('ask-user-choice-content-small').className).toContain('items-start')
    expect(screen.getByTestId('ask-user-choice-content-small').className).not.toContain('flex-wrap')
    expect(screen.getByTestId('ask-user-choice-title-small').className).toContain('flex-none')
    expect(screen.getByTestId('ask-user-choice-row-small').className).not.toContain('min-h-')
    expect(screen.getByTestId('ask-user-choice-row-small').className).toContain('py-1.5')
    expect(screen.getByTestId('ask-user-choice-body').className).toContain('gap-1.5')
    expect(screen.getByTestId('ask-user-choice-list').className).toContain('gap-0.5')
    expect(screen.getByTestId('ask-user-choice-footer').className).toContain('pt-1.5')
    expect(screen.getAllByText('Confirm')).toHaveLength(1)
    expect(screen.queryByTestId('ask-user-choice-custom-submit')).toBeNull()
    expect(screen.queryByText(/or type a different response/i)).toBeNull()
    expect(screen.queryByTestId('ask-user-choice-custom-input')).toBeNull()
  })

  it('associates every description with its whole-row radio and exposes selected state', () => {
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={vi.fn()} onReject={vi.fn()} />,
    )

    const small = screen.getByTestId('ask-user-choice-option-small')
    const complete = screen.getByTestId('ask-user-choice-option-complete')
    expect(small.getAttribute('type')).toBe('radio')
    expect(small.getAttribute('aria-describedby')).toBe(screen.getByTestId('ask-user-choice-description-small').id)
    expect(screen.getByTestId('ask-user-choice-row-small').getAttribute('data-selected')).toBe('true')

    fireEvent.click(complete)
    expect(small.getAttribute('aria-checked')).toBe('false')
    expect(complete.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('ask-user-choice-row-complete').getAttribute('data-selected')).toBe('true')
    expect(screen.getByText('Selected: Complete change')).toBeTruthy()
  })

  it('submits a single selected choice through the unified footer', async () => {
    const onSubmit = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-option-complete'))
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    expect(onSubmit).toHaveBeenCalledWith('choice-1', { kind: 'choice', value: 'complete' })
    await screen.findByText('Answer submitted — agent continuing…')
  })

  it('uses checkboxes for multiple selection and submits all selected values', async () => {
    const onSubmit = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[multipleRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    const unit = screen.getByTestId('ask-user-choice-option-unit')
    const browser = screen.getByTestId('ask-user-choice-option-browser')
    expect(unit.getAttribute('type')).toBe('checkbox')
    expect(unit.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(browser)
    expect(browser.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    expect(onSubmit).toHaveBeenCalledWith('choice-2', {
      kind: 'choices',
      values: ['unit', 'browser'],
    })
    await screen.findByText('Answer submitted — agent continuing…')
  })

  it('exits custom mode through a normal choice or Escape without a redundant cancel action', async () => {
    render(
      <AskUserChoiceCard sessionScope="s" requests={[multipleRequest]} onSubmit={vi.fn()} onReject={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-option-browser'))
    fireEvent.click(screen.getByTestId('ask-user-choice-custom-option'))
    const input = screen.getByTestId('ask-user-choice-custom-input') as HTMLTextAreaElement
    expect(input.tagName).toBe('TEXTAREA')
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'Keep this draft for later.' } })
    expect(screen.queryByTestId('ask-user-choice-custom-cancel')).toBeNull()
    fireEvent.click(screen.getByTestId('ask-user-choice-option-unit'))

    expect(screen.queryByTestId('ask-user-choice-custom-input')).toBeNull()
    expect(screen.getByTestId('ask-user-choice-option-unit').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('ask-user-choice-option-browser').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('ask-user-choice-custom-option'))
    expect((screen.getByTestId('ask-user-choice-custom-input') as HTMLTextAreaElement).value).toBe('Keep this draft for later.')
    fireEvent.keyDown(screen.getByTestId('ask-user-choice-custom-input'), { key: 'Escape' })
    expect(screen.queryByTestId('ask-user-choice-custom-input')).toBeNull()
  })

  it('submits a trimmed custom response with the same footer action', async () => {
    const onSubmit = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[multipleRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-custom-option'))
    expect((screen.getByTestId('ask-user-choice-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('ask-user-choice-custom-input'), {
      target: { value: '  Run focused tests, then the browser matrix.  ' },
    })
    expect(screen.getByText('Selected: Custom response')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))

    expect(onSubmit).toHaveBeenCalledWith('choice-2', {
      kind: 'custom',
      text: 'Run focused tests, then the browser matrix.',
    })
    await screen.findByText('Answer submitted — agent continuing…')
  })

  it('locks immediately, disables controls, and ignores duplicate submit while awaiting ACK', async () => {
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
    for (const control of [
      screen.getByTestId('ask-user-choice-option-small'),
      screen.getByTestId('ask-user-choice-option-complete'),
      screen.getByTestId('ask-user-choice-reject-all'),
      screen.getByTestId('ask-user-choice-submit'),
    ]) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(true)
    }

    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.getByText('Answer submitted — agent continuing…')).toBeTruthy()
  })

  it('restores controls after RPC failure and permits retry', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValueOnce(undefined)
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={vi.fn()} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    expect((await screen.findByRole('alert')).textContent).toContain('broker unavailable')
    expect((screen.getByTestId('ask-user-choice-submit') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    await screen.findByText('Answer submitted — agent continuing…')
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('awaits cancellation and prevents conflicting actions', async () => {
    const pending = deferred()
    const onReject = vi.fn(() => pending.promise)
    const onSubmit = vi.fn(async () => {})
    render(
      <AskUserChoiceCard sessionScope="s" requests={[firstRequest]} onSubmit={onSubmit} onReject={onReject} />,
    )

    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    fireEvent.click(screen.getByTestId('ask-user-choice-reject-all'))
    fireEvent.click(screen.getByTestId('ask-user-choice-submit'))
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Rejecting request…')).toBeTruthy()

    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.getByText('Request rejected — stopping agent…')).toBeTruthy()
  })

  it('resets for same-call replacement and ignores stale completion', async () => {
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
    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.queryByText('Answer submitted — agent continuing…')).toBeNull()
    expect((screen.getByTestId('ask-user-choice-option-new') as HTMLInputElement).checked).toBe(true)
  })

  it('resets custom disclosure and draft when progressing to the next request', async () => {
    const { rerender } = render(
      <AskUserChoiceCard
        sessionScope="s"
        requests={[firstRequest, multipleRequest]}
        onSubmit={vi.fn()}
        onReject={vi.fn()}
      />,
    )

    expect(screen.getByText('1 / 2')).toBeTruthy()
    fireEvent.click(screen.getByTestId('ask-user-choice-custom-option'))
    fireEvent.change(screen.getByTestId('ask-user-choice-custom-input'), { target: { value: 'custom first' } })
    rerender(
      <AskUserChoiceCard sessionScope="s" requests={[multipleRequest]} onSubmit={vi.fn()} onReject={vi.fn()} />,
    )

    await waitFor(() => expect(screen.getByTestId('ask-user-choice-message').textContent).toBe('Which validation layers should run?'))
    expect(screen.queryByTestId('ask-user-choice-custom-input')).toBeNull()
    expect(screen.getByTestId('ask-user-choice-option-unit').getAttribute('aria-checked')).toBe('true')
  })

  it('keeps narrow layouts overflow-safe and lets footer actions wrap in order', () => {
    render(
      <div style={{ width: 280 }}>
        <AskUserChoiceCard sessionScope="mobile" requests={[multipleRequest]} onSubmit={vi.fn()} onReject={vi.fn()} />
      </div>,
    )

    expect(screen.getByTestId('ask-user-choice-card').className).toContain('overflow-hidden')
    expect(screen.getByTestId('ask-user-choice-row-browser').className).toContain('min-w-0')
    expect(screen.getByTestId('ask-user-choice-description-browser').className).toContain('line-clamp-2')
    expect(screen.getByTestId('ask-user-choice-content-browser').className).toContain('min-w-0')
    const reject = screen.getByTestId('ask-user-choice-reject-all')
    const submit = screen.getByTestId('ask-user-choice-submit')
    expect(reject.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
