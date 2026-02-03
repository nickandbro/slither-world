import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Point = {
  x: number
  y: number
  z: number
}

type PlayerSnapshot = {
  id: string
  name: string
  color: string
  score: number
  alive: boolean
  snake: Point[]
}

type GameStateSnapshot = {
  now: number
  pellets: Point[]
  players: PlayerSnapshot[]
}

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
  focalLength: number
}

const NODE_ANGLE = Math.PI / 60
const GRID_COUNT = 40
const BASE_SIZE = 360
const FOCAL_LENGTH = 200
const LOCAL_STORAGE_ID = 'spherical_snake_player_id'
const LOCAL_STORAGE_NAME = 'spherical_snake_player_name'
const LOCAL_STORAGE_BEST = 'spherical_snake_best_score'
const LOCAL_STORAGE_ROOM = 'spherical_snake_room'
const DEFAULT_ROOM = 'main'

const GRID_POINTS = createGridPoints(GRID_COUNT)

function createGridPoints(n: number) {
  const points: Point[] = []
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      points.push(pointFromSpherical((i / n) * Math.PI * 2, (j / n) * Math.PI))
    }
  }
  return points
}

function pointFromSpherical(theta: number, phi: number): Point {
  const sinPhi = Math.sin(phi)
  return {
    x: Math.cos(theta) * sinPhi,
    y: Math.sin(theta) * sinPhi,
    z: Math.cos(phi),
  }
}

const colorCache = new Map<string, { r: number; g: number; b: number }>()

function hexToRgb(hex: string) {
  const cached = colorCache.get(hex)
  if (cached) return cached
  const cleaned = hex.replace('#', '')
  const value = Number.parseInt(cleaned.length === 3
    ? cleaned
        .split('')
        .map((char) => char + char)
        .join('')
    : cleaned, 16)
  const rgb = {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
  colorCache.set(hex, rgb)
  return rgb
}

function drawPoint(
  ctx: CanvasRenderingContext2D,
  point: Point,
  radius: number,
  color: string,
  config: RenderConfig,
) {
  const p = { x: point.x, y: point.y, z: point.z + 2 }
  p.x *= -1 * config.focalLength / p.z
  p.y *= -1 * config.focalLength / p.z
  const scaledRadius = radius * config.focalLength / p.z
  p.x += config.centerX
  p.y += config.centerY

  const alpha = 1 - (p.z - 1) / 2
  const depthShade = 0.4 + 0.6 * alpha
  const rgb = hexToRgb(color)

  ctx.beginPath()
  ctx.fillStyle = `rgba(${Math.round(rgb.r * depthShade)}, ${Math.round(rgb.g * depthShade)}, ${Math.round(
    rgb.b * depthShade,
  )}, ${alpha})`
  ctx.arc(p.x, p.y, scaledRadius, 0, Math.PI * 2)
  ctx.fill()
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  config: RenderConfig,
  snapshot: GameStateSnapshot | null,
  pointerAngle: number | null,
  localPlayerId: string | null,
) {
  ctx.clearRect(0, 0, config.width, config.height)

  for (const point of GRID_POINTS) {
    drawPoint(ctx, point, 1 / 250, '#2a6f97', config)
  }

  if (snapshot) {
    for (const player of snapshot.players) {
      const color = player.color
      const opacityBoost = player.id === localPlayerId ? 1 : 0.9
      for (const node of player.snake) {
        drawPoint(ctx, node, NODE_ANGLE * opacityBoost, color, config)
      }
    }

    for (const pellet of snapshot.pellets) {
      drawPoint(ctx, pellet, NODE_ANGLE, '#ffb703', config)
    }
  }

  if (pointerAngle !== null) {
    ctx.beginPath()
    ctx.moveTo(config.centerX, config.centerY)
    const r = (NODE_ANGLE / 2) * config.focalLength * 2.2
    ctx.lineTo(
      config.centerX + Math.cos(pointerAngle) * r,
      config.centerY + Math.sin(pointerAngle) * r,
    )
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.lineWidth = 1
  }

  ctx.beginPath()
  ctx.strokeStyle = '#0b1320'
  ctx.arc(config.centerX, config.centerY, 0.58 * config.focalLength, 0, Math.PI * 2)
  ctx.stroke()
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const renderConfigRef = useRef<RenderConfig | null>(null)
  const pointerRef = useRef({ angle: 0, boost: false, active: false })
  const sendIntervalRef = useRef<number | null>(null)
  const snapshotRef = useRef<GameStateSnapshot | null>(null)

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
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const updateConfig = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderConfigRef.current = {
        width: rect.width,
        height: rect.height,
        centerX: rect.width / 2,
        centerY: rect.height / 2,
        focalLength: FOCAL_LENGTH * (rect.width / BASE_SIZE),
      }
    }

    updateConfig()
    const observer = new ResizeObserver(updateConfig)
    observer.observe(canvas)
    window.addEventListener('resize', updateConfig)

    let frameId = 0
    const renderLoop = () => {
      const config = renderConfigRef.current
      if (config) {
        drawScene(
          ctx,
          config,
          snapshotRef.current,
          pointerRef.current.active ? pointerRef.current.angle : null,
          playerId,
        )
      }
      frameId = window.requestAnimationFrame(renderLoop)
    }

    renderLoop()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateConfig)
      window.cancelAnimationFrame(frameId)
    }
  }, [playerId])

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
    const canvas = canvasRef.current
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
      socket.send(
        JSON.stringify({
          type: 'input',
          direction: pointerRef.current.angle,
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
            {connectionStatus} · {playersOnline} online
          </div>
        </div>

        <div className='play-area'>
          <canvas
            ref={canvasRef}
            className='game-canvas'
            aria-label='Spherical snake arena'
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onPointerCancel={handlePointerLeave}
            onContextMenu={(event) => event.preventDefault()}
          />
          {localPlayer && !localPlayer.alive && (
            <div className='overlay'>
              <div className='overlay-title'>Good game!</div>
              <div className='overlay-subtitle'>Reforming your snake...</div>
            </div>
          )}
        </div>

        <div className='control-panel'>
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
