import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { joinTranscriptChunks, mergeTranscriptAtCaret, useVoiceRecorder } from './useVoiceRecorder.js'

afterEach(() => {
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
})

describe('realtime voice warmup', () => {
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
})
