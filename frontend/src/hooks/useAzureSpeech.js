import { useRef, useCallback, useEffect } from 'react'

// Escape special XML chars in SSML
const xmlEsc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// VAD tuning — threshold is calibrated against the room's noise floor at init,
// never below the floor-independent minimum.
const VAD_MIN_THRESHOLD = 22
const VAD_FLOOR_MARGIN = 14
const VAD_CALIBRATION_MS = 600
const VAD_POLL_MS = 40
const VAD_HITS_TO_INTERRUPT = 3   // ~120ms of sustained speech, not one stray frame

// Azure auth tokens live 10 minutes; refresh well inside that for both TTS and STT.
const TOKEN_TTL_MS = 9 * 60 * 1000
const TOKEN_REFRESH_MS = 8 * 60 * 1000

export function useAzureSpeech({ onRecognized, onRecognizing, onInterrupt, onStateChange, onSlideFinished } = {}) {
  // STT (Azure Speech SDK — kept for recognition quality)
  const recognizerRef = useRef(null)
  const isRecognizingRef = useRef(false)
  const SpeechSDKRef = useRef(null)

  // TTS — REST API + Web Audio API (we own the pipeline = instant stop)
  const ttsAudioCtxRef = useRef(null)
  const currentSourceRef = useRef(null)
  const abortCtrlRef = useRef(null)
  const ttsTokenRef = useRef(null)
  const ttsRegionRef = useRef(null)
  const ttsTokenExpiryRef = useRef(0)
  const tokenTimerRef = useRef(null)

  // TTS queue
  const ttsQueueRef = useRef([])
  const ttsBufferRef = useRef('')
  const isSpeakingRef = useRef(false)

  // VAD
  const vadAudioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const vadTimerRef = useRef(null)
  const micStreamRef = useRef(null)
  const vadCooldownRef = useRef(false)
  const vadThresholdRef = useRef(VAD_MIN_THRESHOLD)
  const vadHitsRef = useRef(0)

  // Stable callback refs
  const onRecognizedRef = useRef(onRecognized)
  const onRecognizingRef = useRef(onRecognizing)
  const onInterruptRef = useRef(onInterrupt)
  const onStateChangeRef = useRef(onStateChange)
  const onSlideFinishedRef = useRef(onSlideFinished)

  useEffect(() => { onRecognizedRef.current = onRecognized }, [onRecognized])
  useEffect(() => { onRecognizingRef.current = onRecognizing }, [onRecognizing])
  useEffect(() => { onInterruptRef.current = onInterrupt }, [onInterrupt])
  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  useEffect(() => { onSlideFinishedRef.current = onSlideFinished }, [onSlideFinished])

  // ── Token management (10-min expiry, refresh with 60s buffer)
  const getToken = useCallback(async () => {
    if (Date.now() < ttsTokenExpiryRef.current - 60_000 && ttsTokenRef.current) {
      return ttsTokenRef.current
    }
    const { token, region, error } = await fetch('/speech-token').then((r) => r.json())
    if (!token) throw new Error(error || 'No speech token returned')
    ttsTokenRef.current = token
    ttsRegionRef.current = region
    ttsTokenExpiryRef.current = Date.now() + TOKEN_TTL_MS
    // The recognizer was built with the *initial* token — without this it goes
    // silent the moment that token expires mid-presentation.
    if (recognizerRef.current) recognizerRef.current.authorizationToken = token
    return token
  }, [])

  // ── VAD: polls every 40ms, fires immediately on one frame above threshold
  const startVAD = useCallback((stream) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.3
      src.connect(analyser)
      vadAudioCtxRef.current = ctx
      analyserRef.current = analyser

      const data = new Uint8Array(analyser.frequencyBinCount)
      const readLevel = () => {
        analyser.getByteFrequencyData(data)
        return data.reduce((a, b) => a + b, 0) / data.length
      }

      // Calibrate against this room/mic before the AI starts talking, so a noisy
      // environment doesn't self-interrupt and a quiet one stays sensitive.
      const calibrationEnd = Date.now() + VAD_CALIBRATION_MS
      let floorPeak = 0

      const poll = () => {
        const avg = readLevel()

        if (Date.now() < calibrationEnd) {
          floorPeak = Math.max(floorPeak, avg)
          vadThresholdRef.current = Math.max(VAD_MIN_THRESHOLD, floorPeak + VAD_FLOOR_MARGIN)
          vadTimerRef.current = setTimeout(poll, VAD_POLL_MS)
          return
        }

        if (avg > vadThresholdRef.current && isSpeakingRef.current && !vadCooldownRef.current) {
          vadHitsRef.current += 1
          if (vadHitsRef.current >= VAD_HITS_TO_INTERRUPT) {
            vadHitsRef.current = 0
            vadCooldownRef.current = true
            onInterruptRef.current?.()
            setTimeout(() => { vadCooldownRef.current = false }, 800)
          }
        } else {
          vadHitsRef.current = 0
        }
        vadTimerRef.current = setTimeout(poll, VAD_POLL_MS)
      }
      poll()
    } catch (e) {
      console.warn('VAD init failed:', e)
    }
  }, []) // eslint-disable-line

  const stopVAD = useCallback(() => {
    clearTimeout(vadTimerRef.current)
    vadAudioCtxRef.current?.close()
    vadAudioCtxRef.current = null
  }, [])

  // ── STT
  const stopListening = useCallback(() => {
    if (!recognizerRef.current || !isRecognizingRef.current) return
    isRecognizingRef.current = false
    recognizerRef.current.stopContinuousRecognitionAsync(() => {}, (e) => console.warn('STT stop:', e))
  }, [])

  const startListening = useCallback(() => {
    if (!recognizerRef.current || isRecognizingRef.current) return
    isRecognizingRef.current = true
    recognizerRef.current.startContinuousRecognitionAsync(() => {}, (e) => {
      console.error('STT start:', e)
      isRecognizingRef.current = false
    })
  }, [])

  // ── TTS REST API playback — one sentence at a time
  const playSentence = useCallback(async (text) => {
    // Cancel any previous in-flight fetch
    abortCtrlRef.current?.abort()
    const ctrl = new AbortController()
    abortCtrlRef.current = ctrl

    try {
      const token = await getToken()
      const region = ttsRegionRef.current

      const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='en-US-AndrewNeural'>${xmlEsc(text)}</voice></speak>`

      const res = await fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          },
          body: ssml,
          signal: ctrl.signal,
        }
      )
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)

      const buf = await res.arrayBuffer()
      if (!isSpeakingRef.current) return   // interrupted while fetching

      // Resume AudioContext if browser suspended it (autoplay policy)
      if (ttsAudioCtxRef.current.state === 'suspended') {
        await ttsAudioCtxRef.current.resume()
      }

      const audioBuf = await ttsAudioCtxRef.current.decodeAudioData(buf)
      if (!isSpeakingRef.current) return   // interrupted while decoding

      await new Promise((resolve) => {
        const src = ttsAudioCtxRef.current.createBufferSource()
        src.buffer = audioBuf
        src.connect(ttsAudioCtxRef.current.destination)
        currentSourceRef.current = src
        src.onended = () => {
          if (currentSourceRef.current === src) currentSourceRef.current = null
          resolve()
        }
        src.start()
      })
    } catch (err) {
      if (err.name !== 'AbortError') console.error('TTS error:', err)
    }
  }, [getToken])

  // ── Queue processor
  const processQueue = useCallback(() => {
    if (ttsQueueRef.current.length === 0) {
      isSpeakingRef.current = false
      onStateChangeRef.current?.('listening')
      setTimeout(() => startListening(), 150)
      onSlideFinishedRef.current?.()
      return
    }
    isSpeakingRef.current = true
    onStateChangeRef.current?.('speaking')
    if (!isRecognizingRef.current) startListening()

    const text = ttsQueueRef.current.shift()
    playSentence(text).then(() => {
      if (isSpeakingRef.current) processQueue()
    })
  }, [startListening, playSentence])

  const addTTSChunk = useCallback((text) => {
    ttsBufferRef.current += ' ' + text
    const pattern = /[^.!?]+[.!?]+/g
    let match
    while ((match = pattern.exec(ttsBufferRef.current)) !== null) {
      ttsQueueRef.current.push(match[0].trim())
    }
    ttsBufferRef.current = ttsBufferRef.current.replace(/[^.!?]+[.!?]+/g, '').trim()
    if (!isSpeakingRef.current) processQueue()
  }, [processQueue])

  const flushTTSBuffer = useCallback(() => {
    const rem = ttsBufferRef.current.trim()
    if (rem) { ttsQueueRef.current.push(rem); ttsBufferRef.current = '' }
    if (!isSpeakingRef.current) processQueue()
  }, [processQueue])

  // ── INSTANT STOP — source.stop() cuts audio in <1ms (no SDK buffer lag)
  const stopSpeaking = useCallback(() => {
    ttsQueueRef.current = []
    ttsBufferRef.current = ''
    isSpeakingRef.current = false

    abortCtrlRef.current?.abort()   // cancel any in-flight TTS fetch
    abortCtrlRef.current = null

    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop() } catch (_) {}  // <1ms, synchronous
      currentSourceRef.current = null
    }
  }, [])

  // ── Init
  const init = useCallback(async () => {
    const SpeechSDK = window.SpeechSDK
    if (!SpeechSDK) throw new Error('Azure Speech SDK not loaded')
    SpeechSDKRef.current = SpeechSDK

    // Mic stream for VAD. STT stays open while the AI talks (that's what makes
    // barge-in work), so AEC is required or the agent hears itself on speakers.
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    micStreamRef.current = micStream
    startVAD(micStream)

    // TTS AudioContext (separate from VAD)
    ttsAudioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()

    // Fetch initial token (caches for 9 min)
    await getToken()

    // STT recognizer (Azure SDK — kept for recognition accuracy)
    const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
      ttsTokenRef.current,
      ttsRegionRef.current
    )
    speechConfig.speechRecognitionLanguage = 'en-US'
    speechConfig.setProperty('SpeechServiceConnection_RecoModelName', 'conversation')

    // Reuse the echo-cancelled stream rather than letting the SDK open a second,
    // unconstrained mic of its own.
    let audioInConfig
    try {
      audioInConfig = SpeechSDK.AudioConfig.fromStreamInput(micStream)
    } catch (e) {
      console.warn('fromStreamInput unavailable, falling back to default mic:', e)
      audioInConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput()
    }
    recognizerRef.current = new SpeechSDK.SpeechRecognizer(speechConfig, audioInConfig)

    recognizerRef.current.recognized = (_s, e) => {
      if (
        e?.result?.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
        e?.result?.text?.trim()
      ) {
        onRecognizedRef.current?.(e.result.text.trim())
      }
    }
    recognizerRef.current.sessionStopped = () => { isRecognizingRef.current = false }
    recognizerRef.current.canceled = (_s, e) => {
      console.warn('STT canceled:', e?.errorDetails || e?.reason)
      isRecognizingRef.current = false
    }

    // Keep both TTS and STT tokens alive even through long silent stretches,
    // where nothing else would call getToken().
    clearInterval(tokenTimerRef.current)
    tokenTimerRef.current = setInterval(() => {
      ttsTokenExpiryRef.current = 0   // force a fetch
      getToken().catch((e) => console.warn('Token refresh failed:', e))
    }, TOKEN_REFRESH_MS)
  }, [startVAD, getToken])

  useEffect(() => {
    return () => {
      stopVAD()
      clearInterval(tokenTimerRef.current)
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
      abortCtrlRef.current?.abort()
      try { currentSourceRef.current?.stop() } catch (_) {}
      ttsAudioCtxRef.current?.close()
      try { recognizerRef.current?.close() } catch (_) {}
    }
  }, [stopVAD])

  return { init, addTTSChunk, flushTTSBuffer, stopSpeaking, startListening, stopListening }
}

