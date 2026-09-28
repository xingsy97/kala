import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

import {
  loadSpeechSettings,
  requestSpeechToken,
  SPEECH_SETTINGS_CHANGED_EVENT,
  transcribeSpeechRecording,
  type SpeechSettings,
} from './speech-api.js'

const MAX_RECORDING_MS = 5 * 60_000
const WAVEFORM_POINTS = 64

export type VoiceRecorderPhase = 'idle' | 'requesting' | 'listening' | 'processing' | 'error'
export type VoiceRecorderError = 'microphone_unavailable' | 'permission_denied' | 'service_unavailable' | 'not_configured' | 'no_speech' | 'secure_context_required'

export type VoiceRecorderState = {
  phase: VoiceRecorderPhase
  configuration: SpeechSettings | null
  finalTranscript: string
  interimTranscript: string
  elapsedSeconds: number
  levels: readonly number[]
  secureContext: boolean
  error?: VoiceRecorderError
}

type Recognizer = import('microsoft-cognitiveservices-speech-sdk').SpeechRecognizer
type SpeechSdk = typeof import('microsoft-cognitiveservices-speech-sdk')
type RealtimeResources = { token: Awaited<ReturnType<typeof requestSpeechToken>>; sdk: SpeechSdk }

let speechSdkPromise: Promise<SpeechSdk> | null = null

function loadSpeechSdk(): Promise<SpeechSdk> {
  speechSdkPromise ??= import('microsoft-cognitiveservices-speech-sdk')
  return speechSdkPromise
}

export function useVoiceRecorder(options: {
  onTranscript(transcript: string): void
  onConfigure?(): void
}): VoiceRecorderState & {
  start(): Promise<void>
  stop(): Promise<string | undefined>
  cancel(): Promise<void>
  retry(): Promise<void>
  dismissError(): void
  prepare(): Promise<void>
  refreshConfiguration(): Promise<SpeechSettings | null>
} {
  const [state, setState] = useState<VoiceRecorderState>({
    phase: 'idle',
    configuration: null,
    finalTranscript: '',
    interimTranscript: '',
    elapsedSeconds: 0,
    levels: emptyLevels(),
    secureContext: isSecureVoiceContext(),
  })
  const configurationRef = useRef<SpeechSettings | null>(null)
  const recognizerRef = useRef<Recognizer | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const pendingRecordingRef = useRef<Blob | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const elapsedTimerRef = useRef<number | null>(null)
  const maximumTimerRef = useRef<number | null>(null)
  const tokenRefreshTimerRef = useRef<number | null>(null)
  const speechTokenRef = useRef<{ token: RealtimeResources['token']; expiresAt: number } | null>(null)
  const realtimeWarmupRef = useRef<Promise<RealtimeResources> | null>(null)
  const finalTranscriptRef = useRef('')
  const interimTranscriptRef = useRef('')
  const stoppingRef = useRef(false)
  const runIdRef = useRef(0)
  const mountedRef = useRef(true)
  const onTranscriptRef = useRef(options.onTranscript)
  const onConfigureRef = useRef(options.onConfigure)

  useEffect(() => {
    onTranscriptRef.current = options.onTranscript
    onConfigureRef.current = options.onConfigure
  }, [options.onConfigure, options.onTranscript])

  const refreshConfiguration = useCallback(async (): Promise<SpeechSettings | null> => {
    try {
      const configuration = await loadSpeechSettings()
      configurationRef.current = configuration
      if (configuration.configured && configuration.enabled && configuration.mode === 'realtime') void loadSpeechSdk()
      if (mountedRef.current) setState((current) => ({ ...current, configuration }))
      return configuration
    } catch {
      configurationRef.current = null
      if (mountedRef.current) setState((current) => ({ ...current, configuration: null }))
      return null
    }
  }, [])

  const realtimeResources = useCallback(async (): Promise<RealtimeResources> => {
    const cached = speechTokenRef.current
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return { token: cached.token, sdk: await loadSpeechSdk() }
    }
    if (realtimeWarmupRef.current) return realtimeWarmupRef.current
    const request = Promise.all([requestSpeechToken(), loadSpeechSdk()])
      .then(([token, sdk]) => {
        speechTokenRef.current = {
          token,
          expiresAt: Date.now() + token.expiresInSeconds * 1_000,
        }
        return { token, sdk }
      })
      .finally(() => {
        if (realtimeWarmupRef.current === request) realtimeWarmupRef.current = null
      })
    realtimeWarmupRef.current = request
    return request
  }, [])

  const prepare = useCallback(async (): Promise<void> => {
    const configuration = configurationRef.current ?? await refreshConfiguration()
    if (!configuration?.configured || !configuration.enabled || configuration.mode !== 'realtime') return
    await realtimeResources()
  }, [realtimeResources, refreshConfiguration])

  const releaseMedia = useCallback((): void => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
    if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current)
    if (maximumTimerRef.current !== null) window.clearTimeout(maximumTimerRef.current)
    if (tokenRefreshTimerRef.current !== null) window.clearTimeout(tokenRefreshTimerRef.current)
    animationFrameRef.current = null
    elapsedTimerRef.current = null
    maximumTimerRef.current = null
    tokenRefreshTimerRef.current = null
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    const audioContext = audioContextRef.current
    audioContextRef.current = null
    if (audioContext && audioContext.state !== 'closed') void audioContext.close()
  }, [])

  const submitRecording = useCallback(async (recording: Blob): Promise<string | undefined> => {
    try {
      const transcript = await transcribeSpeechRecording(recording)
      pendingRecordingRef.current = null
      onTranscriptRef.current(transcript)
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          phase: 'idle',
          error: undefined,
          finalTranscript: '',
          interimTranscript: '',
          elapsedSeconds: 0,
          levels: emptyLevels(),
        }))
      }
      return transcript
    } catch {
      pendingRecordingRef.current = recording
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          phase: 'error',
          error: 'service_unavailable',
          finalTranscript: '',
          interimTranscript: '',
          levels: emptyLevels(),
        }))
      }
      return undefined
    }
  }, [])

  const finish = useCallback(async (commit: boolean, error?: VoiceRecorderError): Promise<string | undefined> => {
    if (stoppingRef.current) return undefined
    stoppingRef.current = true
    runIdRef.current += 1
    if (mountedRef.current && !error) setState((current) => ({ ...current, phase: 'processing' }))
    const mediaRecorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    let recording: Blob | undefined
    if (mediaRecorder) {
      await stopMediaRecorder(mediaRecorder)
      recording = new Blob(recordedChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' })
      recordedChunksRef.current = []
    }
    const recognizer = recognizerRef.current
    recognizerRef.current = null
    if (recognizer) {
      await new Promise<void>((resolve) => {
        recognizer.stopContinuousRecognitionAsync(resolve, () => resolve())
      })
      recognizer.close()
    }
    releaseMedia()
    const transcript = joinTranscriptChunks(finalTranscriptRef.current, interimTranscriptRef.current).trim()
    finalTranscriptRef.current = ''
    interimTranscriptRef.current = ''
    stoppingRef.current = false
    if (!commit) pendingRecordingRef.current = null
    if (commit && recording && !error) {
      return await submitRecording(recording)
    }
    if (commit && transcript) onTranscriptRef.current(transcript)
    if (!mountedRef.current) return commit && !error && transcript ? transcript : undefined
    if (error) {
      setState((current) => ({ ...current, phase: 'error', error, finalTranscript: transcript, interimTranscript: '', levels: emptyLevels() }))
    } else if (commit && !transcript) {
      setState((current) => ({ ...current, phase: 'error', error: 'no_speech', finalTranscript: '', interimTranscript: '', levels: emptyLevels() }))
    } else {
      setState((current) => ({ ...current, phase: 'idle', error: undefined, finalTranscript: '', interimTranscript: '', elapsedSeconds: 0, levels: emptyLevels() }))
    }
    return commit && !error && transcript ? transcript : undefined
  }, [releaseMedia, submitRecording])

  const stop = useCallback(async (): Promise<string | undefined> => {
    return await finish(true)
  }, [finish])

  const cancel = useCallback(async (): Promise<void> => {
    await finish(false)
  }, [finish])

  const start = useCallback(async (): Promise<void> => {
    if (state.phase !== 'idle' && state.phase !== 'error') return
    const configuration = configurationRef.current ?? await refreshConfiguration()
    if (!configuration?.configured || !configuration.enabled) {
      if (onConfigureRef.current) onConfigureRef.current()
      else setState((current) => ({ ...current, phase: 'error', error: 'not_configured' }))
      return
    }
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setState((current) => ({ ...current, phase: 'error', error: 'microphone_unavailable' }))
      return
    }
    if (!isSecureVoiceContext()) {
      setState((current) => ({ ...current, phase: 'error', error: 'secure_context_required' }))
      return
    }

    setState((current) => ({ ...current, phase: 'requesting', error: undefined, finalTranscript: '', interimTranscript: '', elapsedSeconds: 0, levels: emptyLevels() }))
    const runId = ++runIdRef.current
    finalTranscriptRef.current = ''
    interimTranscriptRef.current = ''
    pendingRecordingRef.current = null
    try {
      const resourcesPromise = configuration.mode === 'realtime' ? realtimeResources() : undefined
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (runId !== runIdRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      streamRef.current = stream
      startWaveform(stream, audioContextRef, animationFrameRef, (levels) => {
        if (mountedRef.current) setState((current) => ({ ...current, levels }))
      })
      const startedAt = Date.now()
      elapsedTimerRef.current = window.setInterval(() => {
        if (mountedRef.current) setState((current) => ({ ...current, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }))
      }, 250)
      maximumTimerRef.current = window.setTimeout(() => { void finish(true) }, MAX_RECORDING_MS)
      if (configuration.mode === 'after_recording') {
        if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable')
        const mimeType = preferredRecordingMediaType()
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        recordedChunksRef.current = []
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) recordedChunksRef.current.push(event.data)
        })
        mediaRecorderRef.current = recorder
        recorder.start(1_000)
        setState((current) => ({ ...current, phase: 'listening' }))
        return
      }
      const { token, sdk } = await resourcesPromise!
      if (!mountedRef.current || runId !== runIdRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token.token, token.region)
      speechConfig.outputFormat = sdk.OutputFormat.Detailed
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous')
      const audioConfig = sdk.AudioConfig.fromStreamInput(stream)
      const languages = sdk.AutoDetectSourceLanguageConfig.fromLanguages(['zh-CN', 'en-US'])
      const recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, languages, audioConfig)
      recognizerRef.current = recognizer
      recognizer.recognizing = (_sender, event) => {
        const interimTranscript = event.result.text.trim()
        interimTranscriptRef.current = interimTranscript
        if (mountedRef.current) setState((current) => ({ ...current, interimTranscript }))
      }
      recognizer.recognized = (_sender, event) => {
        if (event.result.reason !== sdk.ResultReason.RecognizedSpeech) return
        const finalTranscript = joinTranscriptChunks(finalTranscriptRef.current, event.result.text)
        finalTranscriptRef.current = finalTranscript
        interimTranscriptRef.current = ''
        if (mountedRef.current) setState((current) => ({ ...current, finalTranscript, interimTranscript: '' }))
      }
      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.Error) void finish(true, 'service_unavailable')
      }
      const refreshToken = async (): Promise<void> => {
        try {
          const refreshed = await requestSpeechToken()
          if (runId !== runIdRef.current || recognizerRef.current !== recognizer) return
          speechTokenRef.current = {
            token: refreshed,
            expiresAt: Date.now() + refreshed.expiresInSeconds * 1_000,
          }
          recognizer.authorizationToken = refreshed.token
          tokenRefreshTimerRef.current = window.setTimeout(
            () => { void refreshToken() },
            Math.max(60, refreshed.expiresInSeconds - 120) * 1000,
          )
        } catch {
          await finish(true, 'service_unavailable')
        }
      }
      tokenRefreshTimerRef.current = window.setTimeout(
        () => { void refreshToken() },
        Math.max(60, token.expiresInSeconds - 120) * 1000,
      )
      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, reject)
      })
      setState((current) => ({ ...current, phase: 'listening' }))
    } catch (error) {
      if (runId !== runIdRef.current) return
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      recognizerRef.current?.close()
      recognizerRef.current = null
      releaseMedia()
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          phase: 'error',
          error: denied ? 'permission_denied' : 'service_unavailable',
          levels: emptyLevels(),
        }))
      }
    }
  }, [finish, realtimeResources, refreshConfiguration, releaseMedia, state.phase])

  useEffect(() => {
    mountedRef.current = true
    void refreshConfiguration()
    const refresh = (): void => { void refreshConfiguration() }
    window.addEventListener(SPEECH_SETTINGS_CHANGED_EVENT, refresh)
    return () => {
      mountedRef.current = false
      window.removeEventListener(SPEECH_SETTINGS_CHANGED_EVENT, refresh)
      void finish(false)
    }
  }, [finish, refreshConfiguration])

  return {
    ...state,
    start,
    stop,
    cancel,
    retry: async () => {
      const recording = pendingRecordingRef.current
      if (!recording) {
        await start()
        return
      }
      setState((current) => ({ ...current, phase: 'processing', error: undefined }))
      await submitRecording(recording)
    },
    dismissError: () => {
      pendingRecordingRef.current = null
      setState((current) => ({ ...current, phase: 'idle', error: undefined, finalTranscript: '', interimTranscript: '' }))
    },
    prepare,
    refreshConfiguration,
  }
}

export function mergeTranscriptAtCaret(draft: string, caret: number, transcript: string): string {
  const cleanTranscript = transcript.trim()
  if (!cleanTranscript) return draft
  if (!draft.trim()) return cleanTranscript
  const boundedCaret = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, boundedCaret)
  const after = draft.slice(boundedCaret)
  const leftSpacer = needsSpace(before.at(-1), cleanTranscript.at(0)) ? ' ' : ''
  const rightSpacer = needsSpace(cleanTranscript.at(-1), after.at(0)) ? ' ' : ''
  return `${before}${leftSpacer}${cleanTranscript}${rightSpacer}${after}`
}

export function joinTranscriptChunks(left: string, right: string): string {
  const cleanLeft = left.trim()
  const cleanRight = right.trim()
  if (!cleanLeft) return cleanRight
  if (!cleanRight) return cleanLeft
  return `${cleanLeft}${needsSpace(cleanLeft.at(-1), cleanRight.at(0)) ? ' ' : ''}${cleanRight}`
}

function needsSpace(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && /[\p{L}\p{N}]/u.test(left) && /[\p{L}\p{N}]/u.test(right) && /[\u0000-\u024f]/u.test(left) && /[\u0000-\u024f]/u.test(right))
}

function emptyLevels(): number[] {
  return Array.from({ length: WAVEFORM_POINTS }, () => 0)
}

function isSecureVoiceContext(): boolean {
  return typeof window === 'undefined' || window.isSecureContext !== false
}

function preferredRecordingMediaType(): string {
  for (const mediaType of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mediaType)) return mediaType
  }
  return ''
}

async function stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === 'inactive') return
  await new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.stop()
  })
}

function startWaveform(
  stream: MediaStream,
  audioContextRef: MutableRefObject<AudioContext | null>,
  animationFrameRef: MutableRefObject<number | null>,
  onLevels: (levels: readonly number[]) => void,
): void {
  if (typeof AudioContext === 'undefined') return
  const context = new AudioContext()
  audioContextRef.current = context
  if (context.state === 'suspended') void context.resume()
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Uint8Array(analyser.fftSize)
  let history = emptyLevels()
  let displayedLevel = 0
  let lastSampleAt = -Infinity
  const update = (timestamp = 0): void => {
    analyser.getByteTimeDomainData(samples)
    if (timestamp - lastSampleAt >= 48) {
      let squareSum = 0
      for (const sample of samples) {
        const normalized = (sample - 128) / 128
        squareSum += normalized * normalized
      }
      const rms = Math.sqrt(squareSum / samples.length)
      const target = rms <= 0.012 ? 0 : Math.min(1, (rms - 0.012) * 16)
      const response = target > displayedLevel ? 0.62 : 0.18
      displayedLevel += (target - displayedLevel) * response
      history = [...history.slice(1), displayedLevel]
      onLevels(history)
      lastSampleAt = timestamp
    }
    animationFrameRef.current = requestAnimationFrame(update)
  }
  update()
}
