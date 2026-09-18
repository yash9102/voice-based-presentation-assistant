import { useRef, useCallback, useEffect } from 'react'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

export function useWebSocket({ onMessage, onOpen, onClose } = {}) {
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)
  const shouldReconnect = useRef(true)
  const attemptRef = useRef(0)
  const onMessageRef = useRef(onMessage)
  const onOpenRef = useRef(onOpen)
  const onCloseRef = useRef(onClose)

  useEffect(() => { onMessageRef.current = onMessage }, [onMessage])
  useEffect(() => { onOpenRef.current = onOpen }, [onOpen])
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      attemptRef.current = 0
      onOpenRef.current?.()
    }
    ws.onmessage = (e) => {
      try {
        onMessageRef.current?.(JSON.parse(e.data))
      } catch (err) {
        console.error('WS parse error', err)
      }
    }
    ws.onclose = () => {
      // Unmount closes the socket too — don't resurrect it afterwards.
      if (!shouldReconnect.current) return
      onCloseRef.current?.()
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptRef.current, RECONNECT_MAX_MS)
      attemptRef.current += 1
      reconnectTimer.current = setTimeout(connect, delay)
    }
    ws.onerror = (err) => console.error('WebSocket error', err)
  }, [])

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  useEffect(() => {
    shouldReconnect.current = true
    connect()
    return () => {
      shouldReconnect.current = false
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { send }

}