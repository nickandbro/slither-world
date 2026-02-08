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
import { IDENTITY_QUAT, clamp, normalize } from './game/math'
import { buildInterpolatedSnapshot, type TimedSnapshot } from './game/snapshots'
import { drawHud, type RenderConfig } from './game/hud'
import {
  createRandomPlayerName,
  DEFAULT_ROOM,
  getInitialName,
  getStoredPlayerId,
  getInitialRendererPreference,
  sanitizeRoomName,
  storePlayerId,
  storePlayerName,
  storeRoomName,
  storeRendererPreference,
} from './game/storage'
import { decodeServerMessage, encodeInput, encodeJoin, encodeRespawn, type PlayerMeta } from './game/wsProtocol'
import { resolveWebSocketUrl } from './services/backend'
import {
  CAMERA_DISTANCE_DEFAULT,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_ZOOM_SENSITIVITY,
  DEATH_TO_MENU_DELAY_MS,
  MAX_EXTRAPOLATION_MS,
  MAX_SNAPSHOT_BUFFER,
  MENU_CAMERA_DISTANCE,
  MENU_CAMERA_VERTICAL_OFFSET,
  MENU_TO_GAMEPLAY_BLEND_MS,
  MIN_INTERP_DELAY_MS,
  OFFSET_SMOOTHING,
  POINTER_MAX_RANGE_RATIO,
  REALTIME_LEADERBOARD_LIMIT,
  SCORE_RADIAL_BLOCKED_FLASH_MS,
  SCORE_RADIAL_FADE_IN_RATE,
  SCORE_RADIAL_FADE_OUT_RATE,
  SCORE_RADIAL_INTERVAL_SMOOTH_RATE,
  SCORE_RADIAL_MIN_CAP_RESERVE,
} from './app/core/constants'
import {
  DEBUG_UI_ENABLED,
  getDayNightDebugMode,
  getLakeDebug,
  getMountainDebug,
  getTerrainTessellationDebug,
  getTreeDebug,
  persistDayNightDebugMode,
  persistDebugSettings,
} from './app/core/debugSettings'
import { computeViewRadius, formatRendererError } from './app/core/renderMath'
import {
  MENU_CAMERA,
  MENU_CAMERA_TARGET,
  easeInOutCubic,
  slerpQuaternion,
  type MenuFlowDebugInfo,
  type MenuPhase,
} from './app/core/menuCamera'
import { createInitialBoostFxState, resetBoostFx, updateBoostFx } from './app/core/boostFx'
import {
  createInitialScoreRadialState,
  resetScoreRadialState,
  type ScoreRadialVisualState,
} from './app/core/scoreRadial'
import { ControlPanel } from './app/components/ControlPanel'
import { MenuOverlay } from './app/components/MenuOverlay'
import { RealtimeLeaderboard, type RealtimeLeaderboardEntry } from './app/components/RealtimeLeaderboard'

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
  const returnBlendStartMsRef = useRef<number | null>(null)
  const returnFromCameraQRef = useRef<Camera['q']>({ ...MENU_CAMERA.q })
  const returnFromDistanceRef = useRef(MENU_CAMERA_DISTANCE)
  const returnFromVerticalOffsetRef = useRef(0)
  const localLifeSpawnedRef = useRef(false)
  const deathStartedAtMsRef = useRef<number | null>(null)
  const returnToMenuCommittedRef = useRef(false)
  const allowPreplayAutoResumeRef = useRef(true)
  const hasSpawnedOnceRef = useRef(false)
  const menuDebugInfoRef = useRef<MenuFlowDebugInfo>({
    phase: 'preplay',
    hasSpawned: false,
    cameraBlend: 0,
    cameraDistance: Math.hypot(MENU_CAMERA_DISTANCE, MENU_CAMERA_VERTICAL_OFFSET),
  })
  const boostFxStateRef = useRef(createInitialBoostFxState())
  const scoreRadialStateRef = useRef<ScoreRadialVisualState>(createInitialScoreRadialState())

  const [gameState, setGameState] = useState<GameStateSnapshot | null>(null)
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(getStoredPlayerId())
  const [playerName, setPlayerName] = useState(getInitialName)
  const [roomName, setRoomName] = useState(DEFAULT_ROOM)
  const [roomInput, setRoomInput] = useState(DEFAULT_ROOM)
  const [rendererPreference] = useState<RendererPreference>(getInitialRendererPreference)
  const [connectionStatus, setConnectionStatus] = useState('Connecting')
  const [activeRenderer, setActiveRenderer] = useState<RendererBackend | null>(null)
  const [rendererFallbackReason, setRendererFallbackReason] = useState<string | null>(null)
  const [menuPhase, setMenuPhase] = useState<MenuPhase>('preplay')
  const [hasSpawnedOnce, setHasSpawnedOnce] = useState(false)
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
  const showMenuOverlay = menuPhase === 'preplay' || menuPhase === 'spawning'

  const localPlayer = useMemo(() => {
    return gameState?.players.find((player) => player.id === playerId) ?? null
  }, [gameState, playerId])

  const score = localPlayer?.score ?? 0
  const playersOnline = gameState?.totalPlayers ?? 0
  const realtimeLeaderboard = useMemo<RealtimeLeaderboardEntry[]>(() => {
    const players = gameState?.players ?? []
    return players
      .filter((player) => player.alive)
      .map((player) => ({
        id: player.id,
        name: player.name.trim() || 'Unknown',
        score: player.score,
        liveScore: player.score + clamp(player.scoreFraction, 0, 0.999_999),
      }))
      .sort((a, b) => {
        const liveScoreDelta = b.liveScore - a.liveScore
        if (Math.abs(liveScoreDelta) > 1e-5) return liveScoreDelta

        const scoreDelta = b.score - a.score
        if (scoreDelta !== 0) return scoreDelta

        const nameDelta = a.name.localeCompare(b.name)
        if (nameDelta !== 0) return nameDelta

        return a.id.localeCompare(b.id)
      })
      .slice(0, REALTIME_LEADERBOARD_LIMIT)
  }, [gameState])
  const localRealtimeRank = useMemo(() => {
    if (!playerId) return null
    const rankIndex = realtimeLeaderboard.findIndex((entry) => entry.id === playerId)
    return rankIndex >= 0 ? rankIndex + 1 : null
  }, [playerId, realtimeLeaderboard])

  useEffect(() => {
    if (menuPhase !== 'preplay') return
    if (!allowPreplayAutoResumeRef.current) return
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

  const resetBoostFxVisual = () => {
    resetBoostFx(boostFxRef.current, boostFxStateRef.current)
  }

  const updateBoostFxVisual = (boostActive: boolean) => {
    updateBoostFx(boostFxRef.current, boostFxStateRef.current, boostActive)
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
    if (menuPhase === 'preplay' && !allowPreplayAutoResumeRef.current) {
      const socket = socketRef.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(encodeJoin(playerNameRef.current, playerIdRef.current, true))
      }
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
    persistDebugSettings({
      mountainDebug,
      lakeDebug,
      treeDebug,
      terrainTessellationDebug,
    })
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
    persistDayNightDebugMode(dayNightDebugMode)
    dayNightDebugModeRef.current = dayNightDebugMode
    webglRef.current?.setDayNightDebugMode?.(dayNightDebugModeRef.current)
  }, [dayNightDebugMode])

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
        resetBoostFxVisual()
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

            if (hasSpawnedSnake) {
              deathStartedAtMsRef.current = null
              if (!localLifeSpawnedRef.current) {
                localLifeSpawnedRef.current = true
                if (!hasSpawnedOnceRef.current) {
                  hasSpawnedOnceRef.current = true
                  setHasSpawnedOnce(true)
                }
              }
            } else if (localLifeSpawnedRef.current && deathStartedAtMsRef.current === null) {
              deathStartedAtMsRef.current = nowMs
              pointerRef.current.active = false
              pointerRef.current.boost = false
            }

            if (
              phase === 'playing' &&
              localLifeSpawnedRef.current &&
              deathStartedAtMsRef.current !== null &&
              nowMs - deathStartedAtMsRef.current >= DEATH_TO_MENU_DELAY_MS
            ) {
              const sourceCameraQ = gameplayCamera.active ? gameplayCamera.q : cameraRef.current.q
              returnFromCameraQRef.current = { ...sourceCameraQ }
              returnFromDistanceRef.current = renderCameraDistanceRef.current
              returnFromVerticalOffsetRef.current = renderCameraVerticalOffsetRef.current
              returnBlendStartMsRef.current = nowMs
              returnToMenuCommittedRef.current = false
              localLifeSpawnedRef.current = false
              deathStartedAtMsRef.current = null
              const socket = socketRef.current
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(encodeJoin(playerNameRef.current, playerIdRef.current, true))
              }
              setMenuPhase('returning')
            }

            let blend = cameraBlendRef.current
            if (phase === 'preplay') {
              blend = 0
              cameraBlendStartMsRef.current = null
              returnBlendStartMsRef.current = null
            } else if (phase === 'spawning') {
              if (hasSpawnedSnake && gameplayCamera.active) {
                if (cameraBlendStartMsRef.current === null) {
                  cameraBlendStartMsRef.current = nowMs
                }
                const elapsed = nowMs - cameraBlendStartMsRef.current
                blend = clamp(elapsed / MENU_TO_GAMEPLAY_BLEND_MS, 0, 1)
              } else {
                blend = 0
                cameraBlendStartMsRef.current = null
              }
              returnBlendStartMsRef.current = null
            } else if (phase === 'returning') {
              if (returnBlendStartMsRef.current === null) {
                returnBlendStartMsRef.current = nowMs
              }
              const elapsed = nowMs - returnBlendStartMsRef.current
              blend = clamp(elapsed / MENU_TO_GAMEPLAY_BLEND_MS, 0, 1)
              cameraBlendStartMsRef.current = null
            } else {
              blend = 1
              cameraBlendStartMsRef.current = null
              returnBlendStartMsRef.current = null
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
            } else if (phase === 'returning') {
              renderCamera = {
                active: true,
                q: slerpQuaternion(returnFromCameraQRef.current, MENU_CAMERA.q, easedBlend),
              }
              renderDistance =
                returnFromDistanceRef.current +
                (MENU_CAMERA_DISTANCE - returnFromDistanceRef.current) * easedBlend
              renderVerticalOffset =
                returnFromVerticalOffsetRef.current +
                (MENU_CAMERA_VERTICAL_OFFSET - returnFromVerticalOffsetRef.current) * easedBlend
              if (blend >= 0.999 && !returnToMenuCommittedRef.current) {
                returnToMenuCommittedRef.current = true
                allowPreplayAutoResumeRef.current = false
                const socket = socketRef.current
                if (socket && socket.readyState === WebSocket.OPEN) {
                  socket.send(encodeJoin(playerNameRef.current, playerIdRef.current, true))
                }
                setMenuPhase('preplay')
              }
            }

            cameraRef.current = renderCamera
            renderCameraDistanceRef.current = renderDistance
            renderCameraVerticalOffsetRef.current = renderVerticalOffset
            localHeadRef.current = hasSpawnedSnake && localHead ? normalize(localHead) : MENU_CAMERA_TARGET
            if (!hasSpawnedSnake) {
              pointerRef.current.active = false
              pointerRef.current.boost = false
            }
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
              const scoreRadialDeltaSeconds =
                scoreRadialState.lastFrameMs > 0
                  ? Math.min(0.1, Math.max(0, (nowMs - scoreRadialState.lastFrameMs) / 1000))
                  : 0
              scoreRadialState.lastFrameMs = nowMs
              let scoreIntervalPct: number | null = null
              let scoreDisplay: number | null = null
              let scoreRadialBlocked = false
              if (localSnapshotPlayer) {
                const scoreFraction = clamp(localSnapshotPlayer.scoreFraction, 0, 0.999_999)
                const currentReserve = Math.max(0, localSnapshotPlayer.score + scoreFraction)
                if (localSnapshotPlayer.alive) {
                  if (!scoreRadialState.lastAlive || scoreRadialState.spawnReserve === null) {
                    scoreRadialState.spawnReserve = currentReserve
                    scoreRadialState.spawnScore = Math.max(0, Math.floor(localSnapshotPlayer.score))
                  }
                } else {
                  scoreRadialState.spawnReserve = null
                  scoreRadialState.spawnScore = null
                  scoreRadialState.blockedVisualHold = false
                }
                const spawnScore = Math.max(
                  0,
                  Math.floor(scoreRadialState.spawnScore ?? localSnapshotPlayer.score),
                )
                const minBoostStartScore = spawnScore + 1
                const scoreBlockedByThreshold =
                  localSnapshotPlayer.alive &&
                  !localSnapshotPlayer.isBoosting &&
                  localSnapshotPlayer.score < minBoostStartScore
                const attemptingBoost = pointerRef.current.boost
                if (
                  scoreRadialState.lastBoosting &&
                  !scoreRadialActive &&
                  localSnapshotPlayer.alive &&
                  attemptingBoost
                ) {
                  scoreRadialState.blockedFlashUntilMs = nowMs + SCORE_RADIAL_BLOCKED_FLASH_MS
                }
                if (scoreRadialActive) {
                  scoreRadialState.blockedFlashUntilMs = 0
                  if (!scoreRadialState.lastBoosting || scoreRadialState.capReserve === null) {
                    scoreRadialState.capReserve = Math.max(
                      currentReserve,
                      SCORE_RADIAL_MIN_CAP_RESERVE,
                    )
                  } else if (currentReserve > scoreRadialState.capReserve) {
                    scoreRadialState.capReserve = currentReserve
                  }
                  const capReserve = Math.max(
                    scoreRadialState.capReserve ?? SCORE_RADIAL_MIN_CAP_RESERVE,
                    SCORE_RADIAL_MIN_CAP_RESERVE,
                  )
                  const spawnReserve = clamp(scoreRadialState.spawnReserve ?? currentReserve, 0, capReserve)
                  const spendableReserve = Math.max(
                    capReserve - spawnReserve,
                    SCORE_RADIAL_MIN_CAP_RESERVE,
                  )
                  const spendableCurrent = Math.max(0, currentReserve - spawnReserve)
                  const targetInterval01 = clamp(spendableCurrent / spendableReserve, 0, 1)
                  if (!scoreRadialState.lastBoosting || scoreRadialState.displayInterval01 === null) {
                    scoreRadialState.displayInterval01 = targetInterval01
                  } else {
                    const smoothAlpha =
                      1 - Math.exp(-SCORE_RADIAL_INTERVAL_SMOOTH_RATE * scoreRadialDeltaSeconds)
                    scoreRadialState.displayInterval01 +=
                      (targetInterval01 - scoreRadialState.displayInterval01) * smoothAlpha
                  }
                  const interval01 = clamp(
                    scoreRadialState.displayInterval01 ?? targetInterval01,
                    0,
                    1,
                  )
                  scoreIntervalPct = interval01 * 100
                  scoreDisplay = localSnapshotPlayer.score
                  scoreRadialState.lastIntervalPct = scoreIntervalPct
                  scoreRadialState.lastDisplayScore = scoreDisplay
                } else {
                  scoreRadialState.capReserve = null
                  scoreRadialState.displayInterval01 = null
                  scoreIntervalPct = scoreRadialState.lastIntervalPct
                  scoreDisplay = localSnapshotPlayer.score
                  scoreRadialState.lastDisplayScore = scoreDisplay
                  scoreRadialBlocked =
                    (scoreBlockedByThreshold && attemptingBoost) ||
                    nowMs < scoreRadialState.blockedFlashUntilMs
                }
                scoreRadialState.lastBoosting = scoreRadialActive
                scoreRadialState.lastAlive = localSnapshotPlayer.alive
              } else {
                scoreRadialState.capReserve = null
                scoreRadialState.spawnReserve = null
                scoreRadialState.spawnScore = null
                scoreRadialState.displayInterval01 = null
                scoreRadialState.blockedFlashUntilMs = 0
                scoreRadialState.blockedVisualHold = false
                scoreIntervalPct = scoreRadialState.lastIntervalPct
                scoreDisplay = scoreRadialState.lastDisplayScore
                scoreRadialState.lastBoosting = false
                scoreRadialState.lastAlive = false
              }
              if (scoreRadialBlocked) {
                scoreRadialState.blockedVisualHold = true
              } else if (scoreRadialActive) {
                scoreRadialState.blockedVisualHold = false
              }
              const scoreRadialVisibleTarget = scoreRadialActive || scoreRadialBlocked
              const scoreRadialRenderBlocked =
                scoreRadialBlocked ||
                (!scoreRadialActive &&
                  scoreRadialState.blockedVisualHold &&
                  scoreRadialState.opacity > 0.001)
              const scoreRadialTargetOpacity = scoreRadialVisibleTarget ? 1 : 0
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
              if (!scoreRadialVisibleTarget && scoreRadialState.opacity <= 0.001) {
                scoreRadialState.blockedVisualHold = false
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
                  blocked: scoreRadialRenderBlocked,
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
          updateBoostFxVisual(boostActive)
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
      resetBoostFxVisual()
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
      resetScoreRadialState(scoreRadialStateRef.current)
      localHeadRef.current = MENU_CAMERA_TARGET
      renderCameraDistanceRef.current = MENU_CAMERA_DISTANCE
      renderCameraVerticalOffsetRef.current = MENU_CAMERA_VERTICAL_OFFSET
      cameraBlendRef.current = 0
      cameraBlendStartMsRef.current = null
      returnBlendStartMsRef.current = null
      returnFromCameraQRef.current = { ...MENU_CAMERA.q }
      returnFromDistanceRef.current = MENU_CAMERA_DISTANCE
      returnFromVerticalOffsetRef.current = 0
      localLifeSpawnedRef.current = false
      deathStartedAtMsRef.current = null
      returnToMenuCommittedRef.current = false
      allowPreplayAutoResumeRef.current = true
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
    returnBlendStartMsRef.current = null
    returnFromCameraQRef.current = { ...MENU_CAMERA.q }
    returnFromDistanceRef.current = MENU_CAMERA_DISTANCE
    returnFromVerticalOffsetRef.current = 0
    localLifeSpawnedRef.current = false
    deathStartedAtMsRef.current = null
    returnToMenuCommittedRef.current = false
    allowPreplayAutoResumeRef.current = false
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

  return (
    <div className={`app ${isPlaying ? 'app--playing' : 'app--menu'}`}>
      <div className='game-card'>
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
          {showMenuOverlay && (
            <MenuOverlay
              playerName={playerName}
              playLabel={hasSpawnedOnce ? 'Play again' : 'Play'}
              connectionStatus={connectionStatus}
              menuPhase={menuPhase}
              onPlayerNameChange={setPlayerName}
              onPlay={handlePlay}
            />
          )}
        </div>

        {isPlaying && (
          <ControlPanel
            roomInput={roomInput}
            playerName={playerName}
            rendererPreference={rendererPreference}
            rendererStatus={rendererStatus}
            rendererFallbackReason={rendererFallbackReason}
            debugUiEnabled={DEBUG_UI_ENABLED}
            mountainDebug={mountainDebug}
            lakeDebug={lakeDebug}
            treeDebug={treeDebug}
            terrainTessellationDebug={terrainTessellationDebug}
            dayNightDebugMode={dayNightDebugMode}
            onRoomInputChange={setRoomInput}
            onPlayerNameChange={setPlayerName}
            onJoinRoom={handleJoinRoom}
            onUpdatePlayerName={() => socketRef.current && sendJoin(socketRef.current, false)}
            onRendererModeChange={handleRendererModeChange}
            onMountainDebugChange={setMountainDebug}
            onLakeDebugChange={setLakeDebug}
            onTreeDebugChange={setTreeDebug}
            onTerrainTessellationDebugChange={setTerrainTessellationDebug}
            onDayNightDebugModeChange={setDayNightDebugMode}
          />
        )}

        {isPlaying && (
          <div className='player-stats-card' aria-live='polite'>
            <div className='player-stats-line'>
              <span>Your length: </span>
              <span className='player-stats-value'>{Math.max(0, score)}</span>
            </div>
            <div className='player-stats-line'>
              <span>Your rank: </span>
              <span className='player-stats-value'>
                {localRealtimeRank ?? '-'} of {playersOnline}
              </span>
            </div>
          </div>
        )}
      </div>

      {isPlaying && <RealtimeLeaderboard entries={realtimeLeaderboard} />}
    </div>
  )
}
