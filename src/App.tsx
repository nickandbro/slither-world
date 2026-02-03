import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createWebGLScene } from './webglScene'
import type { Camera, GameStateSnapshot, Point, Quaternion } from './gameTypes'

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

const LOCAL_STORAGE_ID = 'spherical_snake_player_id'
const LOCAL_STORAGE_NAME = 'spherical_snake_player_name'
const LOCAL_STORAGE_BEST = 'spherical_snake_best_score'
const LOCAL_STORAGE_ROOM = 'spherical_snake_room'
const DEFAULT_ROOM = 'main'

function normalize(point: Point) {
  const len = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z)
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 }
  return { x: point.x / len, y: point.y / len, z: point.z / len }
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

function quatFromTo(from: Point, to: Point): Quaternion {
  const f = normalize(from)
  const t = normalize(to)
  const d = dot(f, t)
  if (d > 0.9999) return { ...IDENTITY_QUAT }
  if (d < -0.9999) {
    const axis = Math.abs(f.x) < 0.9 ? cross(f, { x: 1, y: 0, z: 0 }) : cross(f, { x: 0, y: 1, z: 0 })
    const normAxis = normalize(axis)
    return normalizeQuat({ x: normAxis.x, y: normAxis.y, z: normAxis.z, w: 0 })
  }
  const axis = cross(f, t)
  return normalizeQuat({ x: axis.x, y: axis.y, z: axis.z, w: 1 + d })
}

function quatSlerp(a: Quaternion, b: Quaternion, t: number) {
  let cosOmega = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w

  if (cosOmega < 0) {
    cosOmega = -cosOmega
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }

  if (cosOmega > 0.9995) {
    return normalizeQuat({
      x: a.x + t * (bx - a.x),
      y: a.y + t * (by - a.y),
      z: a.z + t * (bz - a.z),
      w: a.w + t * (bw - a.w),
    })
  }

  const omega = Math.acos(cosOmega)
  const sinOmega = Math.sin(omega)
  const scaleA = Math.sin((1 - t) * omega) / sinOmega
  const scaleB = Math.sin(t * omega) / sinOmega
  return {
    x: a.x * scaleA + bx * scaleB,
    y: a.y * scaleA + by * scaleB,
    z: a.z * scaleA + bz * scaleB,
    w: a.w * scaleA + bw * scaleB,
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

function updateCamera(head: Point | null, current: Camera): Camera {
  if (!head) return { q: { ...IDENTITY_QUAT }, active: false }
  const desired = quatFromTo(head, { x: 0, y: 0, z: 1 })
  if (!current.active) return { q: desired, active: true }
  const blended = quatSlerp(current.q, desired, 0.2)
  return { q: blended, active: true }
}

function axisFromPointer(angle: number, camera: Camera) {
  const axis = { x: -Math.sin(angle), y: Math.cos(angle), z: 0 }
  if (!camera.active) return normalize(axis)
  const inverse = { x: -camera.q.x, y: -camera.q.y, z: -camera.q.z, w: camera.q.w }
  return normalize(rotateVectorByQuat(axis, inverse))
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  pointerAngle: number | null,
) {
  ctx.clearRect(0, 0, config.width, config.height)
  if (pointerAngle === null) return

  const radius = Math.min(config.width, config.height) * 0.22
  ctx.beginPath()
  ctx.moveTo(config.centerX, config.centerY)
  ctx.lineTo(
    config.centerX + Math.cos(pointerAngle) * radius,
    config.centerY + Math.sin(pointerAngle) * radius,
  )
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = Math.max(2, config.width * 0.004)
  ctx.lineCap = 'round'
  ctx.stroke()

  ctx.beginPath()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.arc(config.centerX, config.centerY, Math.max(2, config.width * 0.006), 0, Math.PI * 2)
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
  const snapshotRef = useRef<GameStateSnapshot | null>(null)
  const cameraRef = useRef<Camera>({ q: { ...IDENTITY_QUAT }, active: false })

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

  useEffect(() => {
    snapshotRef.current = gameState
  }, [gameState])

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
        const snapshot = snapshotRef.current
        const localId = playerIdRef.current
        const localHead =
          snapshot?.players.find((player) => player.id === localId)?.snake[0] ?? null
        const camera = updateCamera(localHead, cameraRef.current)
        cameraRef.current = camera
        webgl.render(snapshot, camera, localId)
        drawHud(hudCtx, config, pointerRef.current.active ? pointerRef.current.angle : null)
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
          if (message.state) setGameState(message.state)
          return
        }
        if (message.type === 'state') {
          if (message.state) setGameState(message.state)
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
