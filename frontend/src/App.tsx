import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  createRenderScene,
  type DayNightDebugMode,
  type RenderScene,
  type RendererBackend,
  type RendererPreference,
} from './render/webglScene'
import type { Camera, Environment, GameStateSnapshot, Point } from './game/types'
import { updateCamera } from './game/camera'
import { IDENTITY_QUAT, clamp, lerpPoint, normalize } from './game/math'
import { buildInterpolatedSnapshot, type TimedSnapshot } from './game/snapshots'
import { drawHud, type RenderConfig } from './game/hud'
import {
  createRandomPlayerName,
  getInitialRoom,
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
import {
  DEFAULT_SOLID_SKIN,
  MAX_SAVED_SKIN_DESIGNS,
  SKIN_PALETTE_COLORS,
  SNAKE_PATTERN_LEN,
  createSkinDesign,
  deleteSkinDesign,
  getSavedSkinDesigns,
  getSelectedSkin,
  resolveSelectedSkinColors,
  saveSkinDesign,
  storeSelectedSkin,
  type SelectedSkinV1,
  type SnakeSkinDesignV1,
} from './game/skins'
import { resolveWebSocketUrl } from './services/backend'
import { requestMatchmake } from './services/matchmake'
import {
  CAMERA_DISTANCE_DEFAULT,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_ZOOM_SENSITIVITY,
  DEFAULT_NET_TUNING,
  DEATH_TO_MENU_DELAY_MS,
  MAX_EXTRAPOLATION_MS,
  MAX_SNAPSHOT_BUFFER,
  MENU_CAMERA_DISTANCE,
  MENU_CAMERA_VERTICAL_OFFSET,
  MENU_OVERLAY_FADE_OUT_MS,
  MENU_TO_GAMEPLAY_BLEND_MS,
  MOTION_BACKWARD_DOT_THRESHOLD,
  REALTIME_LEADERBOARD_LIMIT,
  SCORE_RADIAL_BLOCKED_FLASH_MS,
  SCORE_RADIAL_FADE_IN_RATE,
  SCORE_RADIAL_FADE_OUT_RATE,
  SCORE_RADIAL_INTERVAL_SMOOTH_RATE,
  SCORE_RADIAL_MIN_CAP_RESERVE,
  resolveNetTuning,
  type NetTuningOverrides,
} from './app/core/constants'
import {
  DEBUG_UI_ENABLED,
  getNetDebugEnabled,
  getTailDebugEnabled,
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
import { SkinBuilderOverlay } from './app/components/SkinBuilderOverlay'
import { SkinOverlay } from './app/components/SkinOverlay'
import { RealtimeLeaderboard, type RealtimeLeaderboardEntry } from './app/components/RealtimeLeaderboard'

type LagSpikeCause = 'none' | 'stale' | 'seq-gap' | 'arrival-gap'
type MenuUiMode = 'home' | 'skin' | 'builder'

type NetSmoothingDebugInfo = {
  lagSpikeActive: boolean
  lagSpikeCause: LagSpikeCause
  playoutDelayMs: number
  delayBoostMs: number
  jitterDelayMs: number
  jitterMs: number
  receiveIntervalMs: number
  staleMs: number
  impairmentMsRemaining: number
  maxExtrapolationMs: number
  latestSeq: number | null
  seqGapDetected: boolean
  tuningRevision: number
  tuningOverrides: NetTuningOverrides
}

type MotionStabilityDebugInfo = {
  backwardCorrectionCount: number
  minHeadDot: number
  sampleCount: number
}

const LOCAL_STORAGE_ADAPTIVE_QUALITY = 'spherical_snake_adaptive_quality'
const LOCAL_STORAGE_MIN_DPR = 'spherical_snake_min_dpr'
const LOCAL_STORAGE_MAX_DPR = 'spherical_snake_max_dpr'
const LOCAL_STORAGE_WEBGPU_MSAA_SAMPLES = 'spherical_snake_webgpu_msaa_samples'

const readLocalStorage = (key: string) => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const readLocalStorageBool = (key: string, fallback: boolean) => {
  const value = readLocalStorage(key)
  if (value === '1') return true
  if (value === '0') return false
  return fallback
}

const readLocalStorageNumber = (key: string, fallback: number, min: number, max: number) => {
  const value = readLocalStorage(key)
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

type RafPerfFrame = {
  tMs: number
  totalMs: number
  snapshotMs: number
  cameraMs: number
  renderMs: number
  hudMs: number
  debugMs: number
  tailMs: number
}

type RafPerfInfo = {
  enabled: boolean
  thresholdMs: number
  frameCount: number
  slowFrameCount: number
  maxTotalMs: number
  lastFrame: RafPerfFrame | null
  slowFrames: RafPerfFrame[]
  lastSlowLogMs: number
}

type AdaptiveQualityState = {
  enabled: boolean
  minDpr: number
  maxDprCap: number
  currentDpr: number
  ewmaFrameMs: number
  lastAdjustAtMs: number
  webgpuSamples: number
  webgpuLastChangeMs: number
}

type NetLagEvent = {
  id: number
  atIso: string
  tMs: number
  type: 'spike_start' | 'spike_end' | 'seq_gap' | 'snapshot_drop' | 'summary' | 'tuning_update'
  message: string
  lagSpikeActive: boolean
  lagSpikeCause: LagSpikeCause
  playoutDelayMs: number
  delayBoostMs: number
  jitterDelayMs: number
  jitterMs: number
  receiveIntervalMs: number
  staleMs: number
  impairmentMsRemaining: number
  maxExtrapolationMs: number
  latestSeq: number | null
  seqGapDetected: boolean
  tuningRevision: number
  tuningOverrides: NetTuningOverrides
  droppedSeq: number | null
  seqGapSize: number | null
  backwardCorrectionCount: number
  sampleCount: number
  minHeadDot: number
  cameraHoldActive: boolean
}

type NetLagReport = {
  generatedAtIso: string
  net: NetSmoothingDebugInfo
  motion: MotionStabilityDebugInfo
  recentEvents: NetLagEvent[]
}

type TailGrowthEvent = {
  id: number
  atIso: string
  tMs: number
  kind: 'rx' | 'render' | 'shrink' | 'stretch'
  phase: MenuPhase
  seq: number | null
  now: number | null
  localId: string | null
  alive: boolean | null
  isBoosting: boolean | null
  boostInput: boolean | null
  score: number | null
  scoreFraction: number | null
  snakeLen: number | null
  snakeTotalLen: number | null
  tailExtension: number | null
  lenUnits: number | null
  digestions: number | null
  digestionMaxProgress: number | null
  // Tail-end metrics (useful for diagnosing "shrink then pop" reports).
  tailSegLen: number | null
  tailRefLen: number | null
  tailExtRatio: number | null
  tailExtDist: number | null
  tailEndLen: number | null
  // Raw snapshot metrics before the local stabilizer is applied (render-loop only).
  rawSnakeLen: number | null
  rawSnakeTotalLen: number | null
  rawTailExtension: number | null
  rawLenUnits: number | null
  rawTailSegLen: number | null
  rawTailRefLen: number | null
  rawTailExtRatio: number | null
  rawTailExtDist: number | null
  rawTailEndLen: number | null
  // Net context
  lagSpikeActive: boolean
  lagSpikeCause: LagSpikeCause
  playoutDelayMs: number
  delayBoostMs: number
  jitterDelayMs: number
  jitterMs: number
  receiveIntervalMs: number
  staleMs: number
  impairmentMsRemaining: number
  maxExtrapolationMs: number
  latestSeq: number | null
  seqGapDetected: boolean
  tuningRevision: number
}

type TailGrowthReport = {
  generatedAtIso: string
  enabled: boolean
  count: number
  shrinkCount: number
  stretchCount: number
  recentShrinks: TailGrowthEvent[]
  recentStretches: TailGrowthEvent[]
}

type TailEndSample = {
  seq: number | null
  now: number | null
  snakeLen: number | null
  snakeTotalLen: number | null
  tailExtension: number | null
  segLen: number
  refLen: number
  extRatio: number
  extDist: number
  endLen: number
}

type TailGrowthEventInput = Omit<
  TailGrowthEvent,
  | 'id'
  | 'atIso'
  | 'tMs'
  | 'phase'
  | 'lagSpikeActive'
  | 'lagSpikeCause'
  | 'playoutDelayMs'
  | 'delayBoostMs'
  | 'jitterDelayMs'
  | 'jitterMs'
  | 'receiveIntervalMs'
  | 'staleMs'
  | 'impairmentMsRemaining'
  | 'maxExtrapolationMs'
  | 'latestSeq'
  | 'seqGapDetected'
  | 'tuningRevision'
> & {
  tMs?: number
  phase?: MenuPhase
}

const SEQ_HALF_RANGE = 0x8000_0000
const NET_EVENT_LOG_LIMIT = 240
const TAIL_EVENT_LOG_LIMIT = 900
const TAIL_RENDER_SAMPLE_INTERVAL_MS = 140
const ARRIVAL_GAP_REENTRY_COOLDOWN_MS = 480
const SCORE_RADIAL_DEPLETION_EPS = 0.05

const isSeqNewer = (next: number, current: number) => {
  const delta = (next - current) >>> 0
  return delta !== 0 && delta < SEQ_HALF_RANGE
}

const seqGapSize = (next: number, current: number) => {
  const delta = (next - current) >>> 0
  if (delta < SEQ_HALF_RANGE) return delta
  return 0
}

export default function App() {
  const RAF_SLOW_FRAME_THRESHOLD_MS = 50
  const RAF_SLOW_FRAMES_MAX = 24

  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const boostFxRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const webglRef = useRef<RenderScene | null>(null)
  const renderConfigRef = useRef<RenderConfig | null>(null)
  const pointerRef = useRef({
    boost: false,
    active: false,
    screenX: Number.NaN,
    screenY: Number.NaN,
  })
  const boostInputRef = useRef({
    keyboard: false,
    pointerButton: false,
  })
  const sendIntervalRef = useRef<number | null>(null)
  const snapshotBufferRef = useRef<TimedSnapshot[]>([])
  const serverOffsetRef = useRef<number | null>(null)
  const serverTickMsRef = useRef(50)
  const tickIntervalRef = useRef(50)
  const lastSnapshotTimeRef = useRef<number | null>(null)
  const lastSnapshotReceivedAtRef = useRef<number | null>(null)
  const receiveIntervalMsRef = useRef(50)
  const receiveJitterMsRef = useRef(0)
  const receiveJitterDelayMsRef = useRef(0)
  const playoutDelayMsRef = useRef(100)
  const delayBoostMsRef = useRef(0)
  const lastDelayUpdateMsRef = useRef<number | null>(null)
  const latestSeqRef = useRef<number | null>(null)
  const seqGapDetectedRef = useRef(false)
  const lastSeqGapAtMsRef = useRef<number | null>(null)
  const lagSpikeActiveRef = useRef(false)
  const lagSpikeCauseRef = useRef<LagSpikeCause>('none')
  const lagSpikeEnterCandidateAtMsRef = useRef<number | null>(null)
  const lagSpikeExitCandidateAtMsRef = useRef<number | null>(null)
  const lagSpikeArrivalGapCooldownUntilMsRef = useRef(0)
  const lagImpairmentUntilMsRef = useRef(0)
  const netTuningOverridesRef = useRef<NetTuningOverrides>({})
  const netTuningRef = useRef(resolveNetTuning(DEFAULT_NET_TUNING))
  const netTuningRevisionRef = useRef(0)
  const cameraRef = useRef<Camera>({ q: { ...IDENTITY_QUAT }, active: false })
  const cameraUpRef = useRef<Point>({ x: 0, y: 1, z: 0 })
  const stableGameplayCameraRef = useRef<Camera>({ q: { ...MENU_CAMERA.q }, active: true })
  const lagCameraHoldActiveRef = useRef(false)
  const lagCameraHoldQRef = useRef<Camera['q']>({ ...MENU_CAMERA.q })
  const lagCameraRecoveryStartMsRef = useRef<number | null>(null)
  const lagCameraRecoveryFromQRef = useRef<Camera['q']>({ ...MENU_CAMERA.q })
  const cameraDistanceRef = useRef(CAMERA_DISTANCE_DEFAULT)
  const renderCameraDistanceRef = useRef(MENU_CAMERA_DISTANCE)
  const renderCameraVerticalOffsetRef = useRef(MENU_CAMERA_VERTICAL_OFFSET)
  const localHeadRef = useRef<Point | null>(MENU_CAMERA_TARGET)
  const headScreenRef = useRef<{ x: number; y: number } | null>(null)
  const playerMetaRef = useRef<Map<string, PlayerMeta>>(new Map())
  const menuPhaseRef = useRef<MenuPhase>('preplay')
  const menuUiModeRef = useRef<MenuUiMode>('home')
  const menuOverlayExitingRef = useRef(false)
  const joinSkinColorsRef = useRef<string[]>(resolveSelectedSkinColors(getSelectedSkin(), getSavedSkinDesigns()))
  const builderPatternRef = useRef<Array<string | null>>(new Array(SNAKE_PATTERN_LEN).fill(null))
  const builderPaletteColorRef = useRef<string>(SKIN_PALETTE_COLORS[0] ?? '#ffffff')
  const builderPaletteIndexRef = useRef(0)
  const menuPreviewOrbitRef = useRef({ yaw: -0.35, pitch: 0.08 })
  const menuPreviewDragRef = useRef<{
    active: boolean
    pointerId: number | null
    lastX: number
    lastY: number
  }>({ active: false, pointerId: null, lastX: 0, lastY: 0 })
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
  const menuOverlayExitTimerRef = useRef<number | null>(null)
  const menuDebugInfoRef = useRef<MenuFlowDebugInfo>({
    phase: 'preplay',
    hasSpawned: false,
    cameraBlend: 0,
    cameraDistance: Math.hypot(MENU_CAMERA_DISTANCE, MENU_CAMERA_VERTICAL_OFFSET),
  })
  const netDebugInfoRef = useRef<NetSmoothingDebugInfo>({
    lagSpikeActive: false,
    lagSpikeCause: 'none',
    playoutDelayMs: 100,
    delayBoostMs: 0,
    jitterDelayMs: 0,
    jitterMs: 0,
    receiveIntervalMs: 50,
    staleMs: 0,
    impairmentMsRemaining: 0,
    maxExtrapolationMs: MAX_EXTRAPOLATION_MS,
    latestSeq: null,
    seqGapDetected: false,
    tuningRevision: 0,
    tuningOverrides: {},
  })
  const motionDebugInfoRef = useRef<MotionStabilityDebugInfo>({
    backwardCorrectionCount: 0,
    minHeadDot: 1,
    sampleCount: 0,
  })
  const rafPerfRef = useRef<RafPerfInfo>({
    enabled: false,
    thresholdMs: RAF_SLOW_FRAME_THRESHOLD_MS,
    frameCount: 0,
    slowFrameCount: 0,
    maxTotalMs: 0,
    lastFrame: null,
    slowFrames: [],
    lastSlowLogMs: 0,
  })
  const adaptiveQualityRef = useRef<AdaptiveQualityState>({
    // Off by default: dynamic DPR can cause visible resolution shifts/brief flashes; keep it opt-in.
    enabled: readLocalStorageBool(LOCAL_STORAGE_ADAPTIVE_QUALITY, false),
    minDpr: readLocalStorageNumber(LOCAL_STORAGE_MIN_DPR, 1, 1, 2),
    maxDprCap: readLocalStorageNumber(LOCAL_STORAGE_MAX_DPR, 2, 1, 2),
    currentDpr: 0,
    ewmaFrameMs: 16.7,
    lastAdjustAtMs: 0,
    webgpuSamples: readLocalStorageNumber(LOCAL_STORAGE_WEBGPU_MSAA_SAMPLES, 4, 1, 4) >= 2 ? 4 : 1,
    webgpuLastChangeMs: 0,
  })
  const localSnakeDisplayRef = useRef<Point[] | null>(null)
  const lastRenderFrameMsRef = useRef<number | null>(null)
  const netLagEventsRef = useRef<NetLagEvent[]>([])
  const netLagEventIdRef = useRef(1)
  const lastNetSummaryLogMsRef = useRef(0)
  const tailGrowthEventsRef = useRef<TailGrowthEvent[]>([])
  const tailGrowthEventIdRef = useRef(1)
  const lastTailRenderSampleAtMsRef = useRef<number | null>(null)
  const lastTailEndSampleRef = useRef<TailEndSample | null>(null)
  const lastHeadSampleRef = useRef<Point | null>(null)
  const boostFxStateRef = useRef(createInitialBoostFxState())
  const scoreRadialStateRef = useRef<ScoreRadialVisualState>(createInitialScoreRadialState())

  const [gameState, setGameState] = useState<GameStateSnapshot | null>(null)
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(getStoredPlayerId())
  const [playerName, setPlayerName] = useState(getInitialName)
  const [menuUiMode, setMenuUiMode] = useState<MenuUiMode>('home')
  const [skinDesigns, setSkinDesigns] = useState<SnakeSkinDesignV1[]>(getSavedSkinDesigns)
  const [selectedSkin, setSelectedSkin] = useState<SelectedSkinV1>(getSelectedSkin)
  const [solidPaletteIndex, setSolidPaletteIndex] = useState(() => {
    const initial = getSelectedSkin()
    if (initial.kind !== 'solid') return 0
    const idx = SKIN_PALETTE_COLORS.findIndex((c) => c.toLowerCase() === initial.color.toLowerCase())
    return idx >= 0 ? idx : 0
  })
  const [builderPaletteColor, setBuilderPaletteColor] = useState(() => SKIN_PALETTE_COLORS[0] ?? '#ffffff')
  const [builderPattern, setBuilderPattern] = useState<Array<string | null>>(
    () => new Array(SNAKE_PATTERN_LEN).fill(null),
  )
  const [builderDesignName, setBuilderDesignName] = useState('')
  const [roomName, setRoomName] = useState(getInitialRoom)
  const [roomInput, setRoomInput] = useState(getInitialRoom)
  const [rendererPreference] = useState<RendererPreference>(getInitialRendererPreference)
  const [connectionStatus, setConnectionStatus] = useState('Connecting')
  const [activeRenderer, setActiveRenderer] = useState<RendererBackend | null>(null)
  const [rendererFallbackReason, setRendererFallbackReason] = useState<string | null>(null)
  const [menuPhase, setMenuPhase] = useState<MenuPhase>('preplay')
  const [menuOverlayExiting, setMenuOverlayExiting] = useState(false)
  const [showPlayAgain, setShowPlayAgain] = useState(false)
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
  const netDebugEnabled = useMemo(getNetDebugEnabled, [])
  const tailDebugEnabled = useMemo(getTailDebugEnabled, [])
  const isPlaying = menuPhase === 'playing'
  const showMenuOverlay = menuPhase === 'preplay' || menuOverlayExiting
  const solidPaletteColor = SKIN_PALETTE_COLORS[solidPaletteIndex] ?? (SKIN_PALETTE_COLORS[0] ?? '#ffffff')

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const url = new URL(window.location.href)
      const value = url.searchParams.get('rafPerf')
      if (value === '1') {
        rafPerfRef.current.enabled = true
      } else if (value === '0') {
        rafPerfRef.current.enabled = false
      }
    } catch {
      // ignore URL parsing errors
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const debugWindow = window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }
    if (!debugWindow.__SNAKE_DEBUG__ || typeof debugWindow.__SNAKE_DEBUG__ !== 'object') {
      debugWindow.__SNAKE_DEBUG__ = {}
    }
  }, [])

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

  const syncBoostInput = () => {
    pointerRef.current.boost = boostInputRef.current.keyboard || boostInputRef.current.pointerButton
  }

  const setPointerButtonBoostInput = (active: boolean) => {
    boostInputRef.current.pointerButton = active
    syncBoostInput()
  }

  const clearBoostInputs = () => {
    boostInputRef.current.keyboard = false
    boostInputRef.current.pointerButton = false
    pointerRef.current.boost = false
  }

  const resetBoostFxVisual = () => {
    resetBoostFx(boostFxRef.current, boostFxStateRef.current)
  }

  const updateBoostFxVisual = (boostActive: boolean) => {
    updateBoostFx(boostFxRef.current, boostFxStateRef.current, boostActive)
  }

  const appendNetLagEvent = useCallback(
    (
      type: NetLagEvent['type'],
      message: string,
      extras?: Partial<Pick<NetLagEvent, 'droppedSeq' | 'seqGapSize'>>,
    ) => {
      const net = netDebugInfoRef.current
      const motion = motionDebugInfoRef.current
      const entry: NetLagEvent = {
        id: netLagEventIdRef.current,
        atIso: new Date().toISOString(),
        tMs: performance.now(),
        type,
        message,
        lagSpikeActive: net.lagSpikeActive,
        lagSpikeCause: net.lagSpikeCause,
        playoutDelayMs: net.playoutDelayMs,
        delayBoostMs: net.delayBoostMs,
        jitterDelayMs: net.jitterDelayMs,
        jitterMs: net.jitterMs,
        receiveIntervalMs: net.receiveIntervalMs,
        staleMs: net.staleMs,
        impairmentMsRemaining: net.impairmentMsRemaining,
        maxExtrapolationMs: net.maxExtrapolationMs,
        latestSeq: net.latestSeq,
        seqGapDetected: net.seqGapDetected,
        tuningRevision: net.tuningRevision,
        tuningOverrides: { ...net.tuningOverrides },
        droppedSeq: extras?.droppedSeq ?? null,
        seqGapSize: extras?.seqGapSize ?? null,
        backwardCorrectionCount: motion.backwardCorrectionCount,
        sampleCount: motion.sampleCount,
        minHeadDot: motion.minHeadDot,
        cameraHoldActive: lagCameraHoldActiveRef.current,
      }
      netLagEventIdRef.current += 1
      const eventLog = netLagEventsRef.current
      eventLog.push(entry)
      if (eventLog.length > NET_EVENT_LOG_LIMIT) {
        eventLog.splice(0, eventLog.length - NET_EVENT_LOG_LIMIT)
      }
      if (netDebugEnabled) {
        console.info(`[net][event:${entry.type}]`, entry)
      }
    },
    [netDebugEnabled],
  )

  const buildNetLagReport = useCallback((): NetLagReport => {
    return {
      generatedAtIso: new Date().toISOString(),
      net: { ...netDebugInfoRef.current },
      motion: { ...motionDebugInfoRef.current },
      recentEvents: netLagEventsRef.current.slice(-80),
    }
  }, [])

  const pointDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

  const computeTailEndMetrics = (snake: Point[], tailExtension: number) => {
    if (snake.length < 2) return null
    const tail = normalize(snake[snake.length - 1])
    const prev = normalize(snake[snake.length - 2])
    const segLen = pointDistance(tail, prev)
    let refLen = segLen
    if (!(refLen > 1e-6) && snake.length >= 3) {
      const prevPrev = normalize(snake[snake.length - 3])
      refLen = pointDistance(prev, prevPrev)
    }
    if (!Number.isFinite(refLen) || refLen <= 0) {
      refLen = 0
    }
    const extRatio = clamp(tailExtension, 0, 0.999_999)
    const extDist = Math.max(0, refLen) * extRatio
    return {
      segLen,
      refLen,
      extRatio,
      extDist,
      endLen: segLen + extDist,
    }
  }

  const digestionMaxProgress = (digestions: Array<{ progress: number }>) => {
    let max = 0
    for (const digestion of digestions) {
      const p = digestion.progress
      if (Number.isFinite(p)) max = Math.max(max, p)
    }
    return max
  }

  const appendTailGrowthEvent = useCallback(
    (event: TailGrowthEventInput) => {
      if (!tailDebugEnabled) return
      const net = netDebugInfoRef.current
      const entry: TailGrowthEvent = {
        id: tailGrowthEventIdRef.current,
        atIso: new Date().toISOString(),
        tMs: event.tMs ?? performance.now(),
        kind: event.kind,
        phase: event.phase ?? menuPhaseRef.current,
        seq: event.seq,
        now: event.now,
        localId: event.localId,
        alive: event.alive,
        isBoosting: event.isBoosting,
        boostInput: event.boostInput,
        score: event.score,
        scoreFraction: event.scoreFraction,
        snakeLen: event.snakeLen,
        snakeTotalLen: event.snakeTotalLen,
        tailExtension: event.tailExtension,
        lenUnits: event.lenUnits,
        digestions: event.digestions,
        digestionMaxProgress: event.digestionMaxProgress,
        tailSegLen: event.tailSegLen,
        tailRefLen: event.tailRefLen,
        tailExtRatio: event.tailExtRatio,
        tailExtDist: event.tailExtDist,
        tailEndLen: event.tailEndLen,
        rawSnakeLen: event.rawSnakeLen,
        rawSnakeTotalLen: event.rawSnakeTotalLen,
        rawTailExtension: event.rawTailExtension,
        rawLenUnits: event.rawLenUnits,
        rawTailSegLen: event.rawTailSegLen,
        rawTailRefLen: event.rawTailRefLen,
        rawTailExtRatio: event.rawTailExtRatio,
        rawTailExtDist: event.rawTailExtDist,
        rawTailEndLen: event.rawTailEndLen,
        lagSpikeActive: net.lagSpikeActive,
        lagSpikeCause: net.lagSpikeCause,
        playoutDelayMs: net.playoutDelayMs,
        delayBoostMs: net.delayBoostMs,
        jitterDelayMs: net.jitterDelayMs,
        jitterMs: net.jitterMs,
        receiveIntervalMs: net.receiveIntervalMs,
        staleMs: net.staleMs,
        impairmentMsRemaining: net.impairmentMsRemaining,
        maxExtrapolationMs: net.maxExtrapolationMs,
        latestSeq: net.latestSeq,
        seqGapDetected: net.seqGapDetected,
        tuningRevision: net.tuningRevision,
      }
      tailGrowthEventIdRef.current += 1
      const eventLog = tailGrowthEventsRef.current
      eventLog.push(entry)
      if (eventLog.length > TAIL_EVENT_LOG_LIMIT) {
        eventLog.splice(0, eventLog.length - TAIL_EVENT_LOG_LIMIT)
      }
    },
    [tailDebugEnabled],
  )

	  const buildTailGrowthReport = useCallback((): TailGrowthReport => {
	    const events = tailGrowthEventsRef.current
	    const shrinks = events.filter((event) => event.kind === 'shrink')
	    const stretches = events.filter((event) => event.kind === 'stretch')
	    return {
	      generatedAtIso: new Date().toISOString(),
	      enabled: tailDebugEnabled,
	      count: events.length,
	      shrinkCount: shrinks.length,
	      stretchCount: stretches.length,
	      recentShrinks: shrinks.slice(-12),
	      recentStretches: stretches.slice(-12),
	    }
	  }, [tailDebugEnabled])

  const applyNetTuningOverrides = useCallback(
    (incoming: NetTuningOverrides | null | undefined, options?: { announce?: boolean }) => {
      const normalized: NetTuningOverrides = {}
      if (incoming && typeof incoming === 'object') {
        for (const [rawKey, rawValue] of Object.entries(incoming)) {
          if (!(rawKey in DEFAULT_NET_TUNING)) continue
          if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue
          const key = rawKey as keyof typeof DEFAULT_NET_TUNING
          normalized[key] = rawValue
        }
      }
      netTuningOverridesRef.current = normalized
      netTuningRef.current = resolveNetTuning(normalized)
      netTuningRevisionRef.current += 1
      netDebugInfoRef.current = {
        ...netDebugInfoRef.current,
        tuningRevision: netTuningRevisionRef.current,
        tuningOverrides: { ...netTuningOverridesRef.current },
      }
      const announce = options?.announce ?? true
      if (announce) {
        appendNetLagEvent(
          'tuning_update',
          `net tuning updated rev=${netTuningRevisionRef.current} overrides=${JSON.stringify(normalized)}`,
        )
      }
      return {
        revision: netTuningRevisionRef.current,
        overrides: { ...netTuningOverridesRef.current },
        resolved: { ...netTuningRef.current },
      }
    },
    [appendNetLagEvent],
  )

  const setLagSpikeState = useCallback((active: boolean, cause: LagSpikeCause) => {
    const wasActive = lagSpikeActiveRef.current
    const previousCause = lagSpikeCauseRef.current
    const normalizedCause: LagSpikeCause = active ? cause : 'none'
    const becameActive = !wasActive && active
    const becameInactive = wasActive && !active
    const causeChangedWhileActive = wasActive && active && previousCause !== normalizedCause
    if (!becameActive && !becameInactive && !causeChangedWhileActive) return

    lagSpikeActiveRef.current = active
    lagSpikeCauseRef.current = normalizedCause
    netDebugInfoRef.current.lagSpikeActive = active
    netDebugInfoRef.current.lagSpikeCause = normalizedCause

    if (causeChangedWhileActive) {
      return
    }

    if (becameActive) {
      const tuning = netTuningRef.current
      const tickMs = Math.max(16, serverTickMsRef.current)
      const causeBoostScale =
        normalizedCause === 'arrival-gap' ? 0.45 : normalizedCause === 'stale' ? 1 : 1.2
      const spikeBoost = tickMs * tuning.netSpikeDelayBoostTicks * causeBoostScale
      delayBoostMsRef.current = Math.max(delayBoostMsRef.current, spikeBoost)
      appendNetLagEvent(
        'spike_start',
        `spike started via ${normalizedCause}; delay boost ${delayBoostMsRef.current.toFixed(1)}ms`,
      )
      if (netDebugEnabled) {
        console.info(
          `[net] lag spike start cause=${normalizedCause} boost=${delayBoostMsRef.current.toFixed(1)}ms`,
        )
      }
      return
    }

    if (previousCause === 'arrival-gap') {
      lagSpikeArrivalGapCooldownUntilMsRef.current = performance.now() + ARRIVAL_GAP_REENTRY_COOLDOWN_MS
    }

    appendNetLagEvent(
      'spike_end',
      `spike ended; delay=${playoutDelayMsRef.current.toFixed(1)}ms jitter=${receiveJitterMsRef.current.toFixed(1)}ms`,
    )
    if (netDebugEnabled) {
      console.info(
        `[net] lag spike end delay=${playoutDelayMsRef.current.toFixed(1)}ms jitter=${receiveJitterMsRef.current.toFixed(1)}ms`,
      )
    }
  }, [appendNetLagEvent, netDebugEnabled])

  const pushSnapshot = useCallback((state: GameStateSnapshot) => {
    const now = Date.now()
    const nowMs = performance.now()
    const hadSeqGap = seqGapDetectedRef.current
    const tuning = netTuningRef.current

    const latestSeq = latestSeqRef.current
    if (latestSeq !== null) {
      if (state.seq === latestSeq) {
        // Duplicate frame can happen around reconnect/buffer edges; ignore quietly.
        return
      }
      if (!isSeqNewer(state.seq, latestSeq)) {
        appendNetLagEvent(
          'snapshot_drop',
          `dropped out-of-order snapshot seq=${state.seq} latest=${latestSeq}`,
          { droppedSeq: state.seq },
        )
        if (netDebugEnabled) {
          console.info(`[net] dropped out-of-order snapshot seq=${state.seq} latest=${latestSeq}`)
        }
        return
      }
      const gap = seqGapSize(state.seq, latestSeq)
      if (gap > 1) {
        seqGapDetectedRef.current = true
        lastSeqGapAtMsRef.current = nowMs
        if (!hadSeqGap) {
          appendNetLagEvent('seq_gap', `sequence gap detected: +${gap}`, { seqGapSize: gap })
        }
      }
    }
    latestSeqRef.current = state.seq

    const sampleOffset = state.now - now
    const currentOffset = serverOffsetRef.current
    if (currentOffset === null) {
      serverOffsetRef.current = sampleOffset
    } else {
      const tickMs = Math.max(16, serverTickMsRef.current)
      const rawDelta = sampleOffset - currentOffset
      const outlierThreshold = tickMs * 6
      const deltaClamp =
        lagSpikeActiveRef.current || Math.abs(rawDelta) > outlierThreshold ? tickMs * 0.65 : tickMs * 1.8
      const clampedDelta = clamp(rawDelta, -deltaClamp, deltaClamp)
      const offsetSmoothing =
        lagSpikeActiveRef.current || Math.abs(rawDelta) > outlierThreshold
          ? tuning.serverOffsetSmoothing * 0.35
          : tuning.serverOffsetSmoothing
      serverOffsetRef.current = currentOffset + clampedDelta * offsetSmoothing
    }

    const lastSnapshotTime = lastSnapshotTimeRef.current
    if (lastSnapshotTime !== null) {
      const delta = state.now - lastSnapshotTime
      if (delta > 0 && delta < 1000) {
        tickIntervalRef.current = tickIntervalRef.current * 0.8 + delta * 0.2
      }
    }
    lastSnapshotTimeRef.current = state.now
    serverTickMsRef.current = Math.max(16, tickIntervalRef.current)

    const lastReceivedAt = lastSnapshotReceivedAtRef.current
    let latestIntervalMs = receiveIntervalMsRef.current
    if (lastReceivedAt !== null) {
      const interval = now - lastReceivedAt
      if (interval > 0 && interval < 5000) {
        const intervalEwma = receiveIntervalMsRef.current
        const nextIntervalEwma = intervalEwma + (interval - intervalEwma) * tuning.netIntervalSmoothing
        receiveIntervalMsRef.current = nextIntervalEwma
        latestIntervalMs = nextIntervalEwma
        const jitterSample = Math.abs(interval - nextIntervalEwma)
        const jitterEwma = receiveJitterMsRef.current
        receiveJitterMsRef.current =
          jitterEwma + (jitterSample - jitterEwma) * tuning.netJitterSmoothing
        const tickMs = Math.max(16, serverTickMsRef.current)
        const jitterDelaySampleCapMs = tickMs * tuning.netJitterDelayMaxTicks
        const jitterDelaySample = Math.min(jitterSample, jitterDelaySampleCapMs)
        const jitterDelayEwma = receiveJitterDelayMsRef.current
        receiveJitterDelayMsRef.current =
          jitterDelayEwma + (jitterDelaySample - jitterDelayEwma) * tuning.netJitterSmoothing

        const intervalSpikeThreshold = Math.max(
          tickMs * tuning.netSpikeIntervalFactor,
          nextIntervalEwma +
            receiveJitterMsRef.current * tuning.netJitterDelayMultiplier +
            tuning.netSpikeIntervalMarginMs,
        )
        if (interval > intervalSpikeThreshold) {
          const lateBy = interval - intervalSpikeThreshold
          if (lateBy > tickMs * 0.45) {
            const lateByScale = clamp(lateBy / tickMs, 0, 6)
            const holdMs = clamp(
              tuning.netSpikeImpairmentHoldMs + lateBy * (1.8 + lateByScale * 0.6),
              tuning.netSpikeImpairmentHoldMs,
              tuning.netSpikeImpairmentMaxHoldMs,
            )
            lagImpairmentUntilMsRef.current = Math.max(lagImpairmentUntilMsRef.current, nowMs + holdMs)
            delayBoostMsRef.current = Math.max(
              delayBoostMsRef.current,
              Math.min(tickMs * (tuning.netSpikeDelayBoostTicks * 1.25), lateBy * 0.7),
            )
          }
        }
      }
    }
    lastSnapshotReceivedAtRef.current = now

    const buffer = snapshotBufferRef.current
    buffer.push({ ...state, receivedAt: now })
    buffer.sort((a, b) => a.now - b.now)
    if (buffer.length > MAX_SNAPSHOT_BUFFER) {
      buffer.splice(0, buffer.length - MAX_SNAPSHOT_BUFFER)
    }

    if (seqGapDetectedRef.current) {
      const stableWindowMs = tuning.netStableRecoverySecs * 1000
      const lastGapAt = lastSeqGapAtMsRef.current
      if (lastGapAt !== null && nowMs - lastGapAt >= stableWindowMs) {
        seqGapDetectedRef.current = false
      }
    }

    netDebugInfoRef.current = {
      ...netDebugInfoRef.current,
      latestSeq: latestSeqRef.current,
      delayBoostMs: delayBoostMsRef.current,
      jitterDelayMs: receiveJitterDelayMsRef.current,
      jitterMs: receiveJitterMsRef.current,
      receiveIntervalMs: latestIntervalMs,
      seqGapDetected: seqGapDetectedRef.current,
      tuningRevision: netTuningRevisionRef.current,
      tuningOverrides: { ...netTuningOverridesRef.current },
    }

    if (tailDebugEnabled) {
      const localId = playerIdRef.current
      const boostInput = pointerRef.current.boost
      const localPlayer = localId ? state.players.find((player) => player.id === localId) ?? null : null
      const tailExt = localPlayer?.tailExtension ?? null
      const snakeLen = localPlayer?.snake.length ?? null
      const snakeTotalLen = localPlayer?.snakeTotalLen ?? null
      const extRatio = tailExt === null ? null : clamp(tailExt, 0, 0.999_999)
      const totalLen = snakeTotalLen ?? snakeLen
      const lenUnits = totalLen === null || extRatio === null ? null : totalLen + extRatio
      const digestions = localPlayer?.digestions ?? null
      const metrics =
        localPlayer && tailExt !== null ? computeTailEndMetrics(localPlayer.snake, tailExt) : null

      appendTailGrowthEvent({
        kind: 'rx',
        seq: state.seq,
        now: state.now,
        localId,
        alive: localPlayer?.alive ?? null,
        isBoosting: localPlayer?.isBoosting ?? null,
        boostInput,
        score: localPlayer?.score ?? null,
        scoreFraction: localPlayer?.scoreFraction ?? null,
        snakeLen,
        snakeTotalLen,
        tailExtension: tailExt,
        lenUnits,
        digestions: digestions ? digestions.length : null,
        digestionMaxProgress: digestions ? digestionMaxProgress(digestions) : null,
        tailSegLen: metrics?.segLen ?? null,
        tailRefLen: metrics?.refLen ?? null,
        tailExtRatio: metrics?.extRatio ?? null,
        tailExtDist: metrics?.extDist ?? null,
        tailEndLen: metrics?.endLen ?? null,
        rawSnakeLen: null,
        rawSnakeTotalLen: null,
        rawTailExtension: null,
        rawLenUnits: null,
        rawTailSegLen: null,
        rawTailRefLen: null,
        rawTailExtRatio: null,
        rawTailExtDist: null,
        rawTailEndLen: null,
      })
    }
  }, [appendNetLagEvent, netDebugEnabled, tailDebugEnabled, appendTailGrowthEvent])

  const getRenderSnapshot = useCallback(() => {
    const buffer = snapshotBufferRef.current
    if (buffer.length === 0) return null
    const offset = serverOffsetRef.current
    if (offset === null) return buffer[buffer.length - 1]
    const tuning = netTuningRef.current

    const now = Date.now()
    const nowMs = performance.now()
    const tickMs = Math.max(16, serverTickMsRef.current)

    const lastDelayUpdateMs = lastDelayUpdateMsRef.current
    const dtSeconds =
      lastDelayUpdateMs !== null ? Math.max(0, Math.min(0.1, (nowMs - lastDelayUpdateMs) / 1000)) : 1 / 60
    if (lastDelayUpdateMs !== null) {
      if (dtSeconds > 0 && !lagSpikeActiveRef.current) {
        delayBoostMsRef.current = Math.max(
          0,
          delayBoostMsRef.current - tuning.netDelayBoostDecayPerSec * dtSeconds,
        )
      }
    }
    lastDelayUpdateMsRef.current = nowMs

    const lastReceivedAt = lastSnapshotReceivedAtRef.current
    const staleMs = lastReceivedAt === null ? 0 : Math.max(0, now - lastReceivedAt)
    const staleThresholdMs = Math.max(40, tickMs * tuning.netSpikeStaleTicks)
    const staleSpike = staleMs > staleThresholdMs
    const impairmentMsRemaining = Math.max(0, lagImpairmentUntilMsRef.current - nowMs)
    const impairmentSpike = impairmentMsRemaining > 0
    if (!staleSpike && seqGapDetectedRef.current) {
      const stableWindowMs = tuning.netStableRecoverySecs * 1000
      const lastGapAt = lastSeqGapAtMsRef.current
      if (lastGapAt !== null && nowMs - lastGapAt >= stableWindowMs) {
        seqGapDetectedRef.current = false
      }
    }

    const seqGapSpike = seqGapDetectedRef.current
    const instantCause: LagSpikeCause = staleSpike
      ? 'stale'
      : seqGapSpike
        ? 'seq-gap'
        : impairmentSpike
          ? 'arrival-gap'
          : 'none'
    const shouldSpike = instantCause !== 'none'
    let nextSpikeActive = lagSpikeActiveRef.current
    let nextCause: LagSpikeCause = lagSpikeCauseRef.current

    if (!lagSpikeActiveRef.current) {
      if (shouldSpike) {
        if (lagSpikeEnterCandidateAtMsRef.current === null) {
          lagSpikeEnterCandidateAtMsRef.current = nowMs
        }
        const blockArrivalGapReentry =
          instantCause === 'arrival-gap' && nowMs < lagSpikeArrivalGapCooldownUntilMsRef.current
        const enterConfirmed =
          !blockArrivalGapReentry &&
          nowMs - (lagSpikeEnterCandidateAtMsRef.current ?? nowMs) >= tuning.netSpikeEnterConfirmMs
        if (enterConfirmed) {
          lagSpikeEnterCandidateAtMsRef.current = null
          lagSpikeExitCandidateAtMsRef.current = null
          nextSpikeActive = true
          nextCause = instantCause
        } else {
          nextSpikeActive = false
          nextCause = 'none'
        }
      } else {
        lagSpikeEnterCandidateAtMsRef.current = null
        nextSpikeActive = false
        nextCause = 'none'
      }
    } else if (shouldSpike) {
      lagSpikeExitCandidateAtMsRef.current = null
      nextSpikeActive = true
      nextCause = instantCause
    } else {
      if (lagSpikeExitCandidateAtMsRef.current === null) {
        lagSpikeExitCandidateAtMsRef.current = nowMs
      }
      const exitConfirmMs =
        lagSpikeCauseRef.current === 'arrival-gap'
          ? Math.max(tuning.netSpikeExitConfirmMs, 420)
          : tuning.netSpikeExitConfirmMs
      const exitConfirmed =
        nowMs - (lagSpikeExitCandidateAtMsRef.current ?? nowMs) >= exitConfirmMs
      if (exitConfirmed) {
        lagSpikeExitCandidateAtMsRef.current = null
        nextSpikeActive = false
        nextCause = 'none'
      } else {
        nextSpikeActive = true
      }
    }

    setLagSpikeState(nextSpikeActive, nextCause)

    const baseDelayMs = tickMs * tuning.netBaseDelayTicks
    const minDelayMs = tickMs * tuning.netMinDelayTicks
    const maxDelayMs = tickMs * tuning.netMaxDelayTicks
    const jitterDelayMs = receiveJitterDelayMsRef.current * tuning.netJitterDelayMultiplier
    const targetDelay = clamp(baseDelayMs + jitterDelayMs + delayBoostMsRef.current, minDelayMs, maxDelayMs)
    const currentDelay = playoutDelayMsRef.current
    const delayRatePerSec =
      targetDelay >= currentDelay
        ? lagSpikeActiveRef.current
          ? 12
          : 8
        : lagSpikeActiveRef.current
          ? 8
          : 5
    const delayAlpha = clamp(1 - Math.exp(-delayRatePerSec * dtSeconds), 0, 1)
    const delay = currentDelay + (targetDelay - currentDelay) * delayAlpha
    playoutDelayMsRef.current = delay

    const maxExtrapolationMs = lagSpikeActiveRef.current
      ? clamp(tickMs * 0.95, 14, 48)
      : clamp(tickMs * 0.5, 10, MAX_EXTRAPOLATION_MS)
    const renderTime = now + offset - delay
    const snapshot = buildInterpolatedSnapshot(buffer, renderTime, maxExtrapolationMs)
    netDebugInfoRef.current = {
      lagSpikeActive: lagSpikeActiveRef.current,
      lagSpikeCause: lagSpikeCauseRef.current,
      playoutDelayMs: delay,
      delayBoostMs: delayBoostMsRef.current,
      jitterDelayMs: jitterDelayMs,
      jitterMs: receiveJitterMsRef.current,
      receiveIntervalMs: receiveIntervalMsRef.current,
      staleMs,
      impairmentMsRemaining,
      maxExtrapolationMs,
      latestSeq: latestSeqRef.current,
      seqGapDetected: seqGapDetectedRef.current,
      tuningRevision: netTuningRevisionRef.current,
      tuningOverrides: { ...netTuningOverridesRef.current },
    }
    return snapshot
  }, [setLagSpikeState])

  const stabilizeLocalSnapshot = useCallback(
    (
      snapshot: GameStateSnapshot | null,
      localId: string | null,
      frameDeltaSeconds: number,
    ): GameStateSnapshot | null => {
      if (!snapshot || !localId) {
        localSnakeDisplayRef.current = null
        return snapshot
      }

      const localIndex = snapshot.players.findIndex((player) => player.id === localId)
      if (localIndex < 0) {
        localSnakeDisplayRef.current = null
        return snapshot
      }

      const localPlayer = snapshot.players[localIndex]
      if (!localPlayer.alive || localPlayer.snake.length === 0) {
        localSnakeDisplayRef.current = null
        return snapshot
      }

      const incomingSnake = localPlayer.snake
      const previousSnake = localSnakeDisplayRef.current
      if (!previousSnake || previousSnake.length === 0) {
        // Normalize to unit vectors so downstream code (view culling, tail metrics, etc) matches
        // what the renderer actually uses.
        localSnakeDisplayRef.current = incomingSnake.map((node) => normalize(node))
        return snapshot
      }

      const tuning = netTuningRef.current
      const hardSpikeActive =
        lagSpikeActiveRef.current && lagSpikeCauseRef.current !== 'arrival-gap'
      const mildArrivalSpikeActive =
        lagSpikeActiveRef.current && lagSpikeCauseRef.current === 'arrival-gap'
      const nearSpike =
        hardSpikeActive ||
        lagCameraHoldActiveRef.current ||
        lagCameraRecoveryStartMsRef.current !== null ||
        delayBoostMsRef.current > serverTickMsRef.current * 0.85
      const mildArrivalRate = Math.max(
        tuning.localSnakeStabilizerRateSpike * 1.35,
        tuning.localSnakeStabilizerRateNormal * 0.55,
      )
      const rate = nearSpike
        ? tuning.localSnakeStabilizerRateSpike
        : mildArrivalSpikeActive
          ? mildArrivalRate
          : tuning.localSnakeStabilizerRateNormal
      const dt = clamp(frameDeltaSeconds, 0, 0.1)
      const alpha = 1 - Math.exp(-rate * dt)

      if (alpha >= 0.999) {
        localSnakeDisplayRef.current = incomingSnake.map((node) => ({ ...node }))
        return snapshot
      }

      const blendLen = Math.min(previousSnake.length, incomingSnake.length)
      const blendedSnake: Point[] = []
      const lastIndex = Math.max(1, incomingSnake.length - 1)
      for (let i = 0; i < incomingSnake.length; i += 1) {
        if (i < blendLen) {
          // Reduce smoothing near the tail so segment spacing doesn't collapse during rapid
          // growth/boost transitions (which can otherwise read as a tail "shrink then pop").
          const t = i / lastIndex
          const tailBias = t * t
          const alphaNode = clamp(alpha + (1 - alpha) * tailBias, 0, 1)
          blendedSnake.push(normalize(lerpPoint(previousSnake[i], incomingSnake[i], alphaNode)))
        } else {
          blendedSnake.push(normalize(incomingSnake[i]))
        }
      }
      localSnakeDisplayRef.current = blendedSnake.map((node) => ({ ...node }))

      const players = snapshot.players.slice()
      players[localIndex] = {
        ...localPlayer,
        snake: blendedSnake,
      }
      return {
        ...snapshot,
        players,
      }
    },
    [],
  )

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  useEffect(() => {
    playerNameRef.current = playerName
  }, [playerName])

  useEffect(() => {
    menuUiModeRef.current = menuUiMode
  }, [menuUiMode])

  useEffect(() => {
    menuOverlayExitingRef.current = menuOverlayExiting
  }, [menuOverlayExiting])

  useEffect(() => {
    storeSelectedSkin(selectedSkin)
  }, [selectedSkin])

  useEffect(() => {
    // Keep selected solid palette index in sync with persisted selection.
    if (selectedSkin.kind !== 'solid') return
    const idx = SKIN_PALETTE_COLORS.findIndex((c) => c.toLowerCase() === selectedSkin.color.toLowerCase())
    if (idx >= 0 && idx !== solidPaletteIndex) {
      setSolidPaletteIndex(idx)
    }
  }, [selectedSkin, solidPaletteIndex])

  useEffect(() => {
    const resolved = resolveSelectedSkinColors(selectedSkin, skinDesigns)
    joinSkinColorsRef.current = resolved
    // If we are in the live menu room, push a meta update so others see it immediately.
    if (menuPhaseRef.current === 'preplay') {
      const socket = socketRef.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendJoin(socket, true)
      }
    }
  }, [selectedSkin, skinDesigns])

  useEffect(() => {
    builderPatternRef.current = builderPattern
  }, [builderPattern])

  useEffect(() => {
    builderPaletteColorRef.current = builderPaletteColor
  }, [builderPaletteColor])

  useEffect(() => {
    menuPhaseRef.current = menuPhase
    if (menuPhase === 'preplay') {
      setMenuUiMode('home')
    }
    inputEnabledRef.current = menuPhase === 'playing'
    if (menuPhase !== 'playing') {
      pointerRef.current.active = false
      webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
      clearBoostInputs()
    }
    if (menuPhase === 'preplay' && !allowPreplayAutoResumeRef.current) {
      const socket = socketRef.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendJoin(socket, true)
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
        webgl.setWebgpuWorldSamples?.(adaptiveQualityRef.current.webgpuSamples)

        const handleResize = () => {
          const rect = glCanvas.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const adaptive = adaptiveQualityRef.current
          const baseMaxDpr = Math.min(window.devicePixelRatio || 1, 2)
          const maxDpr = Math.min(baseMaxDpr, adaptive.maxDprCap)
          const minDpr = adaptive.minDpr
          let dpr = maxDpr
          if (adaptive.enabled) {
            if (!Number.isFinite(adaptive.currentDpr) || adaptive.currentDpr <= 0) {
              adaptive.currentDpr = maxDpr
            }
            adaptive.currentDpr = clamp(adaptive.currentDpr, minDpr, maxDpr)
            dpr = adaptive.currentDpr
          } else {
            adaptive.currentDpr = maxDpr
            dpr = maxDpr
          }
          dpr = Math.round(dpr * 100) / 100
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
	          const rafPerf = rafPerfRef.current
	          const rafPerfEnabled = rafPerf.enabled
	          let frameStartMs = 0
	          let nowMs = 0
	          let afterSnapshotMs = 0
	          let afterCameraMs = 0
	          let afterRenderMs = 0
	          let afterHudMs = 0
	          let afterDebugMs = 0
	          let snapshotPlayerCount = 0
	          let snapshotPelletCount = 0
            let frameDeltaSeconds = 1 / 60
		          if (config && webgl) {
		            nowMs = performance.now()
		            if (rafPerfEnabled) {
		              frameStartMs = nowMs
	            }
		            const lastRenderFrameMs = lastRenderFrameMsRef.current
		            frameDeltaSeconds =
		              lastRenderFrameMs !== null
		                ? Math.max(0, Math.min(0.1, (nowMs - lastRenderFrameMs) / 1000))
		                : 1 / 60
		            lastRenderFrameMsRef.current = nowMs
			            const localId = playerIdRef.current
			            const rawSnapshot = getRenderSnapshot()
			            const snapshot = stabilizeLocalSnapshot(rawSnapshot, localId, frameDeltaSeconds)
			            snapshotPlayerCount = snapshot?.players.length ?? 0
			            snapshotPelletCount = snapshot?.pellets.length ?? 0
			            if (rafPerfEnabled) {
			              afterSnapshotMs = performance.now()
			            }
		            const localSnapshotPlayer =
		              snapshot?.players.find((player) => player.id === localId) ?? null
		            const rawSnapshotPlayer =
		              rawSnapshot?.players.find((player) => player.id === localId) ?? null
            const localHead = localSnapshotPlayer?.snake[0] ?? null
            const hasSpawnedSnake =
              !!localSnapshotPlayer && localSnapshotPlayer.alive && localSnapshotPlayer.snake.length > 0
            const rawGameplayCamera = updateCamera(localHead, cameraUpRef)
            const phase = menuPhaseRef.current

	            if (tailDebugEnabled) {
	              const lastSampleAt = lastTailRenderSampleAtMsRef.current
	              const shouldSample =
	                lastSampleAt === null || nowMs - lastSampleAt >= TAIL_RENDER_SAMPLE_INTERVAL_MS
	              if (shouldSample) {
	                lastTailRenderSampleAtMsRef.current = nowMs
	                const boostInput = pointerRef.current.boost
	                const stableTailExt = localSnapshotPlayer?.tailExtension ?? null
	                const rawTailExt = rawSnapshotPlayer?.tailExtension ?? null
	                const stableMetrics =
	                  localSnapshotPlayer && stableTailExt !== null
	                    ? computeTailEndMetrics(localSnapshotPlayer.snake, stableTailExt)
	                    : null
	                const rawMetrics =
	                  rawSnapshotPlayer && rawTailExt !== null
	                    ? computeTailEndMetrics(rawSnapshotPlayer.snake, rawTailExt)
	                    : null
	                const stableExtRatio = stableTailExt === null ? null : clamp(stableTailExt, 0, 0.999_999)
	                const rawExtRatio = rawTailExt === null ? null : clamp(rawTailExt, 0, 0.999_999)
	                const stableTotalLen =
	                  localSnapshotPlayer?.snakeTotalLen ?? localSnapshotPlayer?.snake.length ?? null
	                const rawTotalLen = rawSnapshotPlayer?.snakeTotalLen ?? rawSnapshotPlayer?.snake.length ?? null
	                const stableLenUnits =
	                  stableTotalLen === null || stableExtRatio === null ? null : stableTotalLen + stableExtRatio
		                const rawLenUnits =
		                  rawTotalLen === null || rawExtRatio === null ? null : rawTotalLen + rawExtRatio

		                let kind: TailGrowthEvent['kind'] = 'render'
		                const stableEndLen = stableMetrics?.endLen ?? null
		                const prevSample = lastTailEndSampleRef.current
		                const prevEndLen = prevSample?.endLen ?? null
		                const stableSample: TailEndSample | null =
		                  stableMetrics && stableEndLen !== null && Number.isFinite(stableEndLen)
		                    ? {
		                        seq: snapshot?.seq ?? null,
		                        now: snapshot?.now ?? null,
		                        snakeLen: localSnapshotPlayer?.snake.length ?? null,
		                        snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
		                        tailExtension: stableTailExt ?? null,
		                        ...stableMetrics,
		                      }
		                    : null
		                if (
		                  stableEndLen !== null &&
		                  prevEndLen !== null &&
		                  Number.isFinite(stableEndLen) &&
		                  Number.isFinite(prevEndLen) &&
		                  !(localSnapshotPlayer?.isBoosting ?? false) &&
		                  !boostInput
		                ) {
		                  const refLen = stableMetrics?.refLen ?? 0
		                  const threshold = Math.max(0.003, refLen * 0.35)
		                  if (stableEndLen < prevEndLen - threshold) {
		                    kind = 'shrink'
		                    console.info(
		                      `[tail] shrink seq=${snapshot?.seq ?? -1} endLen=${stableEndLen.toFixed(4)} prev=${prevEndLen.toFixed(4)} ref=${refLen.toFixed(4)} tailExt=${(stableTailExt ?? 0).toFixed(3)} boost=${localSnapshotPlayer?.isBoosting ?? false} input=${boostInput}`,
		                      {
		                        prev: prevSample,
		                        current: stableSample,
		                        stable: {
		                          snakeLen: localSnapshotPlayer?.snake.length ?? null,
		                          snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
		                          tailExtension: stableTailExt,
		                          ...stableMetrics,
		                        },
		                        raw: rawSnapshotPlayer
		                          ? {
		                              snakeLen: rawSnapshotPlayer.snake.length,
		                              snakeTotalLen: rawSnapshotPlayer.snakeTotalLen,
		                              tailExtension: rawTailExt,
		                              ...rawMetrics,
		                            }
		                          : null,
		                      },
		                    )
		                  } else if (stableEndLen > prevEndLen + threshold) {
		                    kind = 'stretch'
		                    console.info(
		                      `[tail] stretch seq=${snapshot?.seq ?? -1} endLen=${stableEndLen.toFixed(4)} prev=${prevEndLen.toFixed(4)} ref=${refLen.toFixed(4)} tailExt=${(stableTailExt ?? 0).toFixed(3)} boost=${localSnapshotPlayer?.isBoosting ?? false} input=${boostInput}`,
		                      {
		                        prev: prevSample,
		                        current: stableSample,
		                        stable: {
		                          snakeLen: localSnapshotPlayer?.snake.length ?? null,
		                          snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
		                          tailExtension: stableTailExt,
		                          ...stableMetrics,
		                        },
		                        raw: rawSnapshotPlayer
		                          ? {
		                              snakeLen: rawSnapshotPlayer.snake.length,
		                              snakeTotalLen: rawSnapshotPlayer.snakeTotalLen,
		                              tailExtension: rawTailExt,
		                              ...rawMetrics,
		                            }
		                          : null,
		                      },
		                    )
		                  }
		                }
		                lastTailEndSampleRef.current = stableSample

		                appendTailGrowthEvent({
		                  kind,
		                  phase,
	                  seq: snapshot?.seq ?? null,
	                  now: snapshot?.now ?? null,
	                  localId,
	                  alive: localSnapshotPlayer?.alive ?? null,
	                  isBoosting: localSnapshotPlayer?.isBoosting ?? null,
	                  boostInput,
	                  score: localSnapshotPlayer?.score ?? null,
	                  scoreFraction: localSnapshotPlayer?.scoreFraction ?? null,
	                  snakeLen: localSnapshotPlayer?.snake.length ?? null,
	                  snakeTotalLen: localSnapshotPlayer?.snakeTotalLen ?? null,
	                  tailExtension: stableTailExt,
	                  lenUnits: stableLenUnits,
	                  digestions: localSnapshotPlayer?.digestions.length ?? null,
	                  digestionMaxProgress: localSnapshotPlayer
	                    ? digestionMaxProgress(localSnapshotPlayer.digestions)
	                    : null,
	                  tailSegLen: stableMetrics?.segLen ?? null,
	                  tailRefLen: stableMetrics?.refLen ?? null,
	                  tailExtRatio: stableMetrics?.extRatio ?? null,
	                  tailExtDist: stableMetrics?.extDist ?? null,
	                  tailEndLen: stableMetrics?.endLen ?? null,
	                  rawSnakeLen: rawSnapshotPlayer?.snake.length ?? null,
	                  rawSnakeTotalLen: rawSnapshotPlayer?.snakeTotalLen ?? null,
	                  rawTailExtension: rawTailExt,
	                  rawLenUnits,
	                  rawTailSegLen: rawMetrics?.segLen ?? null,
	                  rawTailRefLen: rawMetrics?.refLen ?? null,
	                  rawTailExtRatio: rawMetrics?.extRatio ?? null,
	                  rawTailExtDist: rawMetrics?.extDist ?? null,
	                  rawTailEndLen: rawMetrics?.endLen ?? null,
	                })
	              }
	            }

            if (phase === 'playing' && hasSpawnedSnake && localHead) {
              const normalizedHead = normalize(localHead)
              const previousHead = lastHeadSampleRef.current
              if (previousHead) {
                const headDot = clamp(
                  previousHead.x * normalizedHead.x +
                    previousHead.y * normalizedHead.y +
                    previousHead.z * normalizedHead.z,
                  -1,
                  1,
                )
                const motionInfo = motionDebugInfoRef.current
                motionInfo.sampleCount += 1
                motionInfo.minHeadDot = Math.min(motionInfo.minHeadDot, headDot)
                if (headDot < MOTION_BACKWARD_DOT_THRESHOLD) {
                  motionInfo.backwardCorrectionCount += 1
                }
              }
              lastHeadSampleRef.current = normalizedHead
            } else {
              lastHeadSampleRef.current = null
            }

            if (hasSpawnedSnake) {
              deathStartedAtMsRef.current = null
              if (!localLifeSpawnedRef.current) {
                localLifeSpawnedRef.current = true
              }
            } else if (localLifeSpawnedRef.current && deathStartedAtMsRef.current === null) {
              deathStartedAtMsRef.current = nowMs
              pointerRef.current.active = false
              webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
              clearBoostInputs()
            }

            if (
              phase === 'playing' &&
              localLifeSpawnedRef.current &&
              deathStartedAtMsRef.current !== null &&
              nowMs - deathStartedAtMsRef.current >= DEATH_TO_MENU_DELAY_MS
            ) {
              const sourceCameraQ = rawGameplayCamera.active ? rawGameplayCamera.q : cameraRef.current.q
              returnFromCameraQRef.current = { ...sourceCameraQ }
              returnFromDistanceRef.current = renderCameraDistanceRef.current
              returnFromVerticalOffsetRef.current = renderCameraVerticalOffsetRef.current
              returnBlendStartMsRef.current = nowMs
              returnToMenuCommittedRef.current = false
              localLifeSpawnedRef.current = false
              deathStartedAtMsRef.current = null
              const socket = socketRef.current
              if (socket && socket.readyState === WebSocket.OPEN) {
                sendJoin(socket, true)
              }
              setMenuPhase('returning')
            }

            let gameplayCamera = rawGameplayCamera
            if (phase === 'playing' && hasSpawnedSnake && rawGameplayCamera.active) {
              const tuning = netTuningRef.current
              const hardSpikeActive =
                lagSpikeActiveRef.current && lagSpikeCauseRef.current !== 'arrival-gap'
              if (hardSpikeActive) {
                lagCameraRecoveryStartMsRef.current = null
                if (!lagCameraHoldActiveRef.current) {
                  const stableCamera = stableGameplayCameraRef.current
                  lagCameraHoldQRef.current = {
                    ...(stableCamera.active ? stableCamera.q : rawGameplayCamera.q),
                  }
                  lagCameraHoldActiveRef.current = true
                  lagCameraRecoveryFromQRef.current = { ...lagCameraHoldQRef.current }
                }
                const spikeFollowAlpha =
                  1 - Math.exp(-tuning.netCameraSpikeFollowRate * Math.max(0, frameDeltaSeconds))
                lagCameraHoldQRef.current = slerpQuaternion(
                  lagCameraHoldQRef.current,
                  rawGameplayCamera.q,
                  spikeFollowAlpha,
                )
                gameplayCamera = {
                  active: true,
                  q: lagCameraHoldQRef.current,
                }
              } else if (lagCameraHoldActiveRef.current) {
                if (lagCameraRecoveryStartMsRef.current === null) {
                  lagCameraRecoveryStartMsRef.current = nowMs
                  lagCameraRecoveryFromQRef.current = { ...lagCameraHoldQRef.current }
                }
                const recoveryElapsed = nowMs - lagCameraRecoveryStartMsRef.current
                const recoveryBlend = clamp(recoveryElapsed / tuning.netCameraRecoveryMs, 0, 1)
                const easedRecovery = easeInOutCubic(recoveryBlend)
                gameplayCamera = {
                  active: true,
                  q: slerpQuaternion(
                    lagCameraRecoveryFromQRef.current,
                    rawGameplayCamera.q,
                    easedRecovery,
                  ),
                }
                if (recoveryBlend >= 0.999) {
                  lagCameraHoldActiveRef.current = false
                  lagCameraRecoveryStartMsRef.current = null
                }
              }

              if (gameplayCamera.active && !hardSpikeActive) {
                stableGameplayCameraRef.current = {
                  active: true,
                  q: { ...gameplayCamera.q },
                }
              }
            } else {
              lagCameraHoldActiveRef.current = false
              lagCameraRecoveryStartMsRef.current = null
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
                  sendJoin(socket, true)
                }
                setShowPlayAgain(true)
                setMenuPhase('preplay')
              }
            }

            cameraRef.current = renderCamera
            renderCameraDistanceRef.current = renderDistance
            renderCameraVerticalOffsetRef.current = renderVerticalOffset
            localHeadRef.current = hasSpawnedSnake && localHead ? normalize(localHead) : MENU_CAMERA_TARGET
            if (!hasSpawnedSnake) {
              pointerRef.current.active = false
              webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
              clearBoostInputs()
            }
	            boostActive =
	              inputEnabledRef.current &&
	              !!localSnapshotPlayer &&
	              localSnapshotPlayer.alive &&
	              localSnapshotPlayer.isBoosting

	            if (rafPerfEnabled) {
	              afterCameraMs = performance.now()
	            }

              const uiMode = menuUiModeRef.current
              const showSkinPreview =
                phase === 'preplay' && uiMode !== 'home' && !menuOverlayExitingRef.current
              webgl.setMenuPreviewVisible(showSkinPreview)
              if (showSkinPreview) {
                if (uiMode === 'builder') {
                  const pattern = builderPatternRef.current
                  const colors: string[] = []
                  for (let i = 0; i < pattern.length; i += 1) {
                    const entry = pattern[i]
                    if (!entry) break
                    colors.push(entry)
                  }
                  const previewColors = colors.length ? colors : [builderPaletteColorRef.current]
                  webgl.setMenuPreviewSkin(previewColors, 8)
                } else {
                  webgl.setMenuPreviewSkin(joinSkinColorsRef.current, 8)
                }
              }

	            const headScreen = webgl.render(
	              snapshot,
	              renderCamera,
	              localId,
	              renderDistance,
	              renderVerticalOffset,
	            )
	            if (rafPerfEnabled) {
	              afterRenderMs = performance.now()
	            }
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
                const spawnReserveFloor = scoreRadialState.spawnReserve ?? currentReserve
                const reserveAboveFloor = Math.max(0, currentReserve - spawnReserveFloor)
                const depleted = reserveAboveFloor <= SCORE_RADIAL_DEPLETION_EPS
                if (
                  scoreRadialState.lastBoosting &&
                  !scoreRadialActive &&
                  localSnapshotPlayer.alive &&
                  attemptingBoost
                ) {
                  if (scoreBlockedByThreshold || depleted) {
                    scoreRadialState.blockedFlashUntilMs = nowMs + SCORE_RADIAL_BLOCKED_FLASH_MS
                  }
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
                    (attemptingBoost && nowMs < scoreRadialState.blockedFlashUntilMs)
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
                  null,
                  headScreen,
                  null,
                  null,
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

	            if (rafPerfEnabled) {
	              afterHudMs = performance.now()
	            }

	            menuDebugInfoRef.current = {
	              phase,
	              hasSpawned: hasSpawnedSnake,
	              cameraBlend: phase === 'playing' ? 1 : blend,
              cameraDistance: Math.hypot(renderDistance, renderVerticalOffset),
            }
            if (netDebugEnabled && phase === 'playing') {
              const elapsedSinceSummary = nowMs - lastNetSummaryLogMsRef.current
              if (elapsedSinceSummary >= 5000) {
                const netInfo = netDebugInfoRef.current
                const motionInfo = motionDebugInfoRef.current
                appendNetLagEvent(
                  'summary',
                  `summary lag=${netInfo.lagSpikeActive ? '1' : '0'} cause=${netInfo.lagSpikeCause} delay=${netInfo.playoutDelayMs.toFixed(1)}ms boost=${netInfo.delayBoostMs.toFixed(1)}ms jitter=${netInfo.jitterMs.toFixed(1)}ms jitterDelay=${netInfo.jitterDelayMs.toFixed(1)}ms interval=${netInfo.receiveIntervalMs.toFixed(1)}ms stale=${netInfo.staleMs.toFixed(1)}ms impair=${netInfo.impairmentMsRemaining.toFixed(0)}ms tuningRev=${netInfo.tuningRevision} backward=${motionInfo.backwardCorrectionCount}/${motionInfo.sampleCount} minDot=${motionInfo.minHeadDot.toFixed(4)}`,
                )
                console.info(
                  `[net] summary lag=${netInfo.lagSpikeActive} cause=${netInfo.lagSpikeCause} delay=${netInfo.playoutDelayMs.toFixed(1)}ms boost=${netInfo.delayBoostMs.toFixed(1)}ms jitter=${netInfo.jitterMs.toFixed(1)}ms jitterDelay=${netInfo.jitterDelayMs.toFixed(1)}ms interval=${netInfo.receiveIntervalMs.toFixed(1)}ms stale=${netInfo.staleMs.toFixed(1)}ms impair=${netInfo.impairmentMsRemaining.toFixed(0)}ms tuningRev=${netInfo.tuningRevision} backward=${motionInfo.backwardCorrectionCount}/${motionInfo.sampleCount} minDot=${motionInfo.minHeadDot.toFixed(4)}`,
                )
                lastNetSummaryLogMsRef.current = nowMs
              }
            }
            if (typeof window !== 'undefined') {
              const debugApi = (
                window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }
              ).__SNAKE_DEBUG__
              const rootDebugApi =
                debugApi && typeof debugApi === 'object'
                  ? debugApi
                  : ((window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }).__SNAKE_DEBUG__ = {})
              if (rootDebugApi && typeof rootDebugApi === 'object') {
                ;(rootDebugApi as { getMenuFlowInfo?: () => MenuFlowDebugInfo }).getMenuFlowInfo = () => ({
                  ...menuDebugInfoRef.current,
                })
                ;(
                  rootDebugApi as {
                    getNetSmoothingInfo?: () => NetSmoothingDebugInfo
                  }
                ).getNetSmoothingInfo = () => ({
                  ...netDebugInfoRef.current,
                })
                ;(
                  rootDebugApi as {
                    getMotionStabilityInfo?: () => MotionStabilityDebugInfo
                  }
                ).getMotionStabilityInfo = () => ({
                  ...motionDebugInfoRef.current,
                })
                ;(
                  rootDebugApi as {
                    getNetLagEvents?: () => NetLagEvent[]
                  }
                ).getNetLagEvents = () => netLagEventsRef.current.slice()
                ;(
                  rootDebugApi as {
                    getNetLagReport?: () => NetLagReport
                  }
                ).getNetLagReport = () => buildNetLagReport()
                ;(
                  rootDebugApi as {
                    clearNetLagEvents?: () => void
                  }
                ).clearNetLagEvents = () => {
                  netLagEventsRef.current = []
                  netLagEventIdRef.current = 1
                }
                ;(
                  rootDebugApi as {
                    getTailGrowthEvents?: () => TailGrowthEvent[]
                  }
                ).getTailGrowthEvents = () => tailGrowthEventsRef.current.slice()
                ;(
                  rootDebugApi as {
                    getTailGrowthReport?: () => TailGrowthReport
                  }
                ).getTailGrowthReport = () => buildTailGrowthReport()
                ;(
                  rootDebugApi as {
                    clearTailGrowthEvents?: () => void
                  }
	                ).clearTailGrowthEvents = () => {
	                  tailGrowthEventsRef.current = []
	                  tailGrowthEventIdRef.current = 1
	                  lastTailRenderSampleAtMsRef.current = null
	                  lastTailEndSampleRef.current = null
	                }
                ;(
                  rootDebugApi as {
                    getNetTuningOverrides?: () => NetTuningOverrides
                  }
                ).getNetTuningOverrides = () => ({
                  ...netTuningOverridesRef.current,
                })
                ;(
                  rootDebugApi as {
                    getResolvedNetTuning?: () => typeof DEFAULT_NET_TUNING
                  }
                ).getResolvedNetTuning = () => ({
                  ...netTuningRef.current,
                })
                ;(
                  rootDebugApi as {
                    setNetTuningOverrides?: (
                      overrides: NetTuningOverrides,
                    ) => {
                      revision: number
                      overrides: NetTuningOverrides
                      resolved: typeof DEFAULT_NET_TUNING
                    }
                  }
                ).setNetTuningOverrides = (overrides) =>
                  applyNetTuningOverrides(overrides, { announce: true })
                ;(
                  rootDebugApi as {
                    resetNetTuningOverrides?: () => {
                      revision: number
                      overrides: NetTuningOverrides
                      resolved: typeof DEFAULT_NET_TUNING
                    }
                  }
                ).resetNetTuningOverrides = () =>
                  applyNetTuningOverrides({}, { announce: true })
                ;(
                  rootDebugApi as {
                    getRafPerfInfo?: () => RafPerfInfo
                  }
                ).getRafPerfInfo = () => ({
                  ...rafPerfRef.current,
                  lastFrame: rafPerfRef.current.lastFrame
                    ? { ...rafPerfRef.current.lastFrame }
                    : null,
                  slowFrames: rafPerfRef.current.slowFrames.map((frame) => ({ ...frame })),
                })
                ;(
                  rootDebugApi as {
                    clearRafPerf?: () => void
                  }
                ).clearRafPerf = () => {
                  const enabled = rafPerfRef.current.enabled
                  const thresholdMs = rafPerfRef.current.thresholdMs
                  rafPerfRef.current = {
                    enabled,
                    thresholdMs,
                    frameCount: 0,
                    slowFrameCount: 0,
                    maxTotalMs: 0,
                    lastFrame: null,
                    slowFrames: [],
                    lastSlowLogMs: 0,
                  }
                }
              }
            }
	          }
	          if (rafPerfEnabled && frameStartMs > 0) {
	            afterDebugMs = performance.now()
	          }
	          updateBoostFxVisual(boostActive)
	          if (rafPerfEnabled && frameStartMs > 0 && afterSnapshotMs > 0) {
	            const frameEndMs = performance.now()
	            const totalMs = frameEndMs - frameStartMs
	            const threshold = rafPerf.thresholdMs
	            const snapshotMs = afterSnapshotMs - frameStartMs
	            const cameraMs = afterCameraMs - afterSnapshotMs
	            const renderMs = afterRenderMs - afterCameraMs
	            const hudMs = afterHudMs - afterRenderMs
	            const debugMs = afterDebugMs - afterHudMs
	            const tailMs = frameEndMs - afterDebugMs

	            rafPerf.frameCount += 1
	            rafPerf.maxTotalMs = Math.max(rafPerf.maxTotalMs, totalMs)
	            rafPerf.lastFrame = {
	              tMs: nowMs,
	              totalMs,
	              snapshotMs,
	              cameraMs,
	              renderMs,
	              hudMs,
	              debugMs,
	              tailMs,
	            }

	            if (totalMs >= threshold) {
	              rafPerf.slowFrameCount += 1
	              rafPerf.slowFrames.push({ ...rafPerf.lastFrame })
	              if (rafPerf.slowFrames.length > RAF_SLOW_FRAMES_MAX) {
	                rafPerf.slowFrames.splice(0, rafPerf.slowFrames.length - RAF_SLOW_FRAMES_MAX)
	              }

		              // Throttle warnings to avoid turning perf debugging into the perf problem.
		              if (nowMs - rafPerf.lastSlowLogMs >= 1000) {
		                rafPerf.lastSlowLogMs = nowMs
		                console.warn(
		                  `[raf] slow frame ${totalMs.toFixed(1)}ms (snapshot ${snapshotMs.toFixed(
		                    1,
		                  )}ms camera ${cameraMs.toFixed(1)}ms render ${renderMs.toFixed(
		                    1,
		                  )}ms hud ${hudMs.toFixed(1)}ms debug ${debugMs.toFixed(1)}ms tail ${tailMs.toFixed(1)}ms)`,
		                )
		                try {
		                  const debugApi = (
		                    window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }
		                  ).__SNAKE_DEBUG__
		                  const getRenderPerfInfo = debugApi && (debugApi as { getRenderPerfInfo?: unknown }).getRenderPerfInfo
		                  if (typeof getRenderPerfInfo === 'function') {
		                    const perf = (getRenderPerfInfo as () => { lastFrame?: unknown })()
		                    const frame = perf?.lastFrame as
		                      | {
		                          totalMs: number
		                          setupMs: number
		                          snakesMs: number
		                          pelletsMs: number
		                          visibilityMs: number
		                          waterMs: number
		                          passWorldMs: number
		                          passOccludersMs: number
		                          passPelletsMs: number
		                          passDepthRebuildMs: number
		                          passLakesMs: number
		                        }
		                      | null
		                    const getRendererInfo =
		                      debugApi && (debugApi as { getRendererInfo?: unknown }).getRendererInfo
		                    const rendererInfo =
		                      typeof getRendererInfo === 'function'
		                        ? (getRendererInfo as () => { activeBackend?: string; webglShaderHooksEnabled?: boolean })()
		                        : null
		                    if (frame) {
		                      console.warn(
		                        `[render] backend=${rendererInfo?.activeBackend ?? 'unknown'} hooks=${
		                          typeof rendererInfo?.webglShaderHooksEnabled === 'boolean'
		                            ? rendererInfo.webglShaderHooksEnabled
		                              ? 1
		                              : 0
		                            : '?'
		                        } total=${frame.totalMs.toFixed(1)}ms setup=${frame.setupMs.toFixed(
		                          1,
		                        )} snakes=${frame.snakesMs.toFixed(1)} pellets=${frame.pelletsMs.toFixed(
		                          1,
		                        )} vis=${frame.visibilityMs.toFixed(1)} water=${frame.waterMs.toFixed(
		                          1,
		                        )} passWorld=${frame.passWorldMs.toFixed(
		                          1,
		                        )} passOcc=${frame.passOccludersMs.toFixed(
		                          1,
		                        )} passPel=${frame.passPelletsMs.toFixed(
		                          1,
		                        )} passDepth=${frame.passDepthRebuildMs.toFixed(
		                          1,
		                        )} passLakes=${frame.passLakesMs.toFixed(1)} players=${
		                          snapshotPlayerCount
		                        } pellets=${snapshotPelletCount}`,
		                      )
		                    }
		                  }
		                } catch {
		                  // Ignore perf log errors; raf perf is opt-in debug-only.
		                }
		              }
		            }
		          }
              // Adaptive quality: dynamic DPR (and WebGPU offscreen MSAA) to keep frametime stable.
              const adaptive = adaptiveQualityRef.current
              if (config && webgl && adaptive.enabled && updateConfig) {
                const frameMs = clamp(frameDeltaSeconds * 1000, 0, 100)
                const alpha = 0.08
                adaptive.ewmaFrameMs = adaptive.ewmaFrameMs * (1 - alpha) + frameMs * alpha
                const adjustIntervalMs = 250
                if (adaptive.lastAdjustAtMs <= 0) {
                  adaptive.lastAdjustAtMs = nowMs
                }
                if (nowMs - adaptive.lastAdjustAtMs >= adjustIntervalMs) {
                  adaptive.lastAdjustAtMs = nowMs
                  const baseMaxDpr = Math.min(window.devicePixelRatio || 1, 2)
                  const maxDpr = Math.min(baseMaxDpr, adaptive.maxDprCap)
                  const minDpr = adaptive.minDpr
                  if (!Number.isFinite(adaptive.currentDpr) || adaptive.currentDpr <= 0) {
                    adaptive.currentDpr = maxDpr
                  }

                  let nextDpr = adaptive.currentDpr
                  const step = 0.05
                  if (adaptive.ewmaFrameMs > 18 && adaptive.currentDpr > minDpr + 1e-3) {
                    nextDpr = Math.max(minDpr, adaptive.currentDpr - step)
                  } else if (adaptive.ewmaFrameMs < 14 && adaptive.currentDpr < maxDpr - 1e-3) {
                    nextDpr = Math.min(maxDpr, adaptive.currentDpr + step)
                  }
                  nextDpr = Math.round(nextDpr * 100) / 100
                  if (Math.abs(nextDpr - adaptive.currentDpr) > 1e-6) {
                    adaptive.currentDpr = nextDpr
                    updateConfig()
                  }

                  const setSamples = webgl.setWebgpuWorldSamples
                  if (typeof setSamples === 'function') {
                    const atMinDpr = adaptive.currentDpr <= minDpr + 0.01
                    if (adaptive.webgpuSamples > 1) {
                      if (
                        atMinDpr &&
                        adaptive.ewmaFrameMs > 22 &&
                        nowMs - adaptive.webgpuLastChangeMs > 2000
                      ) {
                        adaptive.webgpuSamples = 1
                        adaptive.webgpuLastChangeMs = nowMs
                        setSamples(1)
                      }
                    } else {
                      if (adaptive.ewmaFrameMs < 16 && nowMs - adaptive.webgpuLastChangeMs > 10_000) {
                        adaptive.webgpuSamples = 4
                        adaptive.webgpuLastChangeMs = nowMs
                        setSamples(4)
                      }
                    }
                  }
                }
              }
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
      localSnakeDisplayRef.current = null
      lastRenderFrameMsRef.current = null
      resetBoostFxVisual()
    }
    // Renderer swaps are intentionally triggered by explicit backend preference only.
  }, [
    rendererPreference,
    getRenderSnapshot,
    netDebugEnabled,
    appendNetLagEvent,
    buildNetLagReport,
    stabilizeLocalSnapshot,
    applyNetTuningOverrides,
  ])

  useEffect(() => {
    let reconnectTimer: number | null = null
    let cancelled = false

    const connect = async () => {
      if (cancelled) return
      snapshotBufferRef.current = []
      serverOffsetRef.current = null
      serverTickMsRef.current = 50
      lastSnapshotTimeRef.current = null
      lastSnapshotReceivedAtRef.current = null
      receiveIntervalMsRef.current = 50
      receiveJitterMsRef.current = 0
      receiveJitterDelayMsRef.current = 0
      playoutDelayMsRef.current = 100
      delayBoostMsRef.current = 0
      lastDelayUpdateMsRef.current = null
      latestSeqRef.current = null
      seqGapDetectedRef.current = false
      lastSeqGapAtMsRef.current = null
      lagSpikeActiveRef.current = false
      lagSpikeCauseRef.current = 'none'
      lagSpikeEnterCandidateAtMsRef.current = null
      lagSpikeExitCandidateAtMsRef.current = null
      lagSpikeArrivalGapCooldownUntilMsRef.current = 0
      lagImpairmentUntilMsRef.current = 0
      netTuningRef.current = resolveNetTuning(netTuningOverridesRef.current)
      tickIntervalRef.current = 50
      playerMetaRef.current = new Map()
      resetScoreRadialState(scoreRadialStateRef.current)
      netDebugInfoRef.current = {
        lagSpikeActive: false,
        lagSpikeCause: 'none',
        playoutDelayMs: 100,
        delayBoostMs: 0,
        jitterDelayMs: 0,
        jitterMs: 0,
        receiveIntervalMs: 50,
        staleMs: 0,
        impairmentMsRemaining: 0,
        maxExtrapolationMs: MAX_EXTRAPOLATION_MS,
        latestSeq: null,
        seqGapDetected: false,
        tuningRevision: netTuningRevisionRef.current,
        tuningOverrides: { ...netTuningOverridesRef.current },
      }
      motionDebugInfoRef.current = {
        backwardCorrectionCount: 0,
        minHeadDot: 1,
        sampleCount: 0,
      }
      netLagEventsRef.current = []
      netLagEventIdRef.current = 1
      lastNetSummaryLogMsRef.current = 0
      lastHeadSampleRef.current = null
      localSnakeDisplayRef.current = null
      lastRenderFrameMsRef.current = null
      localHeadRef.current = MENU_CAMERA_TARGET
      stableGameplayCameraRef.current = { q: { ...MENU_CAMERA.q }, active: true }
      lagCameraHoldActiveRef.current = false
      lagCameraHoldQRef.current = { ...MENU_CAMERA.q }
      lagCameraRecoveryStartMsRef.current = null
      lagCameraRecoveryFromQRef.current = { ...MENU_CAMERA.q }
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
      if (menuOverlayExitTimerRef.current !== null) {
        window.clearTimeout(menuOverlayExitTimerRef.current)
        menuOverlayExitTimerRef.current = null
      }
      setMenuOverlayExiting(false)
      pointerRef.current.active = false
      webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
      clearBoostInputs()
      setConnectionStatus('Matchmaking')
      setGameState(null)
      setEnvironment(null)
      setMenuPhase('preplay')

      let assignedRoom = roomName
      let roomToken = ''
      try {
        const assignment = await requestMatchmake(roomName)
        assignedRoom = assignment.roomId
        roomToken = assignment.roomToken
      } catch {
        if (cancelled) return
        setConnectionStatus('Reconnecting')
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, 1500)
        return
      }

      if (cancelled) return
      if (assignedRoom !== roomName) {
        setRoomInput(assignedRoom)
        setRoomName(assignedRoom)
        return
      }
      setRoomInput((previous) => (previous === assignedRoom ? previous : assignedRoom))

      const socket = new WebSocket(
        resolveWebSocketUrl(
          `/api/room/${encodeURIComponent(assignedRoom)}?rt=${encodeURIComponent(roomToken)}`,
        ),
      )
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

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
	          playerIdRef.current = decoded.playerId
	          storePlayerId(decoded.playerId)
	          if (Number.isFinite(decoded.tickMs) && decoded.tickMs > 0) {
	            const normalizedTickMs = Math.max(16, decoded.tickMs)
            serverTickMsRef.current = normalizedTickMs
            tickIntervalRef.current = normalizedTickMs
            receiveIntervalMsRef.current = normalizedTickMs
            netDebugInfoRef.current = {
              ...netDebugInfoRef.current,
              receiveIntervalMs: normalizedTickMs,
            }
          }
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
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, 1500)
      })

      socket.addEventListener('error', () => {
        socket.close()
      })
    }

    void connect()

    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [roomName, pushSnapshot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && inputEnabledRef.current) {
        event.preventDefault()
        boostInputRef.current.keyboard = true
        syncBoostInput()
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault()
        boostInputRef.current.keyboard = false
        syncBoostInput()
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
      if (menuOverlayExitTimerRef.current !== null) {
        window.clearTimeout(menuOverlayExitTimerRef.current)
      }
      menuOverlayExitTimerRef.current = null
    }
  }, [])

  const updatePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = glCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    pointerRef.current.screenX = localX
    pointerRef.current.screenY = localY
    const active = inputEnabledRef.current
    pointerRef.current.active = active
    webglRef.current?.setPointerScreen?.(localX, localY, active)
  }

  const startInputLoop = () => {
    if (sendIntervalRef.current !== null) return
    sendIntervalRef.current = window.setInterval(() => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      const axis =
        inputEnabledRef.current && pointerRef.current.active
          ? webglRef.current?.getPointerAxis?.() ?? null
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
    socket.send(
      encodeJoin(
        playerNameRef.current,
        playerIdRef.current,
        deferSpawn,
        joinSkinColorsRef.current,
      ),
    )
  }

  const isPointerBoostButtonPressed = (event: React.PointerEvent<HTMLCanvasElement>) =>
    (event.buttons & (1 | 2)) !== 0

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    updatePointer(event)
    setPointerButtonBoostInput(inputEnabledRef.current && isPointerBoostButtonPressed(event))
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    updatePointer(event)
    setPointerButtonBoostInput(inputEnabledRef.current && isPointerBoostButtonPressed(event))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setPointerButtonBoostInput(inputEnabledRef.current && isPointerBoostButtonPressed(event))
  }

  const handlePointerLeave = () => {
    pointerRef.current.active = false
    pointerRef.current.screenX = Number.NaN
    pointerRef.current.screenY = Number.NaN
    webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
    setPointerButtonBoostInput(false)
  }

  const handlePointerCancel = () => {
    pointerRef.current.active = false
    pointerRef.current.screenX = Number.NaN
    pointerRef.current.screenY = Number.NaN
    webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
    setPointerButtonBoostInput(false)
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
    if (menuOverlayExitTimerRef.current !== null) {
      window.clearTimeout(menuOverlayExitTimerRef.current)
      menuOverlayExitTimerRef.current = null
    }
    setMenuOverlayExiting(false)

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
    if (menuOverlayExiting) return
    if (menuUiModeRef.current !== 'home') {
      setMenuUiMode('home')
    }

    const trimmedName = playerName.trim()
    const nextName = trimmedName || createRandomPlayerName()
    if (nextName !== playerName) {
      setPlayerName(nextName)
    }
    playerNameRef.current = nextName

    allowPreplayAutoResumeRef.current = false
    setMenuOverlayExiting(true)

    if (menuOverlayExitTimerRef.current !== null) {
      window.clearTimeout(menuOverlayExitTimerRef.current)
      menuOverlayExitTimerRef.current = null
    }

    menuOverlayExitTimerRef.current = window.setTimeout(() => {
      menuOverlayExitTimerRef.current = null

      const activeSocket = socketRef.current
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        setMenuOverlayExiting(false)
        return
      }

      pointerRef.current.active = false
      webglRef.current?.setPointerScreen?.(Number.NaN, Number.NaN, false)
      clearBoostInputs()
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
      setMenuOverlayExiting(false)
      setMenuPhase('spawning')

      sendJoin(activeSocket, true)
      activeSocket.send(encodeRespawn())
    }, MENU_OVERLAY_FADE_OUT_MS)
  }

  const refreshSkinDesigns = () => {
    setSkinDesigns(getSavedSkinDesigns())
  }

  const resetMenuPreviewOrbit = () => {
    const orbit = menuPreviewOrbitRef.current
    orbit.yaw = -0.35
    orbit.pitch = 0.08
    webglRef.current?.setMenuPreviewOrbit(orbit.yaw, orbit.pitch)
  }

  const handleOpenSkin = () => {
    if (menuOverlayExiting || menuPhaseRef.current !== 'preplay') return
    resetMenuPreviewOrbit()
    setMenuUiMode('skin')
  }

  const cyclePaletteIndex = (index: number, delta: number) => {
    const count = SKIN_PALETTE_COLORS.length
    if (count <= 0) return 0
    const next = (index + delta) % count
    return next < 0 ? next + count : next
  }

  const stopMenuPreviewDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = menuPreviewDragRef.current
    if (!drag.active) return
    drag.active = false
    drag.pointerId = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleMenuPreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (menuOverlayExitingRef.current) return
    if (menuPhaseRef.current !== 'preplay') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const drag = menuPreviewDragRef.current
    drag.active = true
    drag.pointerId = event.pointerId
    drag.lastX = event.clientX
    drag.lastY = event.clientY
  }

  const handleMenuPreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = menuPreviewDragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY

    const orbit = menuPreviewOrbitRef.current
    const sensitivity = 0.006
    orbit.yaw += dx * sensitivity
    orbit.pitch = clamp(orbit.pitch + dy * sensitivity, -1.25, 1.25)
    webglRef.current?.setMenuPreviewOrbit(orbit.yaw, orbit.pitch)
  }

  const handleMenuPreviewPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    stopMenuPreviewDrag(event)
  }

  const handleMenuPreviewPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    stopMenuPreviewDrag(event)
  }

  const handleMenuPreviewPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    stopMenuPreviewDrag(event)
  }

  const handleSolidPrev = () => {
    const nextIndex = cyclePaletteIndex(solidPaletteIndex, -1)
    const nextColor = SKIN_PALETTE_COLORS[nextIndex] ?? solidPaletteColor
    setSolidPaletteIndex(nextIndex)
    setSelectedSkin({ kind: 'solid', color: nextColor })
  }

  const handleSolidNext = () => {
    const nextIndex = cyclePaletteIndex(solidPaletteIndex, 1)
    const nextColor = SKIN_PALETTE_COLORS[nextIndex] ?? solidPaletteColor
    setSolidPaletteIndex(nextIndex)
    setSelectedSkin({ kind: 'solid', color: nextColor })
  }

  const handleSelectSolid = (color: string) => {
    setSelectedSkin({ kind: 'solid', color })
  }

  const handleSelectDesign = (id: string) => {
    setSelectedSkin({ kind: 'design', id })
  }

  const handleDeleteDesign = (id: string) => {
    if (typeof window !== 'undefined') {
      const design = skinDesigns.find((d) => d.id === id)
      const confirmed = window.confirm(`Delete design "${design?.name ?? 'Unnamed'}"?`)
      if (!confirmed) return
    }
    deleteSkinDesign(id)
    refreshSkinDesigns()
    if (selectedSkin.kind === 'design' && selectedSkin.id === id) {
      setSelectedSkin(DEFAULT_SOLID_SKIN)
    }
  }

  const resetBuilder = () => {
    builderPaletteIndexRef.current = 0
    setBuilderPaletteColor(SKIN_PALETTE_COLORS[0] ?? '#ffffff')
    setBuilderPattern(new Array(SNAKE_PATTERN_LEN).fill(null))
    setBuilderDesignName('')
  }

  const handleStartBuilder = () => {
    resetBuilder()
    resetMenuPreviewOrbit()
    setMenuUiMode('builder')
  }

  const handleBuilderPrev = () => {
    const nextIndex = cyclePaletteIndex(builderPaletteIndexRef.current, -1)
    builderPaletteIndexRef.current = nextIndex
    setBuilderPaletteColor(SKIN_PALETTE_COLORS[nextIndex] ?? builderPaletteColorRef.current)
  }

  const handleBuilderNext = () => {
    const nextIndex = cyclePaletteIndex(builderPaletteIndexRef.current, 1)
    builderPaletteIndexRef.current = nextIndex
    setBuilderPaletteColor(SKIN_PALETTE_COLORS[nextIndex] ?? builderPaletteColorRef.current)
  }

  const handleBuilderPickColor = (value: string) => {
    const normalized = value.trim().toLowerCase()
    setBuilderPaletteColor(normalized)
    const idx = SKIN_PALETTE_COLORS.findIndex((color) => color.toLowerCase() === normalized)
    if (idx >= 0) builderPaletteIndexRef.current = idx
  }

  const handleBuilderAddColor = () => {
    setBuilderPattern((current) => {
      const next = current.slice(0, SNAKE_PATTERN_LEN)
      const idx = next.findIndex((c) => !c)
      if (idx === -1) return next
      next[idx] = builderPaletteColorRef.current
      return next
    })
  }

  const handleBuilderPaintSlot = (index: number) => {
    setBuilderPattern((current) => {
      const next = current.slice(0, SNAKE_PATTERN_LEN)
      if (!next[index]) return next
      next[index] = builderPaletteColorRef.current
      return next
    })
  }

  const handleBuilderSave = () => {
    if (skinDesigns.length >= MAX_SAVED_SKIN_DESIGNS) return
    const seed: string[] = []
    for (let i = 0; i < SNAKE_PATTERN_LEN; i += 1) {
      const entry = builderPattern[i]
      if (typeof entry === 'string' && entry) {
        seed.push(entry)
        continue
      }
      break
    }
    if (seed.length < 1) return
    const colors: string[] = []
    for (let i = 0; i < SNAKE_PATTERN_LEN; i += 1) {
      colors.push(seed[i % seed.length] ?? seed[0] ?? '#ffffff')
    }
    const design = createSkinDesign(builderDesignName, colors)
    if (!design) return
    const saved = saveSkinDesign(design)
    if (!saved.ok) {
      if (typeof window !== 'undefined' && saved.error === 'max') {
        window.alert('Max designs reached. Delete one to save a new design.')
      }
      return
    }
    refreshSkinDesigns()
    setSelectedSkin({ kind: 'design', id: design.id })
    setMenuUiMode('skin')
    resetBuilder()
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
              onPointerCancel={handlePointerCancel}
              onContextMenu={(event) => event.preventDefault()}
            />
            <canvas ref={hudCanvasRef} className='hud-canvas' aria-hidden='true' />
            <div ref={boostFxRef} className='boost-fx' aria-hidden='true' />
          </div>
          {showMenuOverlay && menuUiMode === 'home' && (
            <MenuOverlay
              playerName={playerName}
              playLabel={showPlayAgain ? 'Play again' : 'Play'}
              isExiting={menuOverlayExiting}
              connectionStatus={connectionStatus}
              menuPhase={menuPhase}
              onPlayerNameChange={setPlayerName}
              onPlay={handlePlay}
              onChangeSkin={handleOpenSkin}
            />
          )}
          {showMenuOverlay && menuUiMode === 'skin' && (
            <SkinOverlay
              isExiting={menuOverlayExiting}
              solidColor={solidPaletteColor}
              selected={selectedSkin}
              designs={skinDesigns}
              onPreviewPointerDown={handleMenuPreviewPointerDown}
              onPreviewPointerMove={handleMenuPreviewPointerMove}
              onPreviewPointerUp={handleMenuPreviewPointerUp}
              onPreviewPointerCancel={handleMenuPreviewPointerCancel}
              onPreviewPointerLeave={handleMenuPreviewPointerLeave}
              onSolidPrev={handleSolidPrev}
              onSolidNext={handleSolidNext}
              onSelectSolid={handleSelectSolid}
              onSelectDesign={handleSelectDesign}
              onDeleteDesign={handleDeleteDesign}
              onBuild={handleStartBuilder}
              onBack={() => setMenuUiMode('home')}
            />
          )}
          {showMenuOverlay && menuUiMode === 'builder' && (
            <SkinBuilderOverlay
              isExiting={menuOverlayExiting}
              paletteColor={builderPaletteColor}
              pattern={builderPattern}
              designName={builderDesignName}
              designsCount={skinDesigns.length}
              onPreviewPointerDown={handleMenuPreviewPointerDown}
              onPreviewPointerMove={handleMenuPreviewPointerMove}
              onPreviewPointerUp={handleMenuPreviewPointerUp}
              onPreviewPointerCancel={handleMenuPreviewPointerCancel}
              onPreviewPointerLeave={handleMenuPreviewPointerLeave}
              onPalettePrev={handleBuilderPrev}
              onPaletteNext={handleBuilderNext}
              onPalettePick={handleBuilderPickColor}
              onAddColor={handleBuilderAddColor}
              onPaintSlot={handleBuilderPaintSlot}
              onDesignNameChange={setBuilderDesignName}
              onSave={handleBuilderSave}
              onBack={() => {
                resetBuilder()
                setMenuUiMode('skin')
              }}
              onCancel={() => {
                resetBuilder()
                setMenuUiMode('home')
              }}
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
