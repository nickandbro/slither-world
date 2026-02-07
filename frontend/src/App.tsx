import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  createRenderScene,
  type DayNightDebugMode,
  type RenderScene,
  type RendererBackend,
  type RendererPreference,
} from './render/webglScene'
import type { Camera, Environment, GameStateSnapshot, Point } from './game/types'
import { axisFromPointer, updateCamera } from './game/camera'
import { IDENTITY_QUAT, clamp, normalize, normalizeQuat } from './game/math'
import { buildInterpolatedSnapshot, type TimedSnapshot } from './game/snapshots'
import { drawHud, type RenderConfig } from './game/hud'
import {
  createRandomPlayerName,
  DEFAULT_ROOM,
  getInitialName,
  getStoredBestScore,
  getStoredPlayerId,
  getInitialRendererPreference,
  sanitizeRoomName,
  storeBestScore,
  storePlayerId,
  storePlayerName,
  storeRoomName,
  storeRendererPreference,
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
const LAKE_DEBUG_KEY = 'spherical_snake_lake_debug'
const TREE_DEBUG_KEY = 'spherical_snake_tree_debug'
const TERRAIN_WIREFRAME_DEBUG_KEY = 'spherical_snake_terrain_wireframe_debug'
const TERRAIN_TESSELLATION_DEBUG_KEY_LEGACY = 'spherical_snake_terrain_tessellation_debug'
const DAY_NIGHT_DEBUG_MODE_KEY = 'spherical_snake_day_night_debug_mode'
const DEBUG_UI_ENABLED = import.meta.env.DEV || import.meta.env.VITE_E2E_DEBUG === '1'
const getMountainDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MOUNTAIN_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}
const getLakeDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LAKE_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}
const getTreeDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(TREE_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}
const getTerrainTessellationDebug = () => {
  if (typeof window === 'undefined') return false
  try {
    const wireframe = window.localStorage.getItem(TERRAIN_WIREFRAME_DEBUG_KEY)
    if (wireframe !== null) return wireframe === '1'
    return window.localStorage.getItem(TERRAIN_TESSELLATION_DEBUG_KEY_LEGACY) === '1'
  } catch {
    return false
  }
}
const getDayNightDebugMode = (): DayNightDebugMode => {
  if (typeof window === 'undefined') return 'auto'
  try {
    const value = window.localStorage.getItem(DAY_NIGHT_DEBUG_MODE_KEY)
    if (value === 'auto' || value === 'accelerated') return value
  } catch {
    // ignore persistence errors
  }
  return 'auto'
}
const OFFSET_SMOOTHING = 0.12
const CAMERA_DISTANCE_DEFAULT = 5.2
const CAMERA_DISTANCE_MIN = 4.2
const CAMERA_DISTANCE_MAX = 9
const CAMERA_ZOOM_SENSITIVITY = 0.0015
const POINTER_MAX_RANGE_RATIO = 0.25
const CAMERA_FOV_DEGREES = 40
const PLANET_RADIUS = 3
const VIEW_RADIUS_EXTRA_MARGIN = 0.08
const BOOST_EFFECT_FADE_IN_RATE = 9
const BOOST_EFFECT_FADE_OUT_RATE = 12
const BOOST_EFFECT_PULSE_SPEED = 8.5
const BOOST_EFFECT_ACTIVE_CLASS_THRESHOLD = 0.01
const SCORE_RADIAL_FADE_IN_RATE = 10
const SCORE_RADIAL_FADE_OUT_RATE = 8
const SCORE_RADIAL_RESERVE_SMOOTH_UP_RATE = 16
const SCORE_RADIAL_RESERVE_SMOOTH_DOWN_RATE = 16
const SCORE_RADIAL_RESERVE_MAX_UP_SPEED = 4.5
const SCORE_RADIAL_RESERVE_MAX_DOWN_SPEED = 5
const SCORE_RADIAL_RESERVE_BURST_UP_RATE = 30
const SCORE_RADIAL_RESERVE_BURST_MAX_UP_SPEED = 12
const SCORE_RADIAL_RESERVE_BURST_DELTA_THRESHOLD = 0.18
const SCORE_RADIAL_RESERVE_BURST_DURATION_MS = 140
const MENU_CAMERA_DISTANCE = 7
const MENU_CAMERA_VERTICAL_OFFSET = 2.5
const MENU_TO_GAMEPLAY_BLEND_MS = 900
const formatRendererError = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'Renderer initialization failed'
}

const surfaceAngleFromRay = (cameraDistance: number, halfFov: number) => {
  const clampedDistance = Math.max(cameraDistance, PLANET_RADIUS + 1e-3)
  const sinHalf = Math.sin(halfFov)
  const cosHalf = Math.cos(halfFov)
  const underSqrt = PLANET_RADIUS * PLANET_RADIUS - clampedDistance * clampedDistance * sinHalf * sinHalf
  if (underSqrt <= 0) {
    return Math.acos(clamp(PLANET_RADIUS / clampedDistance, -1, 1))
  }
  const rayDistance = clampedDistance * cosHalf - Math.sqrt(underSqrt)
  const hitZ = clampedDistance - rayDistance * cosHalf
  return Math.acos(clamp(hitZ / PLANET_RADIUS, -1, 1))
}

const computeViewRadius = (cameraDistance: number, aspect: number) => {
  const halfY = (CAMERA_FOV_DEGREES * Math.PI) / 360
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfX = Math.atan(Math.tan(halfY) * safeAspect)
  const halfDiag = Math.min(Math.PI * 0.499, Math.hypot(halfX, halfY))
  const base = surfaceAngleFromRay(cameraDistance, halfDiag)
  return clamp(base + VIEW_RADIUS_EXTRA_MARGIN, 0.2, 1.4)
}

type BoostFxState = {
  intensity: number
  pulse: number
  lastFrameMs: number
  activeClassApplied: boolean
}

type ScoreRadialVisualState = {
  lastBoosting: boolean
  displayReserve: number | null
  burstBoostUntilMs: number
  lastIntervalPct: number
  lastDisplayScore: number
  opacity: number
  lastFrameMs: number
}

type MenuPhase = 'preplay' | 'spawning' | 'playing'

type MenuFlowDebugInfo = {
  phase: MenuPhase
  hasSpawned: boolean
  cameraBlend: number
  cameraDistance: number
}

const MENU_CAMERA_TARGET = normalize({ x: 0.06, y: 0.992, z: 0.11 })
const createMenuCamera = () => {
  const upRef = { current: { x: 0, y: 1, z: 0 } }
  const camera = updateCamera(MENU_CAMERA_TARGET, upRef)
  if (camera.active) return camera
  return { q: { ...IDENTITY_QUAT }, active: true }
}
const MENU_CAMERA = createMenuCamera()

const easeInOutCubic = (t: number) => {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

const slerpQuaternion = (a: Camera['q'], b: Camera['q'], t: number): Camera['q'] => {
  const clampedT = clamp(t, 0, 1)
  if (clampedT <= 0) return a
  if (clampedT >= 1) return b

  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw

  if (cosHalfTheta < 0) {
    cosHalfTheta = -cosHalfTheta
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }

  if (cosHalfTheta > 0.9995) {
    return normalizeQuat({
      x: a.x + (bx - a.x) * clampedT,
      y: a.y + (by - a.y) * clampedT,
      z: a.z + (bz - a.z) * clampedT,
      w: a.w + (bw - a.w) * clampedT,
    })
  }

  const halfTheta = Math.acos(clamp(cosHalfTheta, -1, 1))
  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta)
  if (!Number.isFinite(sinHalfTheta) || sinHalfTheta < 1e-6) {
    return normalizeQuat({
      x: a.x + (bx - a.x) * clampedT,
      y: a.y + (by - a.y) * clampedT,
      z: a.z + (bz - a.z) * clampedT,
      w: a.w + (bw - a.w) * clampedT,
    })
  }

  const ratioA = Math.sin((1 - clampedT) * halfTheta) / sinHalfTheta
  const ratioB = Math.sin(clampedT * halfTheta) / sinHalfTheta
  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  }
}

export default function App() {
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const boostFxRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const webglRef = useRef<RenderScene | null>(null)
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
  const renderCameraDistanceRef = useRef(MENU_CAMERA_DISTANCE)
  const renderCameraVerticalOffsetRef = useRef(MENU_CAMERA_VERTICAL_OFFSET)
  const localHeadRef = useRef<Point | null>(MENU_CAMERA_TARGET)
  const headScreenRef = useRef<{ x: number; y: number } | null>(null)
  const playerMetaRef = useRef<Map<string, PlayerMeta>>(new Map())
  const menuPhaseRef = useRef<MenuPhase>('preplay')
  const inputEnabledRef = useRef(false)
  const cameraBlendRef = useRef(0)
  const cameraBlendStartMsRef = useRef<number | null>(null)
  const menuDebugInfoRef = useRef<MenuFlowDebugInfo>({
    phase: 'preplay',
    hasSpawned: false,
    cameraBlend: 0,
    cameraDistance: Math.hypot(MENU_CAMERA_DISTANCE, MENU_CAMERA_VERTICAL_OFFSET),
  })
  const boostFxStateRef = useRef<BoostFxState>({
    intensity: 0,
    pulse: 0,
    lastFrameMs: 0,
    activeClassApplied: false,
  })
  const scoreRadialStateRef = useRef<ScoreRadialVisualState>({
    lastBoosting: false,
    displayReserve: null,
    burstBoostUntilMs: 0,
    lastIntervalPct: 100,
    lastDisplayScore: 0,
    opacity: 0,
    lastFrameMs: 0,
  })

  const [gameState, setGameState] = useState<GameStateSnapshot | null>(null)
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(getStoredPlayerId())
  const [playerName, setPlayerName] = useState(getInitialName)
  const [roomName, setRoomName] = useState(DEFAULT_ROOM)
  const [roomInput, setRoomInput] = useState(DEFAULT_ROOM)
  const [rendererPreference] = useState<RendererPreference>(getInitialRendererPreference)
  const [bestScore, setBestScore] = useState(getStoredBestScore)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [connectionStatus, setConnectionStatus] = useState('Connecting')
  const [leaderboardStatus, setLeaderboardStatus] = useState('')
  const [activeRenderer, setActiveRenderer] = useState<RendererBackend | null>(null)
  const [rendererFallbackReason, setRendererFallbackReason] = useState<string | null>(null)
  const [menuPhase, setMenuPhase] = useState<MenuPhase>('preplay')
  const [mountainDebug, setMountainDebug] = useState(getMountainDebug)
  const [lakeDebug, setLakeDebug] = useState(getLakeDebug)
  const [treeDebug, setTreeDebug] = useState(getTreeDebug)
  const [terrainTessellationDebug, setTerrainTessellationDebug] = useState(
    getTerrainTessellationDebug,
  )
  const [dayNightDebugMode, setDayNightDebugMode] = useState<DayNightDebugMode>(
    getDayNightDebugMode,
  )
  const environmentRef = useRef<Environment | null>(environment)
  const debugFlagsRef = useRef({
    mountainOutline: mountainDebug,
    lakeCollider: lakeDebug,
    treeCollider: treeDebug,
    terrainTessellation: terrainTessellationDebug,
  })
  const dayNightDebugModeRef = useRef<DayNightDebugMode>(dayNightDebugMode)
  const playerIdRef = useRef<string | null>(playerId)
  const playerNameRef = useRef(playerName)
  const isPlaying = menuPhase === 'playing'

  const localPlayer = useMemo(() => {
    return gameState?.players.find((player) => player.id === playerId) ?? null
  }, [gameState, playerId])

  const score = localPlayer?.score ?? 0
  const playersOnline = gameState?.totalPlayers ?? 0
  useEffect(() => {
    if (menuPhase !== 'preplay') return
    if (!localPlayer || !localPlayer.alive || localPlayer.snake.length === 0) return
    cameraBlendRef.current = 1
    cameraBlendStartMsRef.current = null
    setMenuPhase('playing')
  }, [localPlayer, menuPhase])

  const rendererStatus = useMemo(() => {
    if (!activeRenderer) return 'Renderer: Initializing...'
    if (rendererFallbackReason) {
      return `Renderer: ${activeRenderer.toUpperCase()} (WebGPU fallback)`
    }
    return `Renderer: ${activeRenderer.toUpperCase()}`
  }, [activeRenderer, rendererFallbackReason])

  const resetBoostFx = () => {
    const state = boostFxStateRef.current
    state.intensity = 0
    state.pulse = 0
    state.lastFrameMs = 0
    state.activeClassApplied = false
    const boostFx = boostFxRef.current
    if (!boostFx) return
    boostFx.classList.remove('boost-fx--active')
    boostFx.style.setProperty('--boost-intensity', '0')
    boostFx.style.setProperty('--boost-pulse', '0')
    boostFx.style.setProperty('--boost-edge-opacity', '0')
    boostFx.style.setProperty('--boost-phase', '0')
  }

  const updateBoostFx = (boostActive: boolean) => {
    const boostFx = boostFxRef.current
    if (!boostFx) return
    const state = boostFxStateRef.current
    const now = performance.now()
    const deltaSeconds =
      state.lastFrameMs > 0 ? Math.min(0.1, Math.max(0, (now - state.lastFrameMs) / 1000)) : 0
    state.lastFrameMs = now

    const target = boostActive ? 1 : 0
    const rate = target >= state.intensity ? BOOST_EFFECT_FADE_IN_RATE : BOOST_EFFECT_FADE_OUT_RATE
    const alpha = 1 - Math.exp(-rate * deltaSeconds)
    state.intensity += (target - state.intensity) * alpha
    if (Math.abs(target - state.intensity) < 1e-4) {
      state.intensity = target
    }

    if (boostActive) {
      state.pulse = (state.pulse + deltaSeconds * BOOST_EFFECT_PULSE_SPEED) % (Math.PI * 2)
    }
    const pulseAmount = state.intensity * (Math.sin(state.pulse) * 0.5 + 0.5)
    const phaseTurn = state.pulse / (Math.PI * 2)
    const edgeOpacity = clamp(0.1 + state.intensity * 0.45 + pulseAmount * 0.18, 0, 1)

    boostFx.style.setProperty('--boost-intensity', state.intensity.toFixed(4))
    boostFx.style.setProperty('--boost-pulse', pulseAmount.toFixed(4))
    boostFx.style.setProperty('--boost-edge-opacity', edgeOpacity.toFixed(4))
    boostFx.style.setProperty('--boost-phase', phaseTurn.toFixed(4))

    const shouldApplyActive = state.intensity > BOOST_EFFECT_ACTIVE_CLASS_THRESHOLD
    if (shouldApplyActive !== state.activeClassApplied) {
      boostFx.classList.toggle('boost-fx--active', shouldApplyActive)
      state.activeClassApplied = shouldApplyActive
    }
  }

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
    menuPhaseRef.current = menuPhase
    inputEnabledRef.current = menuPhase === 'playing'
    if (menuPhase !== 'playing') {
      pointerRef.current.active = false
      pointerRef.current.boost = false
    }
  }, [menuPhase])

  useEffect(() => {
    const webgl = webglRef.current
    environmentRef.current = environment
    if (webgl && environment) {
      webgl.setEnvironment?.(environment)
    }
  }, [environment])

  useEffect(() => {
    try {
      window.localStorage.setItem(MOUNTAIN_DEBUG_KEY, mountainDebug ? '1' : '0')
      window.localStorage.setItem(LAKE_DEBUG_KEY, lakeDebug ? '1' : '0')
      window.localStorage.setItem(TREE_DEBUG_KEY, treeDebug ? '1' : '0')
      window.localStorage.setItem(
        TERRAIN_WIREFRAME_DEBUG_KEY,
        terrainTessellationDebug ? '1' : '0',
      )
    } catch {
      // ignore persistence errors
    }
    debugFlagsRef.current = {
      mountainOutline: mountainDebug,
      lakeCollider: lakeDebug,
      treeCollider: treeDebug,
      terrainTessellation: terrainTessellationDebug,
    }
    const webgl = webglRef.current
    webgl?.setDebugFlags?.(debugFlagsRef.current)
  }, [mountainDebug, lakeDebug, treeDebug, terrainTessellationDebug])

  useEffect(() => {
    try {
      window.localStorage.setItem(DAY_NIGHT_DEBUG_MODE_KEY, dayNightDebugMode)
    } catch {
      // ignore persistence errors
    }
    dayNightDebugModeRef.current = dayNightDebugMode
    webglRef.current?.setDayNightDebugMode?.(dayNightDebugModeRef.current)
  }, [dayNightDebugMode])

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
    storeRendererPreference(rendererPreference)
    const url = new URL(window.location.href)
    url.searchParams.set('renderer', rendererPreference)
    window.history.replaceState({}, '', url)
  }, [rendererPreference])

  useEffect(() => {
    const glCanvas = glCanvasRef.current
    const hudCanvas = hudCanvasRef.current
    if (!glCanvas || !hudCanvas) return
    const hudCtx = hudCanvas.getContext('2d')
    if (!hudCtx) return
    setActiveRenderer(null)
    setRendererFallbackReason(null)

    let disposed = false
    let webgl: RenderScene | null = null
    let observer: ResizeObserver | null = null
    let updateConfig: (() => void) | null = null
    let frameId = 0

    const setupScene = async () => {
      try {
        resetBoostFx()
        const created = await createRenderScene(glCanvas, rendererPreference)
        if (disposed) {
          created.scene.dispose()
          return
        }
        webgl = created.scene
        webglRef.current = webgl
        setActiveRenderer(created.activeBackend)
        setRendererFallbackReason(created.fallbackReason)

        if (environmentRef.current) {
          webgl.setEnvironment?.(environmentRef.current)
        }
        webgl.setDebugFlags?.(debugFlagsRef.current)
        webgl.setDayNightDebugMode?.(dayNightDebugModeRef.current)

        const handleResize = () => {
          const rect = glCanvas.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          webgl?.resize(rect.width, rect.height, dpr)
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
        updateConfig = handleResize

        handleResize()
        observer = new ResizeObserver(handleResize)
        observer.observe(glCanvas)
        window.addEventListener('resize', handleResize)
        glCanvas.addEventListener('wheel', handleWheel, { passive: false })

        const renderLoop = () => {
          const config = renderConfigRef.current
          let boostActive = false
          if (config && webgl) {
            const snapshot = getRenderSnapshot()
            const localId = playerIdRef.current
            const localSnapshotPlayer =
              snapshot?.players.find((player) => player.id === localId) ?? null
            const localHead = localSnapshotPlayer?.snake[0] ?? null
            const hasSpawnedSnake =
              !!localSnapshotPlayer && localSnapshotPlayer.alive && localSnapshotPlayer.snake.length > 0
            const gameplayCamera = updateCamera(localHead, cameraUpRef)
            const phase = menuPhaseRef.current
            const nowMs = performance.now()

            let blend = cameraBlendRef.current
            if (phase === 'preplay') {
              blend = 0
              cameraBlendStartMsRef.current = null
            } else if (hasSpawnedSnake && gameplayCamera.active) {
              if (cameraBlendStartMsRef.current === null) {
                cameraBlendStartMsRef.current = nowMs
              }
              const elapsed = nowMs - cameraBlendStartMsRef.current
              blend = clamp(elapsed / MENU_TO_GAMEPLAY_BLEND_MS, 0, 1)
            } else {
              blend = 0
              cameraBlendStartMsRef.current = null
            }
            cameraBlendRef.current = blend
            const easedBlend = easeInOutCubic(blend)

            let renderCamera = MENU_CAMERA
            let renderDistance = MENU_CAMERA_DISTANCE
            let renderVerticalOffset = MENU_CAMERA_VERTICAL_OFFSET
            if (phase === 'playing') {
              renderCamera = gameplayCamera.active ? gameplayCamera : MENU_CAMERA
              renderDistance = cameraDistanceRef.current
              renderVerticalOffset = 0
              cameraBlendRef.current = 1
            } else if (phase === 'spawning' && gameplayCamera.active) {
              renderCamera = {
                active: true,
                q: slerpQuaternion(MENU_CAMERA.q, gameplayCamera.q, easedBlend),
              }
              renderDistance =
                MENU_CAMERA_DISTANCE + (cameraDistanceRef.current - MENU_CAMERA_DISTANCE) * easedBlend
              renderVerticalOffset = MENU_CAMERA_VERTICAL_OFFSET * (1 - easedBlend)
              if (blend >= 0.999 && hasSpawnedSnake) {
                setMenuPhase('playing')
              }
            }

            cameraRef.current = renderCamera
            renderCameraDistanceRef.current = renderDistance
            renderCameraVerticalOffsetRef.current = renderVerticalOffset
            localHeadRef.current = hasSpawnedSnake && localHead ? normalize(localHead) : MENU_CAMERA_TARGET
            boostActive =
              inputEnabledRef.current &&
              !!localSnapshotPlayer &&
              localSnapshotPlayer.alive &&
              localSnapshotPlayer.isBoosting

            const headScreen = webgl.render(
              snapshot,
              renderCamera,
              localId,
              renderDistance,
              renderVerticalOffset,
            )
            headScreenRef.current = headScreen

            if (inputEnabledRef.current) {
              const oxygenPct = localSnapshotPlayer
                ? clamp(localSnapshotPlayer.oxygen, 0, 1) * 100
                : null
              const scoreRadialState = scoreRadialStateRef.current
              const scoreRadialActive =
                !!localSnapshotPlayer && localSnapshotPlayer.alive && localSnapshotPlayer.isBoosting
              const scoreRadialTargetOpacity = scoreRadialActive ? 1 : 0
              const scoreRadialDeltaSeconds =
                scoreRadialState.lastFrameMs > 0
                  ? Math.min(0.1, Math.max(0, (nowMs - scoreRadialState.lastFrameMs) / 1000))
                  : 0
              scoreRadialState.lastFrameMs = nowMs
              const scoreRadialRate =
                scoreRadialTargetOpacity >= scoreRadialState.opacity
                  ? SCORE_RADIAL_FADE_IN_RATE
                  : SCORE_RADIAL_FADE_OUT_RATE
              const scoreRadialAlpha = 1 - Math.exp(-scoreRadialRate * scoreRadialDeltaSeconds)
              scoreRadialState.opacity +=
                (scoreRadialTargetOpacity - scoreRadialState.opacity) * scoreRadialAlpha
              if (Math.abs(scoreRadialTargetOpacity - scoreRadialState.opacity) < 1e-4) {
                scoreRadialState.opacity = scoreRadialTargetOpacity
              }
              let scoreIntervalPct: number | null = null
              let scoreDisplay: number | null = null
              if (localSnapshotPlayer) {
                if (scoreRadialActive) {
                  const scoreFraction = clamp(localSnapshotPlayer.scoreFraction, 0, 0.999_999)
                  const rawReserve = Math.max(0, localSnapshotPlayer.score + scoreFraction)
                  if (scoreRadialState.displayReserve === null || !scoreRadialState.lastBoosting) {
                    scoreRadialState.displayReserve = rawReserve
                    scoreRadialState.burstBoostUntilMs = 0
                  } else {
                    let reserveDelta = rawReserve - scoreRadialState.displayReserve
                    if (Math.abs(reserveDelta) > 1e-6) {
                      // Skip full score-interval loops so burst gains animate directly
                      // toward the latest interval state instead of wrapping repeatedly.
                      if (reserveDelta >= 1) {
                        scoreRadialState.displayReserve += Math.floor(reserveDelta)
                        reserveDelta = rawReserve - scoreRadialState.displayReserve
                      } else if (reserveDelta <= -1) {
                        scoreRadialState.displayReserve += Math.ceil(reserveDelta)
                        reserveDelta = rawReserve - scoreRadialState.displayReserve
                      }
                      if (reserveDelta >= SCORE_RADIAL_RESERVE_BURST_DELTA_THRESHOLD) {
                        scoreRadialState.burstBoostUntilMs =
                          nowMs + SCORE_RADIAL_RESERVE_BURST_DURATION_MS
                      }
                      const burstActive =
                        reserveDelta > 0 && nowMs < scoreRadialState.burstBoostUntilMs
                      const smoothRate =
                        reserveDelta >= 0
                          ? burstActive
                            ? SCORE_RADIAL_RESERVE_BURST_UP_RATE
                            : SCORE_RADIAL_RESERVE_SMOOTH_UP_RATE
                          : SCORE_RADIAL_RESERVE_SMOOTH_DOWN_RATE
                      const smoothAlpha = 1 - Math.exp(-smoothRate * scoreRadialDeltaSeconds)
                      let smoothedReserve =
                        scoreRadialState.displayReserve + reserveDelta * smoothAlpha
                      const maxSpeed =
                        reserveDelta >= 0
                          ? burstActive
                            ? SCORE_RADIAL_RESERVE_BURST_MAX_UP_SPEED
                            : SCORE_RADIAL_RESERVE_MAX_UP_SPEED
                          : SCORE_RADIAL_RESERVE_MAX_DOWN_SPEED
                      const maxStep = maxSpeed * scoreRadialDeltaSeconds
                      const smoothStep = smoothedReserve - scoreRadialState.displayReserve
                      if (maxStep > 0 && Math.abs(smoothStep) > maxStep) {
                        smoothedReserve = scoreRadialState.displayReserve + Math.sign(smoothStep) * maxStep
                      }
                      smoothedReserve =
                        reserveDelta >= 0
                          ? Math.min(smoothedReserve, rawReserve)
                          : Math.max(smoothedReserve, rawReserve)
                      scoreRadialState.displayReserve = Math.max(0, smoothedReserve)
                    }
                  }
                  const displayReserve = Math.max(
                    0,
                    scoreRadialState.displayReserve ?? rawReserve,
                  )
                  const intervalFraction = displayReserve - Math.floor(displayReserve)
                  scoreIntervalPct = clamp(intervalFraction * 100, 0, 99.999)
                  scoreDisplay = localSnapshotPlayer.score
                  scoreRadialState.lastIntervalPct = scoreIntervalPct
                  scoreRadialState.lastDisplayScore = scoreDisplay
                } else {
                  scoreRadialState.displayReserve = null
                  scoreRadialState.burstBoostUntilMs = 0
                  scoreIntervalPct = scoreRadialState.lastIntervalPct
                  scoreDisplay = scoreRadialState.lastDisplayScore
                }
                scoreRadialState.lastBoosting = scoreRadialActive
              } else {
                scoreRadialState.displayReserve = null
                scoreRadialState.burstBoostUntilMs = 0
                scoreIntervalPct = scoreRadialState.lastIntervalPct
                scoreDisplay = scoreRadialState.lastDisplayScore
                scoreRadialState.lastBoosting = false
              }
              drawHud(
                hudCtx,
                config,
                pointerRef.current.active ? pointerRef.current.angle : null,
                headScreen,
                pointerRef.current.active ? pointerRef.current.distance : null,
                pointerRef.current.active ? pointerRef.current.maxRange : null,
                {
                  pct: oxygenPct,
                  low: oxygenPct !== null && oxygenPct <= 35,
                  anchor: headScreen,
                },
                {
                  active: scoreRadialState.opacity > 0.001,
                  score: scoreDisplay,
                  intervalPct: scoreIntervalPct,
                  opacity: scoreRadialState.opacity,
                  anchor: headScreen,
                },
              )
            } else {
              hudCtx.clearRect(0, 0, config.width, config.height)
            }

            menuDebugInfoRef.current = {
              phase,
              hasSpawned: hasSpawnedSnake,
              cameraBlend: phase === 'playing' ? 1 : blend,
              cameraDistance: Math.hypot(renderDistance, renderVerticalOffset),
            }
            if (DEBUG_UI_ENABLED && typeof window !== 'undefined') {
              const debugApi = (
                window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }
              ).__SNAKE_DEBUG__
              if (debugApi && typeof debugApi === 'object') {
                ;(debugApi as { getMenuFlowInfo?: () => MenuFlowDebugInfo }).getMenuFlowInfo = () => ({
                  ...menuDebugInfoRef.current,
                })
              }
            }
          }
          updateBoostFx(boostActive)
          frameId = window.requestAnimationFrame(renderLoop)
        }

        renderLoop()
      } catch (error) {
        if (disposed) return
        setActiveRenderer(null)
        setRendererFallbackReason(formatRendererError(error))
      }
    }

    void setupScene()

    return () => {
      disposed = true
      observer?.disconnect()
      if (updateConfig) {
        window.removeEventListener('resize', updateConfig)
      }
      glCanvas.removeEventListener('wheel', handleWheel)
      window.cancelAnimationFrame(frameId)
      webgl?.dispose()
      webglRef.current = null
      renderConfigRef.current = null
      headScreenRef.current = null
      resetBoostFx()
    }
    // Renderer swaps are intentionally triggered by explicit backend preference only.
  }, [rendererPreference])

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
      scoreRadialStateRef.current.lastBoosting = false
      scoreRadialStateRef.current.displayReserve = null
      scoreRadialStateRef.current.burstBoostUntilMs = 0
      scoreRadialStateRef.current.lastIntervalPct = 100
      scoreRadialStateRef.current.lastDisplayScore = 0
      scoreRadialStateRef.current.opacity = 0
      scoreRadialStateRef.current.lastFrameMs = 0
      localHeadRef.current = MENU_CAMERA_TARGET
      renderCameraDistanceRef.current = MENU_CAMERA_DISTANCE
      renderCameraVerticalOffsetRef.current = MENU_CAMERA_VERTICAL_OFFSET
      cameraBlendRef.current = 0
      cameraBlendStartMsRef.current = null
      pointerRef.current.active = false
      pointerRef.current.boost = false
      setConnectionStatus('Connecting')
      setGameState(null)
      setEnvironment(null)
      setMenuPhase('preplay')

      socket.addEventListener('open', () => {
        setConnectionStatus('Connected')
        sendJoin(socket, true)
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
      if (event.code === 'Space' && inputEnabledRef.current) {
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
    if (!inputEnabledRef.current) {
      pointerRef.current.active = false
      return
    }
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
      const axis = inputEnabledRef.current && pointerRef.current.active
        ? axisFromPointer(pointerRef.current.angle, cameraRef.current)
        : null
      const config = renderConfigRef.current
      const aspect = config && config.height > 0 ? config.width / config.height : 1
      const cameraDistance = renderCameraDistanceRef.current
      const cameraVerticalOffset = renderCameraVerticalOffsetRef.current
      const effectiveCameraDistance = Math.hypot(cameraDistance, cameraVerticalOffset)
      const viewRadius = computeViewRadius(effectiveCameraDistance, aspect)
      socket.send(
        encodeInput(
          axis,
          inputEnabledRef.current && pointerRef.current.boost,
          localHeadRef.current,
          viewRadius,
          effectiveCameraDistance,
        ),
      )
    }, 50)
  }

  const sendJoin = (socket: WebSocket, deferSpawn = menuPhaseRef.current !== 'playing') => {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(encodeJoin(playerNameRef.current, playerIdRef.current, deferSpawn))
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    updatePointer(event)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    updatePointer(event)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handlePointerLeave = () => {
    pointerRef.current.active = false
    pointerRef.current.screenX = Number.NaN
    pointerRef.current.screenY = Number.NaN
  }

  const handleWheel = (event: WheelEvent) => {
    if (!inputEnabledRef.current) return
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
    setMenuPhase('playing')
    socket.send(encodeRespawn())
  }

  const handleJoinRoom = () => {
    const nextRoom = sanitizeRoomName(roomInput)
    setRoomInput(nextRoom)
    if (nextRoom !== roomName) {
      setRoomName(nextRoom)
      setMenuPhase('preplay')
    } else if (socketRef.current) {
      sendJoin(socketRef.current, menuPhaseRef.current !== 'playing')
    }
  }

  const handlePlay = () => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return

    const trimmedName = playerName.trim()
    const nextName = trimmedName || createRandomPlayerName()
    if (nextName !== playerName) {
      setPlayerName(nextName)
    }
    playerNameRef.current = nextName

    pointerRef.current.active = false
    pointerRef.current.boost = false
    localHeadRef.current = MENU_CAMERA_TARGET
    cameraBlendRef.current = 0
    cameraBlendStartMsRef.current = null
    setMenuPhase('spawning')

    sendJoin(socket, true)
    socket.send(encodeRespawn())
  }

  const handleRendererModeChange = (value: string) => {
    const mode: RendererPreference =
      value === 'webgl' || value === 'webgpu' || value === 'auto' ? value : 'auto'
    if (mode === rendererPreference) return
    storeRendererPreference(mode)
    const url = new URL(window.location.href)
    url.searchParams.set('renderer', mode)
    window.location.replace(url.toString())
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
    <div className={`app ${isPlaying ? 'app--playing' : 'app--menu'}`}>
      <div className='game-card'>
        {isPlaying && (
          <div className='scorebar'>
            <div className='score'>Score: {score}</div>
            <div className='status'>
              Room {roomName} · {connectionStatus} · {playersOnline} online
            </div>
          </div>
        )}

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
            <div ref={boostFxRef} className='boost-fx' aria-hidden='true' />
          </div>
          {!isPlaying && (
            <div className='menu-overlay'>
              <div className='menu-hero'>
                <div className='menu-title menu-title--logo-o' aria-label='Slither World'>
                  <span>Slither W</span>
                  <img
                    src='/images/menu-snake-logo.png'
                    alt=''
                    aria-hidden='true'
                    className='menu-title-o-logo'
                    loading='lazy'
                    decoding='async'
                  />
                  <span>rld</span>
                </div>

                <div className='menu-input-row'>
                  <input
                    id='player-name'
                    value={playerName}
                    onChange={(event) => setPlayerName(event.target.value)}
                    placeholder='Leave blank for random'
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handlePlay()
                      }
                    }}
                  />
                </div>

                <button
                  type='button'
                  className='menu-play-button'
                  disabled={connectionStatus !== 'Connected' || menuPhase === 'spawning'}
                  onClick={handlePlay}
                >
                  Play
                </button>
              </div>
            </div>
          )}
          {isPlaying && localPlayer && !localPlayer.alive && (
            <div className='overlay'>
              <div className='overlay-title'>Good game!</div>
              <div className='overlay-subtitle'>Your trail is still glowing.</div>
              <button type='button' onClick={requestRespawn}>
                Play again
              </button>
            </div>
          )}
        </div>

        {isPlaying && (
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
                onBlur={() => socketRef.current && sendJoin(socketRef.current, false)}
              />
              <button type='button' onClick={() => socketRef.current && sendJoin(socketRef.current, false)}>
                Update
              </button>
            </div>
            <div className='control-row'>
              <label className='control-label' htmlFor='renderer-mode'>
                Renderer
              </label>
              <select
                id='renderer-mode'
                value={rendererPreference}
                onChange={(event) => handleRendererModeChange(event.target.value)}
              >
                <option value='auto'>Auto</option>
                <option value='webgpu'>WebGPU</option>
                <option value='webgl'>WebGL</option>
              </select>
            </div>
            <div className='renderer-status' aria-live='polite'>
              <div>{rendererStatus}</div>
              {rendererFallbackReason && <div className='renderer-fallback'>{rendererFallbackReason}</div>}
            </div>
            {DEBUG_UI_ENABLED && (
              <div className='control-row debug-controls'>
                <label className='control-label'>Debug</label>
                <div className='debug-options' role='group' aria-label='Debug toggles'>
                  <label className='debug-option'>
                    <input
                      type='checkbox'
                      checked={mountainDebug}
                      onChange={(event) => setMountainDebug(event.target.checked)}
                    />
                    Mountain outlines
                  </label>
                  <label className='debug-option'>
                    <input
                      type='checkbox'
                      checked={lakeDebug}
                      onChange={(event) => setLakeDebug(event.target.checked)}
                    />
                    Lake collider
                  </label>
                  <label className='debug-option'>
                    <input
                      type='checkbox'
                      checked={treeDebug}
                      onChange={(event) => setTreeDebug(event.target.checked)}
                    />
                    Cactus colliders
                  </label>
                  <label className='debug-option'>
                    <input
                      type='checkbox'
                      checked={terrainTessellationDebug}
                      onChange={(event) => setTerrainTessellationDebug(event.target.checked)}
                    />
                    Terrain wireframe
                  </label>
                  <div className='debug-option debug-option--select'>
                    <label htmlFor='day-night-mode'>Cycle speed</label>
                    <select
                      id='day-night-mode'
                      className='debug-select'
                      value={dayNightDebugMode}
                      onChange={(event) =>
                        setDayNightDebugMode(event.target.value as DayNightDebugMode)
                      }
                    >
                      <option value='auto'>Normal (8 min)</option>
                      <option value='accelerated'>Accelerated (30s)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {isPlaying && (
          <div className='info-panel'>
            <div className='info-line'>Point to steer. Scroll to zoom. Press space to boost.</div>
            <div className='info-line'>Best this run: {bestScore}</div>
          </div>
        )}
      </div>

      {isPlaying && (
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
      )}
    </div>
  )
}
