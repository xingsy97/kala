export type ActorTransition<State, Command> = {
  readonly state: State
  readonly commands?: readonly Command[]
}

export type ActorCommandContext<Event> = {
  send(event: Event): void
  isClosed(): boolean
}

export type SerializedActorOptions<State, Event, Command> = {
  initialState: State
  transition(state: State, event: Event): ActorTransition<State, Command>
  run(command: Command, context: ActorCommandContext<Event>): void | Promise<void>
  commandFailed?(command: Command, error: unknown): Event | undefined
}

/**
 * A minimal FIFO mailbox for host workflows. Transitions are synchronous and
 * non-reentrant; asynchronous work returns through explicitly identified
 * events instead of mutating actor state from promise callbacks.
 */
export class SerializedActor<State, Event, Command> {
  private state: State
  private readonly mailbox: Event[] = []
  private processing = false
  private closed = false

  constructor(private readonly options: SerializedActorOptions<State, Event, Command>) {
    this.state = options.initialState
  }

  snapshot(): State {
    return this.state
  }

  /** Replace a durably restored workflow snapshot before normal admission. */
  replaceState(state: State): void {
    if (this.processing) throw new Error('cannot replace actor state while processing')
    this.state = state
  }

  send(event: Event): void {
    if (this.closed) return
    this.mailbox.push(event)
    this.drain()
  }

  close(): void {
    this.closed = true
    this.mailbox.length = 0
  }

  isClosed(): boolean {
    return this.closed
  }

  private drain(): void {
    if (this.processing || this.closed) return
    this.processing = true
    try {
      while (!this.closed) {
        const event = this.mailbox.shift()
        if (event === undefined) break
        const result = this.options.transition(this.state, event)
        this.state = result.state
        for (const command of result.commands ?? []) this.run(command)
      }
    } finally {
      this.processing = false
    }
  }

  private run(command: Command): void {
    const context: ActorCommandContext<Event> = {
      send: (event) => this.send(event),
      isClosed: () => this.closed,
    }
    try {
      const pending = this.options.run(command, context)
      if (pending) void pending.catch((error: unknown) => this.handleCommandFailure(command, error))
    } catch (error) {
      this.handleCommandFailure(command, error)
    }
  }

  private handleCommandFailure(command: Command, error: unknown): void {
    if (this.closed) return
    const event = this.options.commandFailed?.(command, error)
    if (event !== undefined) this.send(event)
  }
}
