import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createWebGLScene } from './webglScene'
import type { Camera, GameStateSnapshot, PlayerSnapshot, Point, Quaternion } from './gameTypes'

type LeaderboardEntry = {
  name: string
  score: number
  created_at: number
}

type RenderConfig = {
  width: number
  height: number
  centerX: number
  centerY: number
}

type TimedSnapshot = GameStateSnapshot & {
  receivedAt: number
}

const LOCAL_STORAGE_ID = 'spherical_snake_player_id'
const LOCAL_STORAGE_NAME = 'spherical_snake_player_name'
const LOCAL_STORAGE_BEST = 'spherical_snake_best_score'
const LOCAL_STORAGE_ROOM = 'spherical_snake_room'
const DEFAULT_ROOM = 'main'

const MAX_SNAPSHOT_BUFFER = 20
const MIN_INTERP_DELAY_MS = 60
const MAX_EXTRAPOLATION_MS = 70
const OFFSET_SMOOTHING = 0.12

function normalize(point: Point) {
  const len = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z)
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 }
  return { x: point.x / len, y: point.y / len, z: point.z / len }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function cross(a: Point, b: Point): Point {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

const IDENTITY_QUAT: Quaternion = { x: 0, y: 0, z: 0, w: 1 }

function normalizeQuat(q: Quaternion) {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  if (!Number.isFinite(len) || len === 0) return { ...IDENTITY_QUAT }
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
}

function quatFromBasis(right: Point, up: Point, forward: Point): Quaternion {
  const m00 = right.x
  const m01 = right.y
  const m02 = right.z
  const m10 = up.x
  const m11 = up.y
  const m12 = up.z
  const m20 = forward.x
  const m21 = forward.y
  const m22 = forward.z

  const trace = m00 + m11 + m22
  let x = 0
  let y = 0
  let z = 0
  let w = 1

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m21 - m12) * s
    y = (m02 - m20) * s
    z = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  }

  return {
    x,
    y,
    z,
    w,
  }
}

function rotateVectorByQuat(vector: Point, q: Quaternion) {
  const qv = { x: q.x, y: q.y, z: q.z }
  const uv = cross(qv, vector)
  const uuv = cross(qv, uv)
  return {
    x: vector.x + (uv.x * q.w + uuv.x) * 2,
    y: vector.y + (uv.y * q.w + uuv.y) * 2,
    z: vector.z + (uv.z * q.w + uuv.z) * 2,
  }
}

function updateCamera(head: Point | null, current: Camera, upRef: { current: Point }): Camera {
  if (!head) return { q: { ...IDENTITY_QUAT }, active: false }
  const headNorm = normalize(head)
  const currentUp = upRef.current
  const upDot = dot(currentUp, headNorm)
  let projectedUp = {
    x: currentUp.x - headNorm.x * upDot,
    y: currentUp.y - headNorm.y * upDot,
    z: currentUp.z - headNorm.z * upDot,
  }
  let projectedLen = Math.sqrt(
    projectedUp.x * projectedUp.x +
      projectedUp.y * projectedUp.y +
      projectedUp.z * projectedUp.z,
  )
  if (!Number.isFinite(projectedLen) || projectedLen < 1e-3) {
    const fallback = Math.abs(headNorm.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
    const fallbackDot = dot(fallback, headNorm)
    projectedUp = {
      x: fallback.x - headNorm.x * fallbackDot,
      y: fallback.y - headNorm.y * fallbackDot,
      z: fallback.z - headNorm.z * fallbackDot,
    }
    projectedLen = Math.sqrt(
      projectedUp.x * projectedUp.x +
        projectedUp.y * projectedUp.y +
        projectedUp.z * projectedUp.z,
    )
  }
  projectedUp = normalize(projectedUp)
  upRef.current = projectedUp

  let right = cross(projectedUp, headNorm)
  right = normalize(right)
  let upOrtho = cross(headNorm, right)
  upOrtho = normalize(upOrtho)

  const desired = normalizeQuat(quatFromBasis(right, upOrtho, headNorm))
  return { q: desired, active: true }
}

function axisFromPointer(angle: number, camera: Camera) {
  const axis = { x: Math.sin(angle), y: Math.cos(angle), z: 0 }
  if (!camera.active) return normalize(axis)
  const inverse = { x: -camera.q.x, y: -camera.q.y, z: -camera.q.z, w: camera.q.w }
  return normalize(rotateVectorByQuat(axis, inverse))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  }
}

function blendPlayers(a: PlayerSnapshot, b: PlayerSnapshot, t: number): PlayerSnapshot {
  const maxLength = Math.max(a.snake.length, b.snake.length)
  const snake: Point[] = []

  for (let i = 0; i < maxLength; i += 1) {
    const nodeA = a.snake[i]
    const nodeB = b.snake[i]
    if (nodeA && nodeB) {
      snake.push(lerpPoint(nodeA, nodeB, t))
    } else if (nodeB) {
      snake.push({ ...nodeB })
    } else if (nodeA) {
      snake.push({ ...nodeA })
    }
  }

  return {
    id: b.id,
    name: b.name,
    color: b.color,
    score: b.score,
    alive: b.alive,
    snake,
    digestions: blendDigestions(a.digestions, b.digestions, t),
  }
}

function blendDigestions(a: number[], b: number[], t: number) {
  const maxLength = Math.max(a.length, b.length)
  const digestions: number[] = []
  for (let i = 0; i < maxLength; i += 1) {
    const da = a[i]
    const db = b[i]
    if (typeof da === 'number' && typeof db === 'number') {
      digestions.push(clamp(lerp(da, db, t), 0, 1))
    } else if (typeof db === 'number') {
      digestions.push(db)
    } else if (typeof da === 'number' && t < 0.95) {
      digestions.push(da)
    }
  }
  return digestions
}

function blendSnapshots(a: GameStateSnapshot, b: GameStateSnapshot, t: number): GameStateSnapshot {
  const playersA = new Map(a.players.map((player) => [player.id, player]))
  const playersB = new Map(b.players.map((player) => [player.id, player]))
  const orderedIds: string[] = []

  for (const player of b.players) orderedIds.push(player.id)
  for (const player of a.players) {
    if (!playersB.has(player.id)) orderedIds.push(player.id)
  }

  const players: PlayerSnapshot[] = []
  for (const id of orderedIds) {
    const playerA = playersA.get(id)
    const playerB = playersB.get(id)
    if (playerA && playerB) {
      players.push(blendPlayers(playerA, playerB, t))
    } else if (playerB) {
      players.push(playerB)
    } else if (playerA && t < 0.95) {
      players.push(playerA)
    }
  }

  return {
    now: lerp(a.now, b.now, t),
    pellets: t < 0.5 ? a.pellets : b.pellets,
    players,
  }
}

function buildInterpolatedSnapshot(
  buffer: TimedSnapshot[],
  renderTime: number,
  maxExtrapolationMs: number,
): GameStateSnapshot | null {
  if (buffer.length === 0) return null

  while (buffer.length > 2 && buffer[1].now <= renderTime - maxExtrapolationMs) {
    buffer.shift()
  }

  let before = buffer[0]
  let after: TimedSnapshot | undefined

  for (let i = 1; i < buffer.length; i += 1) {
    if (buffer[i].now >= renderTime) {
      before = buffer[i - 1]
      after = buffer[i]
      break
    }
  }

  if (!after) {
    const latest = buffer[buffer.length - 1]
    const previous = buffer.length > 1 ? buffer[buffer.length - 2] : null
    const extra = renderTime - latest.now
    if (previous && extra > 0 && extra <= maxExtrapolationMs) {
      const dt = latest.now - previous.now
      if (dt > 0) {
        const t = 1 + extra / dt
        return blendSnapshots(previous, latest, t)
      }
    }
    return latest
  }

  if (renderTime <= before.now) return before

  const span = after.now - before.now
  if (span <= 0) return before
  const t = (renderTime - before.now) / span
  return blendSnapshots(before, after, t)
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  pointerAngle: number | null,
  origin: { x: number; y: number } | null,
) {
  ctx.clearRect(0, 0, config.width, config.height)
  if (pointerAngle === null) return

  const originX = origin?.x ?? config.centerX
  const originY = origin?.y ?? config.centerY
  const radius = Math.min(config.width, config.height) * 0.22
  ctx.beginPath()
  ctx.moveTo(originX, originY)
  ctx.lineTo(
    originX + Math.cos(pointerAngle) * radius,
    originY + Math.sin(pointerAngle) * radius,
  )
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = Math.max(2, config.width * 0.004)
  ctx.lineCap = 'round'
  ctx.stroke()

  ctx.beginPath()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.arc(originX, originY, Math.max(2, config.width * 0.006), 0, Math.PI * 2)
  ctx.fill()
}

function getInitialName() {
  const stored = localStorage.getItem(LOCAL_STORAGE_NAME)
  if (stored) return stored
  const fallback = `Player-${Math.floor(Math.random() * 999) + 1}`
  localStorage.setItem(LOCAL_STORAGE_NAME, fallback)
  return fallback
}

function getStoredBestScore() {
  const value = localStorage.getItem(LOCAL_STORAGE_BEST)
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getStoredPlayerId() {
  return localStorage.getItem(LOCAL_STORAGE_ID)
}

function getInitialRoom() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('room')
  const stored = localStorage.getItem(LOCAL_STORAGE_ROOM)
  return sanitizeRoomName(fromUrl ?? stored ?? DEFAULT_ROOM)
}

function sanitizeRoomName(value: string) {
  const cleaned = value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '')
  if (!cleaned) return DEFAULT_ROOM
  return cleaned.slice(0, 20)
}

export default function App() {
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const renderConfigRef = useRef<RenderConfig | null>(null)
  const pointerRef = useRef({ angle: 0, boost: false, active: false })
  const sendIntervalRef = useRef<number | null>(null)
  const snapshotBufferRef = useRef<TimedSnapshot[]>([])
  const serverOffsetRef = useRef<number | null>(null)
  const tickIntervalRef = useRef(50)
  const lastSnapshotTimeRef = useRef<number | null>(null)
  const cameraRef = useRef<Camera>({ q: { ...IDENTITY_QUAT }, active: false })
  const cameraUpRef = useRef<Point>({ x: 0, y: 1, z: 0 })

  const [gameState, setGameState] = useState<GameStateSnapshot | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(getStoredPlayerId())
  const [playerName, setPlayerName] = useState(getInitialName)
  const [roomName, setRoomName] = useState(getInitialRoom)
  const [roomInput, setRoomInput] = useState(getInitialRoom)
  const [bestScore, setBestScore] = useState(getStoredBestScore)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [connectionStatus, setConnectionStatus] = useState('Connecting')
  const [leaderboardStatus, setLeaderboardStatus] = useState('')
  const playerIdRef = useRef<string | null>(playerId)
  const playerNameRef = useRef(playerName)

  const localPlayer = useMemo(() => {
    return gameState?.players.find((player) => player.id === playerId) ?? null
  }, [gameState, playerId])

  const score = localPlayer?.score ?? 0
  const playersOnline = gameState?.players.length ?? 0

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
    if (score > bestScore) {
      setBestScore(score)
      localStorage.setItem(LOCAL_STORAGE_BEST, String(score))
    }
  }, [score, bestScore])

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_NAME, playerName)
  }, [playerName])

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_ROOM, roomName)
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

    let frameId = 0
    const renderLoop = () => {
      const config = renderConfigRef.current
      if (config) {
        const snapshot = getRenderSnapshot()
        const localId = playerIdRef.current
        const localHead =
          snapshot?.players.find((player) => player.id === localId)?.snake[0] ?? null
        const camera = updateCamera(localHead, cameraRef.current, cameraUpRef)
        cameraRef.current = camera
        const headScreen = webgl.render(snapshot, camera, localId)
        drawHud(
          hudCtx,
          config,
          pointerRef.current.active ? pointerRef.current.angle : null,
          headScreen,
        )
      }
      frameId = window.requestAnimationFrame(renderLoop)
    }

    renderLoop()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateConfig)
      window.cancelAnimationFrame(frameId)
      webgl.dispose()
    }
  }, [])

  useEffect(() => {
    let reconnectTimer: number | null = null
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(
        `${protocol}://${window.location.host}/api/room/${encodeURIComponent(roomName)}`,
      )
      socketRef.current = socket
      snapshotBufferRef.current = []
      serverOffsetRef.current = null
      lastSnapshotTimeRef.current = null
      tickIntervalRef.current = 50
      setConnectionStatus('Connecting')
      setGameState(null)

      socket.addEventListener('open', () => {
        setConnectionStatus('Connected')
        sendJoin(socket)
        startInputLoop()
      })

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let payload: unknown
        try {
          payload = JSON.parse(event.data)
        } catch {
          return
        }
        if (!payload || typeof payload !== 'object') return
        const message = payload as {
          type?: string
          playerId?: string
          state?: GameStateSnapshot
        }
        if (message.type === 'init') {
          if (message.playerId) {
            setPlayerId(message.playerId)
            localStorage.setItem(LOCAL_STORAGE_ID, message.playerId)
          }
          if (message.state) {
            pushSnapshot(message.state)
            setGameState(message.state)
          }
          return
        }
        if (message.type === 'state') {
          if (message.state) {
            pushSnapshot(message.state)
            setGameState(message.state)
          }
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
    fetchLeaderboard()
    const interval = window.setInterval(fetchLeaderboard, 15000)
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
    const dx = event.clientX - rect.left - rect.width / 2
    const dy = event.clientY - rect.top - rect.height / 2
    pointerRef.current.angle = Math.atan2(dy, dx)
    pointerRef.current.active = true
  }

  const startInputLoop = () => {
    if (sendIntervalRef.current !== null) return
    sendIntervalRef.current = window.setInterval(() => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      if (!pointerRef.current.active) return
      const axis = axisFromPointer(pointerRef.current.angle, cameraRef.current)
      socket.send(
        JSON.stringify({
          type: 'input',
          axis,
          boost: pointerRef.current.boost,
        }),
      )
    }, 50)
  }

  const sendJoin = (socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(
      JSON.stringify({
        type: 'join',
        name: playerNameRef.current,
        playerId: playerIdRef.current,
      }),
    )
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
  }

  const requestRespawn = () => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'respawn' }))
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

  const submitBestScore = async () => {
    if (!bestScore) return
    setLeaderboardStatus('Submitting...')
    try {
      const res = await fetch('/api/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: playerName,
          score: bestScore,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setLeaderboardStatus(data.error ?? 'Submission failed')
        return
      }
      setLeaderboardStatus('Saved to leaderboard')
      fetchLeaderboard()
    } catch {
      setLeaderboardStatus('Submission failed')
    }
  }

  async function fetchLeaderboard() {
    try {
      const res = await fetch('/api/leaderboard')
      const data = (await res.json()) as { scores?: LeaderboardEntry[] }
      setLeaderboard(data.scores ?? [])
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
          <div className='control-row muted'>
            <span>Share the room name to invite players.</span>
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
          <div className='control-row muted'>
            <span>Point to steer. Press space to boost.</span>
          </div>
          <div className='control-row muted'>
            <span>Best this run: {bestScore}</span>
          </div>
        </div>
      </div>

      <aside className='leaderboard'>
        <div className='leaderboard-header'>
          <h2>Global leaderboard</h2>
          <button type='button' onClick={submitBestScore}>
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
