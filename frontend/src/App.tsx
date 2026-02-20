import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  type DayNightDebugMode,
  type RenderScene,
} from './render/webglScene'
import type { Camera, Environment, GameStateSnapshot, PelletSnapshot, Point } from './game/types'
import { IDENTITY_QUAT, clamp } from './game/math'
import { axisFromPointer } from './game/camera'
import type { TimedSnapshot } from './game/snapshots'
import { type RenderConfig } from './game/hud'
import {
  getInitialRoom,
  getInitialName,
  getStoredPlayerId,
} from './game/storage'
import {
  encodeInputFast,
  encodeJoin,
  encodeView,
  type PlayerMeta,
} from './game/wsProtocol'
import {
  SKIN_PALETTE_COLORS,
  SNAKE_PATTERN_LEN,
  getSavedSkinDesigns,
  getSelectedSkin,
  resolveSelectedSkinColors,
  type SelectedSkinV1,
  type SnakeSkinDesignV1,
} from './game/skins'
import { readLocalStorageBool, readLocalStorageNumber } from '@shared/storage/localStorage'
import {
  CAMERA_DISTANCE_DEFAULT,
  DEFAULT_NET_TUNING,
  MAX_EXTRAPOLATION_MS,
  MENU_CAMERA_DISTANCE,
  MENU_CAMERA_VERTICAL_OFFSET,
  REALTIME_LEADERBOARD_LIMIT,
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
} from './app/core/debugSettings'
import { computeViewRadius } from './app/core/renderMath'
import {
  MENU_CAMERA,
  MENU_CAMERA_TARGET,
  type MenuFlowDebugInfo,
  type MenuPhase,
} from './app/core/menuCamera'
import { createInitialBoostFxState } from './app/core/boostFx'
import { ControlPanel } from './app/components/ControlPanel'
import { MenuOverlay } from './app/components/MenuOverlay'
import { SkinBuilderOverlay } from './app/components/SkinBuilderOverlay'
import { SkinOverlay } from './app/components/SkinOverlay'
import { RealtimeLeaderboard, type RealtimeLeaderboardEntry } from './app/components/RealtimeLeaderboard'
import type {
  CameraRotationStats,
  LagSpikeCause,
  MotionStabilityDebugInfo,
  NetLagEvent,
  NetSmoothingDebugInfo,
  RafPerfInfo,
  TailEndSample,
  TailGrowthEvent,
} from '@app/debug/types'
import { type AdaptiveQualityState } from '@app/orchestration/rendererLifecycle'
import { useGameConnection } from '@app/hooks/useGameConnection'
import { useGameLoop } from '@app/hooks/useGameLoop'
import { useInputControls } from '@app/hooks/useInputControls'
import { useAppStateSync } from '@app/hooks/useAppStateSync'
import { useMenuGameplayActions } from '@app/hooks/useMenuGameplayActions'
import { useNetRuntime } from '@app/hooks/useNetRuntime'
import { usePointerCanvasControls } from '@app/hooks/usePointerCanvasControls'
import { useRendererSceneRuntime } from '@app/hooks/useRendererSceneRuntime'
import { useMenuFlow } from '@app/hooks/useMenuFlow'
import { useSkinFlow } from '@app/hooks/useSkinFlow'
import { useSkinMenuActions } from '@app/hooks/useSkinMenuActions'
import { useSocketConnectionRuntime } from '@app/hooks/useSocketConnectionRuntime'

type MenuUiMode = 'home' | 'skin' | 'builder'

const LOCAL_STORAGE_ADAPTIVE_QUALITY = 'spherical_snake_adaptive_quality'
const LOCAL_STORAGE_MIN_DPR = 'spherical_snake_min_dpr'
const LOCAL_STORAGE_MAX_DPR = 'spherical_snake_max_dpr'
const LEGACY_LOCAL_STORAGE_RENDERER = 'spherical_snake_renderer'
const LEGACY_LOCAL_STORAGE_WEBGPU_MSAA_SAMPLES = 'spherical_snake_webgpu_msaa_samples'

export default function App() {
  const RAF_SLOW_FRAME_THRESHOLD_MS = 50

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
  const touchControlRef = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    pinchActive: false,
    pinchPrevDistancePx: null as number | null,
  })
  const joystickAxisRef = useRef<Point | null>(null)
  const joystickUiRef = useRef({
    active: false,
    pointerId: null as number | null,
    centerX: 0,
    centerY: 0,
    radius: 0,
    boostWanted: false,
  })
  const joystickRootRef = useRef<HTMLDivElement | null>(null)
  const boostInputRef = useRef({
    keyboard: false,
    pointerButton: false,
  })
  const sendIntervalRef = useRef<number | null>(null)
  const lastInputSignatureRef = useRef<string>('')
  const lastInputAxisRef = useRef<Point | null>(null)
  const lastInputSentAtMsRef = useRef(0)
  const lastViewSignatureRef = useRef<string>('')
  const lastViewSentAtMsRef = useRef(0)
  const snapshotBufferRef = useRef<TimedSnapshot[]>([])
  const serverOffsetRef = useRef<number | null>(null)
  const serverTickMsRef = useRef(50)
  const tickIntervalRef = useRef(50)
  const lastSnapshotTimeRef = useRef<number | null>(null)
  const lastSnapshotReceivedAtRef = useRef<number | null>(null)
  const receiveIntervalMsRef = useRef(50)
  const receiveJitterMsRef = useRef(0)
  const receiveJitterDelayMsRef = useRef(0)
  const netRxWindowStartMsRef = useRef<number | null>(null)
  const netRxWindowBytesRef = useRef(0)
  const netRxBpsRef = useRef(0)
  const netRxTotalBytesRef = useRef(0)
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
  const controlsCameraRef = useRef<Camera>({ q: { ...IDENTITY_QUAT }, active: false })
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
  const playerIdByNetIdRef = useRef<Map<number, string>>(new Map())
  const pelletMapRef = useRef<Map<number, PelletSnapshot>>(new Map())
  const pelletsArrayRef = useRef<PelletSnapshot[]>([])
  const pelletConsumeTargetsRef = useRef<Map<number, string>>(new Map())
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
  const cameraRotationStatsRef = useRef<CameraRotationStats>({
    sampleCount: 0,
    stepP95Deg: 0,
    stepMaxDeg: 0,
    reversalCount: 0,
    reversalRate: 0,
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
    minDpr: readLocalStorageNumber(LOCAL_STORAGE_MIN_DPR, 1, { min: 1, max: 2 }),
    maxDprCap: readLocalStorageNumber(LOCAL_STORAGE_MAX_DPR, 2, { min: 1, max: 2 }),
    currentDpr: 0,
    ewmaFrameMs: 16.7,
    lastAdjustAtMs: 0,
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
  const [connectionStatus, setConnectionStatus] = useState('Connecting')
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
  const predictionDebugPerturbation = useMemo(() => {
    if (typeof window === 'undefined') return false
    try {
      const url = new URL(window.location.href)
      const query = url.searchParams.get('predictionPerturb')
      return query === '1'
    } catch {
      // ignore URL parsing errors
      return false
    }
  }, [])
  const isPlaying = menuPhase === 'playing'
  const showMenuOverlay = menuPhase === 'preplay' || menuOverlayExiting
  const solidPaletteColor = SKIN_PALETTE_COLORS[solidPaletteIndex] ?? (SKIN_PALETTE_COLORS[0] ?? '#ffffff')

  useGameLoop(() => {
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

  useGameConnection(() => {
    if (typeof window === 'undefined') return
    const debugWindow = window as Window & { __SNAKE_DEBUG__?: Record<string, unknown> }
    if (!debugWindow.__SNAKE_DEBUG__ || typeof debugWindow.__SNAKE_DEBUG__ !== 'object') {
      debugWindow.__SNAKE_DEBUG__ = {}
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_RENDERER)
      window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_WEBGPU_MSAA_SAMPLES)
    } catch {
      // ignore localStorage access errors
    }

    try {
      const url = new URL(window.location.href)
      if (!url.searchParams.has('renderer')) return
      url.searchParams.delete('renderer')
      window.history.replaceState({}, '', url)
    } catch {
      // ignore URL parsing errors
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

  function sendInputSnapshot(force = false) {
    const INPUT_AXIS_DEADBAND_DEG = 0.05
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return

    const resolvePointerAxis = (): Point | null => {
      if (!pointerRef.current.active) return null
      const pointerX = pointerRef.current.screenX
      const pointerY = pointerRef.current.screenY
      const headScreen = headScreenRef.current
      if (
        headScreen &&
        Number.isFinite(pointerX) &&
        Number.isFinite(pointerY) &&
        Number.isFinite(headScreen.x) &&
        Number.isFinite(headScreen.y)
      ) {
        const dx = pointerX - headScreen.x
        const dy = pointerY - headScreen.y
        const distSq = dx * dx + dy * dy
        if (distSq >= 9) {
          return axisFromPointer(Math.atan2(dy, dx), controlsCameraRef.current)
        }
        return null
      }
      return webglRef.current?.getPointerAxis?.() ?? null
    }

    const rawAxis = inputEnabledRef.current
      ? joystickAxisRef.current ?? resolvePointerAxis()
      : null
    const axis =
      !force && rawAxis && lastInputAxisRef.current
        ? (() => {
            const previousAxis = lastInputAxisRef.current
            if (!previousAxis) return rawAxis
            const dotValue = clamp(
              rawAxis.x * previousAxis.x + rawAxis.y * previousAxis.y + rawAxis.z * previousAxis.z,
              -1,
              1,
            )
            const deltaDeg = (Math.acos(dotValue) * 180) / Math.PI
            return Number.isFinite(deltaDeg) && deltaDeg < INPUT_AXIS_DEADBAND_DEG
              ? previousAxis
              : rawAxis
          })()
        : rawAxis
    const nowMs = performance.now()
    const boost = inputEnabledRef.current && pointerRef.current.boost
    const axisSignature = axis
      ? `${axis.x.toFixed(4)},${axis.y.toFixed(4)},${axis.z.toFixed(4)}`
      : 'null'
    const inputSignature = `${axisSignature}|${boost ? 1 : 0}`
    const inputChanged = force || inputSignature !== lastInputSignatureRef.current
    const inputHeartbeat = nowMs - lastInputSentAtMsRef.current >= 100
    if (inputChanged || inputHeartbeat || lastInputSentAtMsRef.current === 0) {
      const inputSeq = enqueuePredictedInputCommand(axis, boost, nowMs)
      socket.send(encodeInputFast(axis, boost, inputSeq))
      lastInputSignatureRef.current = inputSignature
      lastInputAxisRef.current = axis ? { ...axis } : null
      lastInputSentAtMsRef.current = nowMs
    }

    const config = renderConfigRef.current
    const aspect = config && config.height > 0 ? config.width / config.height : 1
    const cameraDistance = renderCameraDistanceRef.current
    const cameraVerticalOffset = renderCameraVerticalOffsetRef.current
    const effectiveCameraDistance = Math.hypot(cameraDistance, cameraVerticalOffset)
    const viewRadius = computeViewRadius(effectiveCameraDistance, aspect)
    const center = localHeadRef.current
    const centerSignature = center
      ? `${center.x.toFixed(4)},${center.y.toFixed(4)},${center.z.toFixed(4)}`
      : 'null'
    const viewSignature = `${centerSignature}|${viewRadius.toFixed(4)}|${effectiveCameraDistance.toFixed(
      4,
    )}`
    const viewChanged = force || viewSignature !== lastViewSignatureRef.current
    const viewHeartbeat = nowMs - lastViewSentAtMsRef.current >= 250
    if (viewChanged || viewHeartbeat || lastViewSentAtMsRef.current === 0) {
      socket.send(encodeView(center, viewRadius, effectiveCameraDistance))
      lastViewSignatureRef.current = viewSignature
      lastViewSentAtMsRef.current = nowMs
    }
  }

  const syncBoostInput = () => {
    pointerRef.current.boost = boostInputRef.current.keyboard || boostInputRef.current.pointerButton
    sendInputSnapshot(true)
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

  useInputControls({
    inputEnabledRef,
    boostInputRef,
    sendIntervalRef,
    menuOverlayExitTimerRef,
    syncBoostInput,
  })

  const syncPelletConsumeTargetsToRenderer = () => {
    const webgl = webglRef.current
    if (!webgl || pelletConsumeTargetsRef.current.size <= 0) return
    webgl.queuePelletConsumeTargets?.(pelletConsumeTargetsRef.current)
    pelletConsumeTargetsRef.current.clear()
  }

  const clearPelletConsumeTargets = () => {
    pelletConsumeTargetsRef.current.clear()
    webglRef.current?.clearPelletConsumeTargets?.()
  }

  const {
    appendNetLagEvent,
    buildNetLagReport,
    appendTailGrowthEvent,
    applyNetTuningOverrides,
    enqueuePredictedInputCommand,
    resetPredictionState,
    pushSnapshot,
    getRenderSnapshot,
    stabilizeLocalSnapshot,
  } = useNetRuntime({
    netDebugEnabled,
    tailDebugEnabled,
    predictionDebugPerturbation,
    menuPhaseRef,
    menuDebugInfoRef,
    netDebugInfoRef,
    motionDebugInfoRef,
    netLagEventsRef,
    netLagEventIdRef,
    tailGrowthEventsRef,
    tailGrowthEventIdRef,
    netRxBpsRef,
    netRxTotalBytesRef,
    netRxWindowBytesRef,
    lastTailRenderSampleAtMsRef,
    lastTailEndSampleRef,
    rafPerfRef,
    netTuningOverridesRef,
    netTuningRef,
    netTuningRevisionRef,
    lagCameraHoldActiveRef,
    pointerRef,
    playerIdRef,
    snapshotBufferRef,
    serverOffsetRef,
    serverTickMsRef,
    tickIntervalRef,
    lastSnapshotTimeRef,
    lastSnapshotReceivedAtRef,
    receiveIntervalMsRef,
    receiveJitterMsRef,
    receiveJitterDelayMsRef,
    playoutDelayMsRef,
    delayBoostMsRef,
    lastDelayUpdateMsRef,
    latestSeqRef,
    seqGapDetectedRef,
    lastSeqGapAtMsRef,
    lagSpikeActiveRef,
    lagSpikeCauseRef,
    lagSpikeEnterCandidateAtMsRef,
    lagSpikeExitCandidateAtMsRef,
    lagSpikeArrivalGapCooldownUntilMsRef,
    lagImpairmentUntilMsRef,
    localSnakeDisplayRef,
    environmentRef,
    cameraRotationStatsRef,
  })

  useAppStateSync({
    playerId,
    playerIdRef,
    playerName,
    playerNameRef,
    menuUiMode,
    menuUiModeRef,
    menuOverlayExiting,
    menuOverlayExitingRef,
    environment,
    environmentRef,
    webglRef,
    mountainDebug,
    lakeDebug,
    treeDebug,
    terrainTessellationDebug,
    debugFlagsRef,
    dayNightDebugMode,
    dayNightDebugModeRef,
    roomName,
  })

  const startInputLoop = () => {
    if (sendIntervalRef.current !== null) return
    const intervalMs = 50
    sendIntervalRef.current = window.setInterval(() => {
      sendInputSnapshot(false)
    }, intervalMs)
    sendInputSnapshot(true)
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

  useSocketConnectionRuntime({
    roomName,
    pushSnapshot,
    snapshotBufferRef,
    serverOffsetRef,
    serverTickMsRef,
    lastSnapshotTimeRef,
    lastSnapshotReceivedAtRef,
    receiveIntervalMsRef,
    receiveJitterMsRef,
    receiveJitterDelayMsRef,
    netRxWindowStartMsRef,
    netRxWindowBytesRef,
    netRxBpsRef,
    netRxTotalBytesRef,
    lastInputSignatureRef,
    lastInputSentAtMsRef,
    lastViewSignatureRef,
    lastViewSentAtMsRef,
    playoutDelayMsRef,
    delayBoostMsRef,
    lastDelayUpdateMsRef,
    latestSeqRef,
    seqGapDetectedRef,
    lastSeqGapAtMsRef,
    lagSpikeActiveRef,
    lagSpikeCauseRef,
    lagSpikeEnterCandidateAtMsRef,
    lagSpikeExitCandidateAtMsRef,
    lagSpikeArrivalGapCooldownUntilMsRef,
    lagImpairmentUntilMsRef,
    netTuningRef,
    netTuningOverridesRef,
    tickIntervalRef,
    clearPelletConsumeTargets,
    playerMetaRef,
    playerIdByNetIdRef,
    pelletMapRef,
    pelletsArrayRef,
    netDebugInfoRef,
    netTuningRevisionRef,
    motionDebugInfoRef,
    netLagEventsRef,
    netLagEventIdRef,
    lastNetSummaryLogMsRef,
    lastHeadSampleRef,
    localSnakeDisplayRef,
    lastRenderFrameMsRef,
    localHeadRef,
    stableGameplayCameraRef,
    lagCameraHoldActiveRef,
    lagCameraHoldQRef,
    lagCameraRecoveryStartMsRef,
    lagCameraRecoveryFromQRef,
    renderCameraDistanceRef,
    renderCameraVerticalOffsetRef,
    cameraBlendRef,
    cameraBlendStartMsRef,
    returnBlendStartMsRef,
    returnFromCameraQRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    localLifeSpawnedRef,
    deathStartedAtMsRef,
    returnToMenuCommittedRef,
    allowPreplayAutoResumeRef,
    menuOverlayExitTimerRef,
    setMenuOverlayExiting,
    pointerRef,
    webglRef,
    clearBoostInputs,
    setConnectionStatus,
    setGameState,
    setEnvironment,
    setMenuPhase,
    setRoomInput,
    setRoomName,
    socketRef,
    sendJoin,
    startInputLoop,
    setPlayerId,
    playerIdRef,
    pelletConsumeTargetsRef,
    syncPelletConsumeTargetsToRenderer,
    resetPredictionState,
  })

  const {
    stopJoystick,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerLeave,
    handlePointerCancel,
    handleWheel,
  } = usePointerCanvasControls({
    glCanvasRef,
    renderConfigRef,
    webglRef,
    inputEnabledRef,
    pointerRef,
    touchControlRef,
    joystickAxisRef,
    joystickUiRef,
    joystickRootRef,
    cameraRef: controlsCameraRef,
    cameraDistanceRef,
    sendInputSnapshot,
    setPointerButtonBoostInput,
  })

  useMenuFlow({
    menuPhase,
    menuPhaseRef,
    allowPreplayAutoResumeRef,
    setMenuUiMode,
    inputEnabledRef,
    pointerRef,
    webglRef,
    touchControlRef,
    stopJoystick,
    clearBoostInputs,
    socketRef,
    sendJoin,
  })

  useSkinFlow({
    selectedSkin,
    skinDesigns,
    solidPaletteIndex,
    setSolidPaletteIndex,
    joinSkinColorsRef,
    menuPhaseRef,
    socketRef,
    sendJoin,
    builderPattern,
    builderPatternRef,
    builderPaletteColor,
    builderPaletteColorRef,
  })

  useRendererSceneRuntime({
    glCanvasRef,
    hudCanvasRef,
    boostFxRef,
    boostFxStateRef,
    webglRef,
    renderConfigRef,
    headScreenRef,
    localSnakeDisplayRef,
    lastRenderFrameMsRef,
    environmentRef,
    debugFlagsRef,
    dayNightDebugModeRef,
    adaptiveQualityRef,
    syncPelletConsumeTargetsToRenderer,
    handleWheel,
    rafPerfRef,
    playerIdRef,
    getRenderSnapshot,
    stabilizeLocalSnapshot,
    tailDebugEnabled,
    lastTailRenderSampleAtMsRef,
    lastTailEndSampleRef,
    pointerRef,
    appendTailGrowthEvent,
    cameraUpRef,
    menuPhaseRef,
    motionDebugInfoRef,
    lastHeadSampleRef,
    netTuningRef,
    lagSpikeActiveRef,
    lagSpikeCauseRef,
    lagCameraRecoveryStartMsRef,
    lagCameraHoldActiveRef,
    lagCameraHoldQRef,
    lagCameraRecoveryFromQRef,
    stableGameplayCameraRef,
    localLifeSpawnedRef,
    deathStartedAtMsRef,
    clearBoostInputs,
    socketRef,
    sendJoin,
    returnFromCameraQRef,
    renderCameraDistanceRef,
    renderCameraVerticalOffsetRef,
    cameraDistanceRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    returnBlendStartMsRef,
    returnToMenuCommittedRef,
    allowPreplayAutoResumeRef,
    setShowPlayAgain,
    setMenuPhase,
    cameraBlendRef,
    cameraBlendStartMsRef,
    cameraRef,
    controlsCameraRef,
    localHeadRef,
    inputEnabledRef,
    menuUiModeRef,
    menuOverlayExitingRef,
    builderPatternRef,
    builderPaletteColorRef,
    joinSkinColorsRef,
    menuDebugInfoRef,
    netDebugEnabled,
    netDebugInfoRef,
    appendNetLagEvent,
    lastNetSummaryLogMsRef,
    netRxBpsRef,
    netRxTotalBytesRef,
    buildNetLagReport,
    applyNetTuningOverrides,
    cameraRotationStatsRef,
  })

  const { handleJoinRoom, handlePlay } = useMenuGameplayActions({
    roomInput,
    roomName,
    setRoomInput,
    setRoomName,
    setMenuPhase,
    socketRef,
    sendJoin,
    menuPhaseRef,
    menuOverlayExitTimerRef,
    setMenuOverlayExiting,
    menuOverlayExiting,
    menuUiModeRef,
    setMenuUiMode,
    playerName,
    setPlayerName,
    playerNameRef,
    allowPreplayAutoResumeRef,
    pointerRef,
    webglRef,
    clearBoostInputs,
    localHeadRef,
    cameraBlendRef,
    cameraBlendStartMsRef,
    returnBlendStartMsRef,
    returnFromCameraQRef,
    returnFromDistanceRef,
    returnFromVerticalOffsetRef,
    localLifeSpawnedRef,
    deathStartedAtMsRef,
    returnToMenuCommittedRef,
  })

  const {
    handleOpenSkin,
    handleMenuPreviewPointerDown,
    handleMenuPreviewPointerMove,
    handleMenuPreviewPointerUp,
    handleMenuPreviewPointerCancel,
    handleMenuPreviewPointerLeave,
    handleSolidPrev,
    handleSolidNext,
    handleSelectSolid,
    handleSelectDesign,
    handleDeleteDesign,
    resetBuilder,
    handleStartBuilder,
    handleBuilderPrev,
    handleBuilderNext,
    handleBuilderPickColor,
    handleBuilderAddColor,
    handleBuilderPaintSlot,
    handleBuilderSave,
  } = useSkinMenuActions({
    menuOverlayExiting,
    menuOverlayExitingRef,
    menuPhaseRef,
    webglRef,
    setMenuUiMode,
    solidPaletteIndex,
    solidPaletteColor,
    setSolidPaletteIndex,
    selectedSkin,
    setSelectedSkin,
    skinDesigns,
    setSkinDesigns,
    menuPreviewOrbitRef,
    menuPreviewDragRef,
    builderPaletteIndexRef,
    builderPaletteColorRef,
    builderPattern,
    setBuilderPattern,
    setBuilderPaletteColor,
    setBuilderDesignName,
    builderDesignName,
  })
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
            <div ref={joystickRootRef} className='touch-joystick' aria-hidden='true'>
              <div className='touch-joystick__base' />
              <div className='touch-joystick__knob' />
            </div>
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
