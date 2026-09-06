import type { CallToolEffect } from '@agent-kernel/kernel'
import type { AskUserChoiceOption, AskUserChoiceRequest } from '@agent-kernel/shared'

import type { ToolExecutionResult } from './agent-modules/execution.js'

type PendingChoice = {
  request: AskUserChoiceRequest
  resolve(value: string): void
  reject(error: Error): void
}

export class AskUserChoiceBroker {
  private readonly pending = new Map<string, PendingChoice>()
  private readonly earlyResponses = new Map<string, { value: string; expiresAt: number }>()

  async ask(sessionId: string, effect: CallToolEffect): Promise<ToolExecutionResult> {
    const parsed = parseAskUserChoiceInput(sessionId, effect)
    if (!parsed.ok) return { ok: false, content: parsed.error }
    const key = choiceKey(sessionId, effect.callId)
    const previous = this.pending.get(key)
    if (previous) previous.reject(new Error('ask_user_choice request was superseded'))
    const early = this.earlyResponses.get(key)
    if (early) {
      this.earlyResponses.delete(key)
      if (Date.now() <= early.expiresAt) return selectedChoiceResult(parsed.request, early.value)
    }

    try {
      const value = await new Promise<string>((resolve, reject) => {
        this.pending.set(key, { request: parsed.request, resolve, reject })
      })
      return selectedChoiceResult(parsed.request, value)
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        failure: {
          code: 'ASK_USER_CHOICE_CANCELLED',
          category: 'cancelled',
          outcome: 'cancelled',
          retryable: false,
          responsibility: 'user',
        },
      }
    } finally {
      if (this.pending.get(key)?.request.callId === effect.callId) this.pending.delete(key)
    }
  }

  respond(sessionId: string, callId: string, value: string): { ok: true } | { ok: false; error: string } {
    const pending = this.pending.get(choiceKey(sessionId, callId))
    if (!pending) return { ok: false, error: 'ask_user_choice request is not pending' }
    if (!pending.request.choices.some((choice) => choice.value === value)) {
      return { ok: false, error: 'selected value is not one of the available choices' }
    }
    pending.resolve(value)
    return { ok: true }
  }

  cancelSession(sessionId: string, reason = 'ask_user_choice request was cancelled'): void {
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(`${sessionId}:`)) continue
      this.pending.delete(key)
      pending.reject(new Error(reason))
    }
    for (const key of this.earlyResponses.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.earlyResponses.delete(key)
    }
  }

  respondEarly(sessionId: string, callId: string, value: string): { ok: true } {
    this.pruneEarlyResponses()
    this.earlyResponses.set(choiceKey(sessionId, callId), {
      value,
      expiresAt: Date.now() + 30_000,
    })
    return { ok: true }
  }

  private pruneEarlyResponses(): void {
    const now = Date.now()
    for (const [key, response] of this.earlyResponses) {
      if (response.expiresAt <= now) this.earlyResponses.delete(key)
    }
  }
}

function selectedChoiceResult(request: AskUserChoiceRequest, value: string): ToolExecutionResult {
  const option = request.choices.find((choice) => choice.value === value)
  if (!option) return { ok: false, content: `invalid choice: ${value}` }
  return {
    ok: true,
    content: JSON.stringify({
      value: option.value,
      label: option.label ?? option.value,
    }),
  }
}

export function askUserChoiceRequestFromPendingCall(input: {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  intent?: string
}): AskUserChoiceRequest | null {
  if (input.name !== 'ask_user_choice') return null
  const parsed = parseAskUserChoicePayload(input.sessionId, input.callId, input.input, input.intent)
  return parsed.ok ? parsed.request : null
}

function parseAskUserChoiceInput(
  sessionId: string,
  effect: CallToolEffect,
): { ok: true; request: AskUserChoiceRequest } | { ok: false; error: string } {
  return parseAskUserChoicePayload(sessionId, effect.callId, effect.input, effect.intent)
}

function parseAskUserChoicePayload(
  sessionId: string,
  callId: string,
  input: Record<string, unknown>,
  intent?: string,
): { ok: true; request: AskUserChoiceRequest } | { ok: false; error: string } {
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (message.length === 0) return { ok: false, error: 'ask_user_choice.message must be a non-empty string' }
  const rawChoices = Array.isArray(input.choices) ? input.choices : []
  if (rawChoices.length === 0) return { ok: false, error: 'ask_user_choice.choices must contain at least one option' }
  if (rawChoices.length > 20) return { ok: false, error: 'ask_user_choice.choices cannot contain more than 20 options' }

  const choices: AskUserChoiceOption[] = []
  const values = new Set<string>()
  for (const raw of rawChoices) {
    const choice = normalizeChoice(raw)
    if (!choice) return { ok: false, error: 'ask_user_choice.choices must be strings or { value, label, description } objects' }
    if (values.has(choice.value)) return { ok: false, error: `duplicate ask_user_choice value: ${choice.value}` }
    values.add(choice.value)
    choices.push(choice)
  }
  const defaultValue = typeof input.defaultValue === 'string' && input.defaultValue.trim().length > 0
    ? input.defaultValue.trim()
    : undefined
  if (defaultValue !== undefined && !values.has(defaultValue)) {
    return { ok: false, error: 'ask_user_choice.defaultValue must match one of the choices' }
  }
  return {
    ok: true,
    request: {
      sessionId,
      callId,
      message,
      choices,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(intent ? { intent } : {}),
    },
  }
}

function normalizeChoice(raw: unknown): AskUserChoiceOption | null {
  if (typeof raw === 'string') {
    const value = raw.trim()
    return value.length > 0 ? { value } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const value = typeof record.value === 'string' ? record.value.trim() : ''
  if (value.length === 0) return null
  const label = typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : undefined
  const description = typeof record.description === 'string' && record.description.trim().length > 0 ? record.description.trim() : undefined
  return {
    value,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}

function choiceKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`
}
