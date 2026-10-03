import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { joinTranscriptChunks, mergeTranscriptAtCaret, useVoiceRecorder } from './useVoiceRecorder.js'

const speechSdkMock = vi.hoisted(() => ({
  stop: vi.fn(), close: vi.fn(),
  instances: [] as Array<Record<string, unknown>>,
  delayStart: null as null | ((done: () => void) => void),
}))
vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: { fromAuthorizationToken: () => ({ setProperty: () => {} }) },
  AudioConfig: { fromStreamInput: () => ({}) },
  AutoDetectSourceLanguageConfig: { fromLanguages: () => ({}) },
  SpeechRecognizer: { FromConfig: () => {
    const instance = {
      startContinuousRecognitionAsync: (done: () => void) => speechSdkMock.delayStart ? speechSdkMock.delayStart(done) : done(),
      stopContinuousRecognitionAsync: (done: () => void) => { speechSdkMock.stop(); done() },
      close: speechSdkMock.close,
    }
    speechSdkMock.instances.push(instance)
    return instance
  } },
  OutputFormat: { Detailed: 1 },
  PropertyId: { SpeechServiceConnection_LanguageIdMode: 1 },
  CancellationReason: { Error: 1 },
  ResultReason: { RecognizedSpeech: 1 },
}))

afterEach(() => {
  speechSdkMock.instances.length = 0
  speechSdkMock.delayStart = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('voice transcript text handling', () => {
  it('inserts English dictation at the saved caret with readable spacing', () => {
    expect(mergeTranscriptAtCaret('Review changes', 6, 'the recent')).toBe('Review the recent changes')
  })

  it('preserves natural Chinese and mixed-language boundaries', () => {
    expect(mergeTranscriptAtCaret('请检查代码', 3, 'this function')).toBe('请检查this function代码')
    expect(joinTranscriptChunks('请检查这个 API。', 'Then run tests.')).toBe('请检查这个 API。Then run tests.')
  })

  it('bounds stale caret positions instead of dropping draft text', () => {
    expect(mergeTranscriptAtCaret('draft', 999, 'continued')).toBe('draft continued')
  })

  it('removes only generated leading and trailing line breaks', () => {
    expect(mergeTranscriptAtCaret('', 0, '\n  First line\nSecond line  \n')).toBe('First line\nSecond line')
    expect(mergeTranscriptAtCaret('\nExisting draft\n', 1, '\nInserted\ntext\n')).toBe('\nInserted\ntext Existing draft\n')
  })

  it('replaces an editor whitespace placeholder instead of preserving a leading blank line', () => {
    expect(mergeTranscriptAtCaret('\n', 1, '\nRecognized text\n')).toBe('Recognized text')
    expect(mergeTranscriptAtCaret('  \n', 0, 'Recognized text')).toBe('Recognized text')
  })
})

describe('after-recording voice input', () => {
  it('keeps audio in memory until Stop and commits the returned transcript', async () => {
    const stopTrack = vi.fn()
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }))
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true }
      readonly mimeType = 'audio/webm;codecs=opus'
      state: RecordingState = 'inactive'
      start(): void { this.state = 'recording' }
      stop(): void {
        this.state = 'inactive'
        this.dispatchEvent(Object.assign(new Event('dataavailable'), {
          data: new Blob(['recording'], { type: this.mimeType }),
        }))
        this.dispatchEvent(new Event('stop'))
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/settings/speech') {
        return Response.json({
          configured: true,
          provider: 'azure',
          endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
          region: 'japaneast',
          enabled: true,
          mode: 'after_recording',
        })
      }
      expect(String(input)).toBe('/runtime/speech/transcribe')
      expect(init?.body).toBeInstanceOf(Blob)
      return Response.json({ text: 'Hello，世界。' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onTranscript = vi.fn()
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript }))
    await waitFor(() => expect(result.current.configuration?.mode).toBe('after_recording'))

    await act(async () => { await result.current.start() })
    expect(result.current.phase).toBe('listening')
    expect(result.current.levels).toHaveLength(64)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    let completedTranscript: string | undefined
    await act(async () => { completedTranscript = await result.current.stop() })

    expect(onTranscript).toHaveBeenCalledWith('Hello，世界。')
    expect(completedTranscript).toBe('Hello，世界。')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stopTrack).toHaveBeenCalledOnce()
    unmount()
    if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
  })
  it('auto-submits after-recording uploads at the default fifteen-minute limit', async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
    } })
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true }
      readonly mimeType = 'audio/webm'
      state: RecordingState = 'inactive'
      start(): void { this.state = 'recording' }
      stop(): void {
        this.state = 'inactive'
        this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio'], { type: this.mimeType }) }))
        this.dispatchEvent(new Event('stop'))
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input) === '/settings/speech'
      ? Response.json({ configured: true, enabled: true, provider: 'azure', mode: 'after_recording' })
      : Response.json({ text: 'Five-minute recording' }))
    vi.stubGlobal('fetch', fetchMock)
    const onTranscript = vi.fn()
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript }))
    try {
      await waitFor(() => expect(result.current.configuration?.mode).toBe('after_recording'))
      vi.useFakeTimers()
      await act(async () => { await result.current.start() })
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000) })
      expect(onTranscript).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 - 1000) })
      expect(onTranscript).toHaveBeenCalledWith('Five-minute recording')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.current.phase).toBe('idle')
    } finally {
      unmount()
      if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })

  it('ignores a transcription response that arrives after cancelling the old session', async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
    } })
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true }
      readonly mimeType = 'audio/webm'
      state: RecordingState = 'inactive'
      start(): void { this.state = 'recording' }
      stop(): void {
        this.state = 'inactive'
        this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio'], { type: this.mimeType }) }))
        this.dispatchEvent(new Event('stop'))
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    let respond!: (response: Response) => void
    const fetchMock = vi.fn((input: string | URL | Request) => String(input) === '/settings/speech'
      ? Promise.resolve(Response.json({ configured: true, enabled: true, provider: 'azure', mode: 'after_recording' }))
      : new Promise<Response>((resolve) => { respond = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const onTranscript = vi.fn()
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript }))
    try {
      await waitFor(() => expect(result.current.configuration?.mode).toBe('after_recording'))
      await act(async () => { await result.current.start() })
      let stopPromise!: Promise<string | undefined>
      await act(async () => { stopPromise = result.current.stop() })
      expect(result.current.phase).toBe('processing')
      await act(async () => { await result.current.cancel() })
      await act(async () => { respond(Response.json({ text: 'Previous session private speech' })); await stopPromise })
      expect(onTranscript).not.toHaveBeenCalled()
      expect(result.current.phase).toBe('idle')
    } finally {
      unmount()
      if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })
})

describe('realtime voice warmup', () => {
  it('never captures a microphone after cancellation while settings are still loading', async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }))
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const respond: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond.push(resolve) })))
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn() }))
    try {
      let pendingStart!: Promise<void>
      await act(async () => { pendingStart = result.current.start() })
      expect(respond.length).toBeGreaterThanOrEqual(2)
      await act(async () => { await result.current.cancel() })
      await act(async () => {
        for (const finish of respond) finish(Response.json({ configured: true, enabled: true, provider: 'azure', mode: 'after_recording' }))
        await pendingStart
      })
      expect(getUserMedia).not.toHaveBeenCalled()
      expect(result.current.phase).toBe('idle')
    } finally {
      unmount()
      if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })

  it('preloads and reuses a short-lived token before microphone capture', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === '/settings/speech') {
        return Response.json({
          configured: true,
          provider: 'azure',
          endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
          region: 'japaneast',
          enabled: true,
          mode: 'realtime',
        })
      }
      expect(String(input)).toBe('/runtime/speech/token')
      return Response.json({
        token: 'short-lived-token',
        endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
        region: 'japaneast',
        expiresInSeconds: 600,
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn() }))
    await waitFor(() => expect(result.current.configuration?.mode).toBe('realtime'))

    await act(async () => { await result.current.prepare() })
    await act(async () => { await result.current.prepare() })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/runtime/speech/token', { method: 'POST', cache: 'no-store' })
    unmount()
  })

  it('ignores delayed startup and old recognizer callbacks after cancellation and a new run', async () => {
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    const stopTrack = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }),
    } })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input) === '/settings/speech'
      ? Response.json({ configured: true, enabled: true, provider: 'azure', mode: 'realtime', region: 'japaneast' })
      : Response.json({ token: 'fake-token', region: 'japaneast', expiresInSeconds: 600 })))
    let finishOldStartup!: () => void
    speechSdkMock.delayStart = (done) => { finishOldStartup = done }
    const onTranscript = vi.fn()
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript }))
    try {
      await waitFor(() => expect(result.current.configuration?.mode).toBe('realtime'))
      let pendingStart!: Promise<void>
      await act(async () => { pendingStart = result.current.start(); await waitFor(() => expect(speechSdkMock.instances).toHaveLength(1)) })
      expect(result.current.phase).toBe('requesting')
      const oldRecognizer = speechSdkMock.instances[0]
      await act(async () => { await result.current.cancel() })
      await act(async () => { finishOldStartup(); await pendingStart })
      expect(result.current.phase).toBe('idle')
      expect(stopTrack).toHaveBeenCalledOnce()

      speechSdkMock.delayStart = null
      await act(async () => { await result.current.start() })
      expect(result.current.phase).toBe('listening')
      const recognizeOld = oldRecognizer.recognized as (_sender: unknown, event: { result: { reason: number; text: string } }) => void
      const cancelOld = oldRecognizer.canceled as (_sender: unknown, event: { reason: number }) => void
      await act(async () => {
        recognizeOld(null, { result: { reason: 1, text: 'Other session private text' } })
        cancelOld(null, { reason: 1 })
      })
      expect(result.current.phase).toBe('listening')
      expect(result.current.finalTranscript).toBe('')
      expect(onTranscript).not.toHaveBeenCalled()
      const recognizeNew = speechSdkMock.instances[1].recognized as typeof recognizeOld
      await act(async () => { recognizeNew(null, { result: { reason: 1, text: 'New session speech' } }) })
      await act(async () => { await result.current.stop() })
      expect(onTranscript).toHaveBeenCalledWith('New session speech')
      expect(onTranscript).not.toHaveBeenCalledWith(expect.stringContaining('Other session'))
    } finally {
      unmount()
      if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })

  it('keeps continuous recognition past five minutes and stops at its configured limit', async () => {
    speechSdkMock.stop.mockClear()
    const stopTrack = vi.fn()
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }),
    } })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input) === '/settings/speech'
      ? Response.json({ configured: true, enabled: true, provider: 'azure', mode: 'realtime', region: 'japaneast', realtimeMaxMinutes: 7 })
      : Response.json({ token: 'token', region: 'japaneast', expiresInSeconds: 600 })))
    const { result, unmount } = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn() }))
    try {
      await waitFor(() => expect(result.current.configuration?.mode).toBe('realtime'))
      vi.useFakeTimers()
      await act(async () => { await result.current.start() })
      expect(result.current.phase).toBe('listening')
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000) })
      expect(result.current.phase).toBe('listening')
      expect(speechSdkMock.stop).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000 - 1000) })
      expect(speechSdkMock.stop).toHaveBeenCalledOnce()
      expect(result.current.phase).not.toBe('listening')
    } finally {
      unmount()
      if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })
})
