import { describe, expect, it } from 'vitest'

import { SerializedActor, type ActorTransition } from './serialized-actor.js'

type Event = { kind: 'add'; value: number } | { kind: 'failed'; message: string }
type Command = { kind: 'add_again'; value: number } | { kind: 'reject' }

function transition(state: number, event: Event): ActorTransition<number, Command> {
  if (event.kind === 'failed') return { state: state - 100 }
  return {
    state: state + event.value,
    commands: event.value > 1 ? [{ kind: 'add_again', value: 1 }] : [],
  }
}

describe('SerializedActor', () => {
  it('serializes events sent synchronously by a command without reentry', () => {
    const transitions: number[] = []
    const actor = new SerializedActor<number, Event, Command>({
      initialState: 0,
      transition(state, event) {
        transitions.push(state)
        return transition(state, event)
      },
      run(command, context) {
        if (command.kind === 'add_again') context.send({ kind: 'add', value: command.value })
      },
    })

    actor.send({ kind: 'add', value: 2 })

    expect(actor.snapshot()).toBe(3)
    expect(transitions).toEqual([0, 2])
  })

  it('maps asynchronous command failures back into the mailbox', async () => {
    const actor = new SerializedActor<number, Event, Command>({
      initialState: 1,
      transition: (state, event) => event.kind === 'add'
        ? { state, commands: [{ kind: 'reject' }] }
        : transition(state, event),
      async run(command) {
        if (command.kind === 'reject') throw new Error('failed')
      },
      commandFailed: (_command, error) => ({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    })

    actor.send({ kind: 'add', value: 1 })
    await Promise.resolve()
    await Promise.resolve()

    expect(actor.snapshot()).toBe(-99)
  })

  it('drops queued and future events after close', () => {
    let actor: SerializedActor<number, Event, Command>
    actor = new SerializedActor({
      initialState: 0,
      transition,
      run(_command, context) {
        actor.close()
        context.send({ kind: 'add', value: 10 })
      },
    })

    actor.send({ kind: 'add', value: 2 })
    actor.send({ kind: 'add', value: 20 })

    expect(actor.snapshot()).toBe(2)
    expect(actor.isClosed()).toBe(true)
  })
})
