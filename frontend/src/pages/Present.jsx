import { useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSlides } from '../context/SlidesContext'
import { useAzureSpeech } from '../hooks/useAzureSpeech'
import { useWebSocket } from '../hooks/useWebSocket'
import SlideView from '../components/SlideView'
import VoiceOrb from '../components/VoiceOrb'
import SlideNav from '../components/SlideNav'
import StatusBar from '../components/StatusBar'
import TranscriptBubble from '../components/TranscriptBubble'

export default function Present() {
  const navigate = useNavigate()
  const { state, dispatch } = useSlides()
  const { slides, currentSlide, speechState, transcript, statusMessage } = state

  const speechInitRef = useRef(false)
  const speechStateRef = useRef(speechState)
  const currentSlideRef = useRef(currentSlide)
  const slidesRef = useRef(slides)
  const isAutoPresenting = useRef(false)

  // Every request carries an id the backend echoes back. Interrupting bumps it,
  // so any chunks already in flight for the abandoned turn are discarded.
  const reqIdRef = useRef(0)
  const nextReqId = () => ++reqIdRef.current

  useEffect(() => { speechStateRef.current = speechState }, [speechState])
  useEffect(() => { currentSlideRef.current = currentSlide }, [currentSlide])
  useEffect(() => { slidesRef.current = slides }, [slides])

  useEffect(() => {
    if (slides.length === 0) navigate('/')
  }, [slides, navigate])

  const handleInterrupt = useCallback(() => {
    const s = speechStateRef.current
    if (s === 'thinking' || s === 'idle' || s === 'listening') return
    isAutoPresenting.current = false
    speech.stopSpeaking()
    nextReqId()
    ws.send({ type: 'interrupt' })
    dispatch({ type: 'SET_SPEECH_STATE', payload: 'listening' })
    dispatch({ type: 'SET_STATUS', payload: 'Listening…' })
  }, []) // eslint-disable-line

  const handleRecognized = useCallback((text) => {
    dispatch({ type: 'SET_TRANSCRIPT', payload: text })
    dispatch({ type: 'SET_SPEECH_STATE', payload: 'thinking' })
    dispatch({ type: 'SET_STATUS', payload: 'Thinking…' })
    ws.send({
      type: 'user_input',
      text,
      current_slide: currentSlideRef.current,
      req_id: nextReqId(),
    })
  }, []) // eslint-disable-line

  const handleSlideFinished = useCallback(() => {
    if (!isAutoPresenting.current) return
    const next = currentSlideRef.current + 1
    if (next >= slidesRef.current.length) {
      isAutoPresenting.current = false
      return
    }
    setTimeout(() => {
      if (!isAutoPresenting.current) return
      dispatch({ type: 'SET_CURRENT_SLIDE', payload: next })
      ws.send({ type: 'navigate_request', slide: next, req_id: nextReqId() })
    }, 600)
  }, []) // eslint-disable-line

  const speech = useAzureSpeech({
    onInterrupt: handleInterrupt,
    onRecognized: handleRecognized,
    onSlideFinished: handleSlideFinished,
    onStateChange: (s) => {
      dispatch({ type: 'SET_SPEECH_STATE', payload: s })
      const labels = {
        idle: 'Ready',
        presenting: 'Starting…',
        listening: 'Listening…',
        thinking: 'Thinking…',
        speaking: 'Speaking…',
      }
      dispatch({ type: 'SET_STATUS', payload: labels[s] || s })
    },
  })

  const handleWsMessage = useCallback((msg) => {
    // Output from a turn the user already interrupted or superseded.
    if (msg.req_id !== undefined && msg.req_id !== reqIdRef.current) return

    switch (msg.type) {
      case 'navigate':
        dispatch({ type: 'SET_CURRENT_SLIDE', payload: msg.slide })
        break
      case 'thinking':
        if (msg.active) {
          dispatch({ type: 'SET_SPEECH_STATE', payload: 'thinking' })
          dispatch({ type: 'SET_STATUS', payload: 'Thinking…' })
        }
        break
      case 'text_chunk':
        dispatch({ type: 'SET_SPEECH_STATE', payload: 'speaking' })
        dispatch({ type: 'SET_STATUS', payload: 'Speaking…' })
        speech.addTTSChunk(msg.text)
        if (msg.is_final) speech.flushTTSBuffer()
        break
      case 'start_auto_present': {
        const startSlide = msg.from_slide ?? 0
        isAutoPresenting.current = true
        dispatch({ type: 'SET_CURRENT_SLIDE', payload: startSlide })
        ws.send({ type: 'navigate_request', slide: startSlide, req_id: nextReqId() })
        break
      }
      case 'speech_end':
        break
      case 'error':
        console.error('Backend error:', msg.message)
        dispatch({ type: 'SET_STATUS', payload: `Error: ${msg.message}` })
        dispatch({ type: 'SET_SPEECH_STATE', payload: 'listening' })
        isAutoPresenting.current = false
        break
      default:
        break
    }
  }, [speech, dispatch]) // eslint-disable-line

  const ws = useWebSocket({
    onOpen: () => {
      if (!speechInitRef.current) {
        speechInitRef.current = true
        dispatch({ type: 'SET_STATUS', payload: 'Initializing voice…' })
        speech.init()
          .then(() => {
            dispatch({ type: 'SET_SPEECH_STATE', payload: 'presenting' })
            ws.send({ type: 'start_presentation', slide: 0, slides, req_id: nextReqId() })
          })
          .catch((err) => {
            console.error('Azure Speech init failed:', err)
            dispatch({ type: 'SET_STATUS', payload: 'Voice init failed — check console' })
          })
      } else {
        ws.send({
          type: 'start_presentation',
          slide: currentSlideRef.current,
          slides,
          req_id: nextReqId(),
        })
      }
    },
    onMessage: handleWsMessage,
    onClose: () => dispatch({ type: 'SET_STATUS', payload: 'Reconnecting…' }),
  })

  const handleSlideSelect = useCallback((idx) => {
    isAutoPresenting.current = false
    speech.stopSpeaking()
    nextReqId()
    ws.send({ type: 'interrupt' })
    dispatch({ type: 'SET_CURRENT_SLIDE', payload: idx })
    ws.send({ type: 'navigate_request', slide: idx, req_id: nextReqId() })
  }, [speech, ws, dispatch])

  const handleExit = () => {
    isAutoPresenting.current = false
    speech.stopSpeaking()
    dispatch({ type: 'RESET' })
    navigate('/')
  }

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const t = e.target
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return

      const last = slidesRef.current.length - 1
      const cur = currentSlideRef.current
      const goTo = (idx) => {
        const clamped = Math.max(0, Math.min(last, idx))
        if (clamped !== cur) handleSlideSelect(clamped)
      }

      switch (e.code === 'Space' ? ' ' : e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          goTo(cur + 1)
          break
        case 'ArrowLeft':
        case 'PageUp':
          goTo(cur - 1)
          break
        case 'Home':
          goTo(0)
          break
        case 'End':
          goTo(last)
          break
        case 'Escape':
          handleInterrupt()
          break
        case 'q':
        case 'Q':
          handleExit()
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSlideSelect, handleInterrupt]) // eslint-disable-line

  if (slides.length === 0) return null

  return (
    <div className="present-layout">
      <main className="slide-area">
        <SlideView slide={slides[currentSlide]} index={currentSlide} total={slides.length} />
      </main>

      <aside className="voice-panel">
        <button className="exit-btn" onClick={handleExit} title="Exit presentation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
        <div className="voice-panel-top">
          <VoiceOrb state={speechState} />
          <StatusBar message={statusMessage} state={speechState} />
        </div>
        <TranscriptBubble text={transcript} />
        <div className="voice-hint">
          {(speechState === 'speaking' || speechState === 'presenting') && (
            <span>Speak to interrupt</span>
          )}
          {speechState === 'listening' && (
            <span>Ask anything about these slides</span>
          )}
          <span className="key-hint">← → navigate · Esc interrupt · Q exit</span>
        </div>
      </aside>

      <footer className="nav-footer">
        <SlideNav total={slides.length} current={currentSlide} onSelect={handleSlideSelect} />
      </footer>
    </div>
  )
}

