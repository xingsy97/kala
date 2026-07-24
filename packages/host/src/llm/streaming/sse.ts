import { createParser, type EventSourceMessage } from 'eventsource-parser'

export type SseDataEvent = {
  event?: string
  data: string
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseDataEvent) => void,
): Promise<void> {
  const parser = createParser({
    onEvent(message: EventSourceMessage) {
      if (!message.data) return
      onEvent({
        data: message.data,
        ...(message.event ? { event: message.event } : {}),
      })
    },
  })

  const reader = body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    parser.feed(decoder.decode(value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) parser.feed(tail)
}

export function parseSseJson<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T
  } catch {
    return undefined
  }
}
