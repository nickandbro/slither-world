import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createWebGLScene, type WebGLScene } from './render/webglScene'
import type { Camera, Environment, GameStateSnapshot, Point } from './game/types'
import { axisFromPointer, updateCamera } from './game/camera'
import { IDENTITY_QUAT, clamp } from './game/math'
import { buildInterpolatedSnapshot, type TimedSnapshot } from './game/snapshots'
import { drawHud, type RenderConfig } from './game/hud'
import {
  getInitialName,
  getStoredBestScore,
  getStoredPlayerId,
  getInitialRoom,
  sanitizeRoomName,
  storeBestScore,
  storePlayerId,
  storePlayerName,
  storeRoomName,
} from './game/storage'
import { decodeServerMessage, encodeInput, encodeJoin, encodeRespawn, type PlayerMeta } from './game/wsProtocol'
import {
  fetchLeaderboard as fetchLeaderboardRequest,
  submitBestScore as submitBestScoreRequest,
  type LeaderboardEntry,
} from './services/leaderboard'
import { resolveWebSocketUrl } from './services/backend'

const MAX_SNAPSHOT_BUFFER = 20
const MIN_INTERP_DELAY_MS = 60
const MAX_EXTRAPOLATION_MS = 70

const MOUNTAIN_DEBUG_KEY = 'spherical_snake_mountain_debug'
const getMountainDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MOUNTAIN_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}
const OFFSET_SMOOTHING = 0.12
const CAMERA_DISTANCE_DEFAULT = 5.2
const CAMERA_DISTANCE_MIN = 4.2
const CAMERA_DISTANCE_MAX = 9
const CAMERA_ZOOM_SENSITIVITY = 0.0015
const POINTER_MAX_RANGE_RATIO = 0.25

export default function App() {
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const webglRef = useRef<WebGLScene | null>(null)
  const renderConfigRef = useRef<RenderConfig | null>(null)
  const pointerRef = useRef({
    angle: 0,
    boost: false,
    active: false,
    screenX: Number.NaN,
    screenY: Number.NaN,
    distance: 0,
    maxRange: 0,
  })
  const sendIntervalRef = useRef<number | null>(null)
  const snapshotBufferRef = useRef<TimedSnapshot[]>([])
  const serverOffsetRef = useRef<number | null>(null)
  const tickIntervalRef = useRef(50)
  const lastSnapshotTimeRef = useRef<number | null>(null)
  const cameraRef = useRef<Camera>({ q: { ...IDENTITY_QUAT }, active: false })
  const cameraUpRef = useRef<Point>({ x: 0, y: 1, z: 0 })
  const cameraDistanceRef = useRef(CAMERA_DISTANCE_DEFAULT)
  const headScreenRef = useRef<{ x: number; y: number } | null>(null)
  const playerMetaRef = useRef<Map<string, PlayerMeta>>(new Map())

  const [gameState, setGameState] = useState<GameStateSnapshot | null>(null)
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(getStoredPlayerId())
  const [playerName, setPlayerName] = useState(getInitialName)
  const [roomName, setRoomName] = useState(getInitialRoom)
  const [roomInput, setRoomInput] = useState(getInitialRoom)
  const [bestScore, setBestScore] = useState(getStoredBestScore)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [connectionStatus, setConnectionStatus] = useState('Connecting')
  const [leaderboardStatus, setLeaderboardStatus] = useState('')
  const [debugOpen, setDebugOpen] = useState(false)
  const [mountainDebug, setMountainDebug] = useState(getMountainDebug)
  const playerIdRef = useRef<string | null>(playerId)
  const playerNameRef = useRef(playerName)

  const localPlayer = useMemo(() => {
    return gameState?.players.find((player) => player.id === playerId) ?? null
  }, [gameState, playerId])

  const score = localPlayer?.score ?? 0
  const oxygenPct = localPlayer ? Math.round(clamp(localPlayer.oxygen, 0, 1) * 100) : 0
  const oxygenLow = oxygenPct <= 35
  const playersOnline = gameState?.players.length ?? 0
  const staminaPlayers = useMemo(() => {
    if (!gameState) return []
    const localId = playerId
    return [...gameState.players].sort((a, b) => {
      if (a.id === localId) return -1
      if (b.id === localId) return 1
      return b.score - a.score
    })
  }, [gameState, playerId])

  const pushSnapshot = (state: GameStateSnapshot) => {
    const now = Date.now()
    const sampleOffset = state.now - now
    const currentOffset = serverOffsetRef.current
    serverOffsetRef.current =
      currentOffset === null ? sampleOffset : currentOffset + (sampleOffset - currentOffset) * OFFSET_SMOOTHING

    const lastSnapshotTime = lastSnapshotTimeRef.current
    if (lastSnapshotTime !== null) {
      const delta = state.now - lastSnapshotTime
      if (delta > 0 && delta < 1000) {
        tickIntervalRef.current = tickIntervalRef.current * 0.9 + delta * 0.1
      }
    }
    lastSnapshotTimeRef.current = state.now

    const buffer = snapshotBufferRef.current
    buffer.push({ ...state, receivedAt: now })
    buffer.sort((a, b) => a.now - b.now)
    if (buffer.length > MAX_SNAPSHOT_BUFFER) {
      buffer.splice(0, buffer.length - MAX_SNAPSHOT_BUFFER)
    }
  }

  const getRenderSnapshot = () => {
    const buffer = snapshotBufferRef.current
    if (buffer.length === 0) return null
    const offset = serverOffsetRef.current
    if (offset === null) return buffer[buffer.length - 1]

    const delay = Math.max(MIN_INTERP_DELAY_MS, tickIntervalRef.current * 1.5)
    const renderTime = Date.now() + offset - delay
    const snapshot = buildInterpolatedSnapshot(buffer, renderTime, MAX_EXTRAPOLATION_MS)
    return snapshot
  }

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  useEffect(() => {
    playerNameRef.current = playerName
  }, [playerName])

  useEffect(() => {
    const webgl = webglRef.current
    if (webgl && environment) {
      webgl.setEnvironment?.(environment)
    }
  }, [environment])

  useEffect(() => {
    try {
      window.localStorage.setItem(MOUNTAIN_DEBUG_KEY, mountainDebug ? '1' : '0')
    } catch {
      // ignore persistence errors
    }
    const webgl = webglRef.current
    webgl?.setDebugFlags?.({ mountainOutline: mountainDebug })
  }, [mountainDebug])

  useEffect(() => {
    if (score > bestScore) {
      setBestScore(score)
      storeBestScore(score)
    }
  }, [score, bestScore])

  useEffect(() => {
    storePlayerName(playerName)
  }, [playerName])

  useEffect(() => {
    storeRoomName(roomName)
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomName)
    window.history.replaceState({}, '', url)
  }, [roomName])

  useEffect(() => {
    const glCanvas = glCanvasRef.current
    const hudCanvas = hudCanvasRef.current
    if (!glCanvas || !hudCanvas) return
    const hudCtx = hudCanvas.getContext('2d')
    if (!hudCtx) return

    const webgl = createWebGLScene(glCanvas)
    webglRef.current = webgl
    if (environment) {
      webgl.setEnvironment?.(environment)
    }
    webgl.setDebugFlags?.({ mountainOutline: mountainDebug })

    const updateConfig = () => {
      const rect = glCanvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      webgl.resize(rect.width, rect.height, dpr)
      hudCanvas.width = Math.round(rect.width * dpr)
      hudCanvas.height = Math.round(rect.height * dpr)
      hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderConfigRef.current = {
        width: rect.width,
        height: rect.height,
        centerX: rect.width / 2,
        centerY: rect.height / 2,
      }
    }

    updateConfig()
    const observer = new ResizeObserver(updateConfig)
    observer.observe(glCanvas)
    window.addEventListener('resize', updateConfig)
    glCanvas.addEventListener('wheel', handleWheel, { passive: false })

    let frameId = 0
    const renderLoop = () => {
      const config = renderConfigRef.current
      if (config) {
        const snapshot = getRenderSnapshot()
        const localId = playerIdRef.current
        const localHead =
          snapshot?.players.find((player) => player.id === localId)?.snake[0] ?? null
        const camera = updateCamera(localHead, cameraUpRef)
        cameraRef.current = camera
        const headScreen = webgl.render(
          snapshot,
          camera,
          localId,
          cameraDistanceRef.current,
        )
        headScreenRef.current = headScreen
        drawHud(
          hudCtx,
          config,
          pointerRef.current.active ? pointerRef.current.angle : null,
          headScreen,
          pointerRef.current.active ? pointerRef.current.distance : null,
          pointerRef.current.active ? pointerRef.current.maxRange : null,
        )
      }
      frameId = window.requestAnimationFrame(renderLoop)
    }

    renderLoop()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateConfig)
      glCanvas.removeEventListener('wheel', handleWheel)
      window.cancelAnimationFrame(frameId)
      webgl.dispose()
      webglRef.current = null
    }
  }, [])

  useEffect(() => {
    let reconnectTimer: number | null = null
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      const socket = new WebSocket(
        resolveWebSocketUrl(`/api/room/${encodeURIComponent(roomName)}`),
      )
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket
      snapshotBufferRef.current = []
      serverOffsetRef.current = null
      lastSnapshotTimeRef.current = null
      tickIntervalRef.current = 50
      playerMetaRef.current = new Map()
      setConnectionStatus('Connecting')
      setGameState(null)
      setEnvironment(null)

      socket.addEventListener('open', () => {
        setConnectionStatus('Connected')
        sendJoin(socket)
        startInputLoop()
      })

      socket.addEventListener('message', (event) => {
        if (!(event.data instanceof ArrayBuffer)) return
        const decoded = decodeServerMessage(event.data, playerMetaRef.current)
        if (!decoded) return
        if (decoded.type === 'init') {
          setPlayerId(decoded.playerId)
          storePlayerId(decoded.playerId)
          setEnvironment(decoded.environment)
          pushSnapshot(decoded.state)
          setGameState(decoded.state)
          return
        }
        if (decoded.type === 'state') {
          pushSnapshot(decoded.state)
          setGameState(decoded.state)
        }
      })

      socket.addEventListener('close', () => {
        if (cancelled) return
        setConnectionStatus('Reconnecting')
        reconnectTimer = window.setTimeout(connect, 1500)
      })

      socket.addEventListener('error', () => {
        socket.close()
      })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [roomName])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault()
        pointerRef.current.boost = true
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault()
        pointerRef.current.boost = false
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    void refreshLeaderboard()
    const interval = window.setInterval(() => {
      void refreshLeaderboard()
    }, 15000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    return () => {
      if (sendIntervalRef.current !== null) {
        window.clearInterval(sendIntervalRef.current)
      }
      sendIntervalRef.current = null
    }
  }, [])

  const updatePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = glCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    const origin = headScreenRef.current
    const originX = origin?.x ?? rect.width / 2
    const originY = origin?.y ?? rect.height / 2
    const dx = localX - originX
    const dy = localY - originY
    const distance2d = Math.hypot(dx, dy)
    const maxRange = Math.min(rect.width, rect.height) * POINTER_MAX_RANGE_RATIO
    pointerRef.current.screenX = localX
    pointerRef.current.screenY = localY
    pointerRef.current.distance = distance2d
    pointerRef.current.maxRange = maxRange
    if (!Number.isFinite(distance2d) || !Number.isFinite(maxRange) || maxRange <= 0) {
      pointerRef.current.active = false
      return
    }
    if (distance2d > maxRange) {
      pointerRef.current.active = false
      return
    }
    pointerRef.current.angle = Math.atan2(dy, dx)
    pointerRef.current.active = true
  }

  const startInputLoop = () => {
    if (sendIntervalRef.current !== null) return
    sendIntervalRef.current = window.setInterval(() => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      const axis = pointerRef.current.active
        ? axisFromPointer(pointerRef.current.angle, cameraRef.current)
        : null
      socket.send(encodeInput(axis, pointerRef.current.boost))
    }, 50)
  }

  const sendJoin = (socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(encodeJoin(playerNameRef.current, playerIdRef.current))
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    updatePointer(event)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    updatePointer(event)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handlePointerLeave = () => {
    pointerRef.current.active = false
    pointerRef.current.screenX = Number.NaN
    pointerRef.current.screenY = Number.NaN
  }

  const handleWheel = (event: WheelEvent) => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
    if (event.cancelable) event.preventDefault()
    const clampedDelta = clamp(event.deltaY, -120, 120)
    const zoomFactor = Math.exp(clampedDelta * CAMERA_ZOOM_SENSITIVITY)
    const nextDistance = clamp(
      cameraDistanceRef.current * zoomFactor,
      CAMERA_DISTANCE_MIN,
      CAMERA_DISTANCE_MAX,
    )
    cameraDistanceRef.current = nextDistance
  }

  const requestRespawn = () => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(encodeRespawn())
  }

  const handleJoinRoom = () => {
    const nextRoom = sanitizeRoomName(roomInput)
    setRoomInput(nextRoom)
    if (nextRoom !== roomName) {
      setRoomName(nextRoom)
    } else if (socketRef.current) {
      sendJoin(socketRef.current)
    }
  }

  const handleSubmitBestScore = async () => {
    if (!bestScore) return
    setLeaderboardStatus('Submitting...')
    try {
      const result = await submitBestScoreRequest(playerName, bestScore)
      if (!result.ok) {
        setLeaderboardStatus(result.error ?? 'Submission failed')
        return
      }
      setLeaderboardStatus('Saved to leaderboard')
      void refreshLeaderboard()
    } catch {
      setLeaderboardStatus('Submission failed')
    }
  }

  async function refreshLeaderboard() {
    try {
      const scores = await fetchLeaderboardRequest()
      setLeaderboard(scores)
    } catch {
      setLeaderboard([])
    }
  }

  return (
    <div className='app'>
      <div className='game-card'>
        <div className='scorebar'>
          <div className='score'>Score: {score}</div>
          <div className='status'>
            Room {roomName} · {connectionStatus} · {playersOnline} online
          </div>
        </div>

        <div className='play-area'>
          <div className='game-surface'>
            <canvas
              ref={glCanvasRef}
              className='game-canvas'
              aria-label='Spherical snake arena'
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerLeave}
              onPointerCancel={handlePointerLeave}
              onContextMenu={(event) => event.preventDefault()}
            />
            <canvas ref={hudCanvasRef} className='hud-canvas' aria-hidden='true' />
            {staminaPlayers.length > 0 && (
              <div className='stamina-panel' aria-label='Stamina meters'>
                {staminaPlayers.map((player) => {
                  const pct = Math.round(clamp(player.stamina, 0, 1) * 100)
                  const displayName =
                    player.id === playerId ? `${player.name} (You)` : player.name
                  const rowClass = [
                    'stamina-row',
                    player.id === playerId ? 'is-local' : '',
                    player.alive ? '' : 'is-dead',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <div key={player.id} className={rowClass}>
                      <div className='stamina-header'>
                        <span className='stamina-name'>{displayName}</span>
                        <span className='stamina-value'>{pct}%</span>
                      </div>
                      <div className='stamina-bar'>
                        <div className='stamina-fill' style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {localPlayer && (
              <div className='oxygen-panel' aria-label='Oxygen meter'>
                <div className='oxygen-header'>
                  <span className='oxygen-label'>O2</span>
                  <span className='oxygen-value'>{oxygenPct}%</span>
                </div>
                <div className='oxygen-bar'>
                  <div
                    className={['oxygen-fill', oxygenLow ? 'is-low' : ''].filter(Boolean).join(' ')}
                    style={{ width: `${oxygenPct}%` }}
                  />
                </div>
              </div>
            )}
            <div className={['debug-drawer', debugOpen ? 'is-open' : ''].filter(Boolean).join(' ')}>
              <button
                type='button'
                className='debug-toggle'
                onClick={() => setDebugOpen((current) => !current)}
              >
                Debug
              </button>
              {debugOpen && (
                <div className='debug-panel'>
                  <label className='debug-item'>
                    <input
                      type='checkbox'
                      checked={mountainDebug}
                      onChange={(event) => setMountainDebug(event.target.checked)}
                    />
                    Mountain outlines
                  </label>
                </div>
              )}
            </div>
          </div>
          {localPlayer && !localPlayer.alive && (
            <div className='overlay'>
              <div className='overlay-title'>Good game!</div>
              <div className='overlay-subtitle'>Your trail is still glowing.</div>
              <button type='button' onClick={requestRespawn}>
                Play again
              </button>
            </div>
          )}
        </div>

        <div className='control-panel'>
          <div className='control-row'>
            <label className='control-label' htmlFor='room-name'>
              Room
            </label>
            <input
              id='room-name'
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleJoinRoom()
                }
              }}
            />
            <button type='button' onClick={handleJoinRoom}>
              Join
            </button>
          </div>
          <div className='control-row'>
            <label className='control-label' htmlFor='player-name'>
              Pilot name
            </label>
            <input
              id='player-name'
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              onBlur={() => socketRef.current && sendJoin(socketRef.current)}
            />
            <button
              type='button'
              onClick={() => socketRef.current && sendJoin(socketRef.current)}
            >
              Update
            </button>
          </div>
        </div>

        <div className='info-panel'>
          <div className='info-line'>Point to steer. Scroll to zoom. Press space to boost.</div>
          <div className='info-line'>Best this run: {bestScore}</div>
        </div>
      </div>

      <aside className='leaderboard'>
        <div className='leaderboard-header'>
          <h2>Global leaderboard</h2>
          <button type='button' onClick={handleSubmitBestScore}>
            Submit best
          </button>
        </div>
        {leaderboardStatus && <div className='leaderboard-status'>{leaderboardStatus}</div>}
        <ol>
          {leaderboard.length === 0 && <li className='muted'>No scores yet.</li>}
          {leaderboard.map((entry, index) => (
            <li key={`${entry.name}-${entry.created_at}-${index}`}>
              <span>{entry.name}</span>
              <span>{entry.score}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  )
}
