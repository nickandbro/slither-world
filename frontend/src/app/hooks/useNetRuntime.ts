import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { GameStateSnapshot, Point } from '@game/types'
import { clamp, normalize } from '@game/math'
import { buildInterpolatedSnapshot, type TimedSnapshot } from '@game/snapshots'
import type {
  PredictionDisabledReason,
  PredictionEvent,
  PredictionInfo,
  PredictionPresentationInfo,
  PredictionReport,
} from '@game/prediction/types'
import {
  PredictionCommandBuffer,
  isInputSeqNewer,
  nextInputSeq,
} from '@game/prediction/commandBuffer'
import {
  angleBetweenDeg,
  cloneSnake,
  deriveLocalAxis,
  replayPredictedSnake,
} from '@game/prediction/localPredictor'
import { blendPredictedSnake, computeP95, decideReconcile } from '@game/prediction/reconcile'
import {
  MAX_EXTRAPOLATION_MS,
  MAX_SNAPSHOT_BUFFER,
  resolveNetTuning,
  type NetTuningOverrides,
} from '@app/core/constants'
import { registerAppDebugApi } from '@app/debug/registerAppDebugApi'
import type {
  LagSpikeCause,
  MotionStabilityDebugInfo,
  NetLagEvent,
  NetLagReport,
  NetSmoothingDebugInfo,
  RafPerfInfo,
  TailEndSample,
  TailGrowthEvent,
  TailGrowthEventInput,
  TailGrowthReport,
} from '@app/debug/types'
import { isSeqNewer, normalizeNetTuningOverrides, seqGapSize } from '@app/orchestration/netSmoothing'
import {
  TAIL_EVENT_LOG_LIMIT,
  computeTailEndMetrics,
  digestionMaxProgress,
} from '@app/orchestration/tailGrowthDebug'
import type { MenuFlowDebugInfo, MenuPhase } from '@app/core/menuCamera'

const NET_EVENT_LOG_LIMIT = 240
const ARRIVAL_GAP_REENTRY_COOLDOWN_MS = 480
const PREDICTION_EVENT_LOG_LIMIT = 320
const PREDICTION_ERROR_WINDOW_SIZE = 240
const PREDICTION_PRESENTATION_WINDOW_SIZE = 240
const PREDICTION_DRIFT_HEAD_THRESHOLD_DEG = 3.5
const PREDICTION_DRIFT_BODY_P95_THRESHOLD_DEG = 5.5
const PREDICTION_DRIFT_CONSECUTIVE_FRAMES = 3
const PREDICTION_DRIFT_ALPHA_FLOOR = 0.72
const PREDICTION_DRIFT_ALPHA_FLOOR_MS = 60
const PREDICTION_MICRO_REVERSAL_MIN_DEG = 0.35
const PREDICTION_MICRO_REVERSAL_MAX_DEG = 1.2
const PREDICTION_MICRO_DEADBAND_DEG = 0.11

const EMPTY_PREDICTION_ERROR = {
  lastDeg: 0,
  p95Deg: 0,
  maxDeg: 0,
}

const EMPTY_PREDICTION_INFO: PredictionInfo = {
  enabled: true,
  latestInputSeq: null,
  latestAckSeq: null,
  pendingInputCount: 0,
  replayedInputCountLastFrame: 0,
  predictedHeadErrorDeg: { ...EMPTY_PREDICTION_ERROR },
  correctionSoftCount: 0,
  correctionHardCount: 0,
  lastCorrectionMagnitudeDeg: 0,
  predictionDisabledReason: 'not-ready',
}

const EMPTY_PREDICTION_PRESENTATION_INFO: PredictionPresentationInfo = {
  headLagDeg: { ...EMPTY_PREDICTION_ERROR },
  bodyLagDeg: { ...EMPTY_PREDICTION_ERROR },
  bodyMicroReversalRate: 0,
  sampleCount: 0,
  microSampleCount: 0,
  reversalCount: 0,
}

const dotPoint = (a: Point, b: Point): number => a.x * b.x + a.y * b.y + a.z * b.z

const crossPoint = (a: Point, b: Point): Point => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

const angularDeltaDeg = (a: Point | null, b: Point | null): number => {
  if (!a || !b) return 0
  const an = normalize(a)
  const bn = normalize(b)
  const dotValue = clamp(dotPoint(an, bn), -1, 1)
  const radians = Math.acos(dotValue)
  return Number.isFinite(radians) ? radians * (180 / Math.PI) : 0
}

const pushWindowSample = (window: number[], value: number, maxSize: number): void => {
  if (!Number.isFinite(value)) return
  window.push(Math.max(0, value))
  if (window.length > maxSize) {
    window.splice(0, window.length - maxSize)
  }
}

const computeBodyLagP95Deg = (displaySnake: Point[] | null, replaySnake: Point[] | null): number => {
  if (!displaySnake || !replaySnake) return 0
  const count = Math.min(displaySnake.length, replaySnake.length)
  if (count <= 1) return 0
  const lags: number[] = []
  for (let index = 1; index < count; index += 1) {
    const lag = angularDeltaDeg(displaySnake[index] ?? null, replaySnake[index] ?? null)
    if (Number.isFinite(lag)) {
      lags.push(Math.max(0, lag))
    }
  }
  return lags.length > 0 ? computeP95(lags) : 0
}

const computeMidBodyForward = (
  snake: Point[] | null,
): { forward: Point; normal: Point } | null => {
  if (!snake || snake.length < 4) return null
  const tailIndex = snake.length - 1
  const midIndex = Math.max(1, Math.min(tailIndex - 1, Math.floor(tailIndex / 2)))
  const prev = normalize(snake[Math.max(0, midIndex - 1)] ?? snake[midIndex]!)
  const mid = normalize(snake[midIndex]!)
  const next = normalize(snake[Math.min(tailIndex, midIndex + 1)] ?? snake[midIndex]!)
  const raw = normalize({
    x: prev.x - next.x,
    y: prev.y - next.y,
    z: prev.z - next.z,
  })
  const radial = dotPoint(raw, mid)
  const tangent = normalize({
    x: raw.x - mid.x * radial,
    y: raw.y - mid.y * radial,
    z: raw.z - mid.z * radial,
  })
  const tangentMag = Math.hypot(tangent.x, tangent.y, tangent.z)
  const normalMag = Math.hypot(mid.x, mid.y, mid.z)
  if (!(tangentMag > 1e-6) || !(normalMag > 1e-6)) return null
  return {
    forward: tangent,
    normal: mid,
  }
}

export type UseNetRuntimeOptions = {
  netDebugEnabled: boolean
  tailDebugEnabled: boolean
  predictionDebugPerturbation: boolean
  menuPhaseRef: MutableRefObject<MenuPhase>
  menuDebugInfoRef: MutableRefObject<MenuFlowDebugInfo>
  netDebugInfoRef: MutableRefObject<NetSmoothingDebugInfo>
  motionDebugInfoRef: MutableRefObject<MotionStabilityDebugInfo>
  netLagEventsRef: MutableRefObject<NetLagEvent[]>
  netLagEventIdRef: MutableRefObject<number>
  tailGrowthEventsRef: MutableRefObject<TailGrowthEvent[]>
  tailGrowthEventIdRef: MutableRefObject<number>
  netRxBpsRef: MutableRefObject<number>
  netRxTotalBytesRef: MutableRefObject<number>
  netRxWindowBytesRef: MutableRefObject<number>
  lastTailRenderSampleAtMsRef: MutableRefObject<number | null>
  lastTailEndSampleRef: MutableRefObject<TailEndSample | null>
  rafPerfRef: MutableRefObject<RafPerfInfo>
  netTuningOverridesRef: MutableRefObject<NetTuningOverrides>
  netTuningRef: MutableRefObject<ReturnType<typeof resolveNetTuning>>
  netTuningRevisionRef: MutableRefObject<number>
  lagCameraHoldActiveRef: MutableRefObject<boolean>
  pointerRef: MutableRefObject<{ boost: boolean; active: boolean }>
  playerIdRef: MutableRefObject<string | null>
  snapshotBufferRef: MutableRefObject<TimedSnapshot[]>
  serverOffsetRef: MutableRefObject<number | null>
  serverTickMsRef: MutableRefObject<number>
  tickIntervalRef: MutableRefObject<number>
  lastSnapshotTimeRef: MutableRefObject<number | null>
  lastSnapshotReceivedAtRef: MutableRefObject<number | null>
  receiveIntervalMsRef: MutableRefObject<number>
  receiveJitterMsRef: MutableRefObject<number>
  receiveJitterDelayMsRef: MutableRefObject<number>
  playoutDelayMsRef: MutableRefObject<number>
  delayBoostMsRef: MutableRefObject<number>
  lastDelayUpdateMsRef: MutableRefObject<number | null>
  latestSeqRef: MutableRefObject<number | null>
  seqGapDetectedRef: MutableRefObject<boolean>
  lastSeqGapAtMsRef: MutableRefObject<number | null>
  lagSpikeActiveRef: MutableRefObject<boolean>
  lagSpikeCauseRef: MutableRefObject<LagSpikeCause>
  lagSpikeEnterCandidateAtMsRef: MutableRefObject<number | null>
  lagSpikeExitCandidateAtMsRef: MutableRefObject<number | null>
  lagSpikeArrivalGapCooldownUntilMsRef: MutableRefObject<number>
  lagImpairmentUntilMsRef: MutableRefObject<number>
  localSnakeDisplayRef: MutableRefObject<Point[] | null>
}

export type UseNetRuntimeResult = {
  appendNetLagEvent: (
    type: NetLagEvent['type'],
    message: string,
    extras?: Partial<Pick<NetLagEvent, 'droppedSeq' | 'seqGapSize'>>,
  ) => void
  buildNetLagReport: () => NetLagReport
  appendTailGrowthEvent: (event: TailGrowthEventInput) => void
  buildTailGrowthReport: () => TailGrowthReport
  clearNetLagEvents: () => void
  clearTailGrowthEvents: () => void
  getRafPerfInfo: () => RafPerfInfo
  clearRafPerf: () => void
  applyNetTuningOverrides: (
    incoming: NetTuningOverrides | null | undefined,
    options?: { announce?: boolean },
  ) => {
    revision: number
    overrides: NetTuningOverrides
    resolved: ReturnType<typeof resolveNetTuning>
  }
  enqueuePredictedInputCommand: (axis: Point | null, boost: boolean, sentAtMs: number) => number
  resetPredictionState: () => void
  pushSnapshot: (state: GameStateSnapshot) => void
  getRenderSnapshot: () => GameStateSnapshot | null
  stabilizeLocalSnapshot: (
    snapshot: GameStateSnapshot | null,
    localId: string | null,
    frameDeltaSeconds: number,
  ) => GameStateSnapshot | null
}

export function useNetRuntime(options: UseNetRuntimeOptions): UseNetRuntimeResult {
  const {
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
  } = options

  const predictionCommandBufferRef = useRef<PredictionCommandBuffer>(new PredictionCommandBuffer())
  const predictionLatestInputSeqRef = useRef<number | null>(null)
  const predictionLatestAckSeqRef = useRef<number | null>(null)
  const predictionEventsRef = useRef<PredictionEvent[]>([])
  const predictionEventIdRef = useRef(1)
  const predictionInfoRef = useRef<PredictionInfo>({
    ...EMPTY_PREDICTION_INFO,
    predictionDisabledReason: 'not-ready',
  })
  const predictionErrorSamplesRef = useRef<number[]>([])
  const predictionAuthoritativeSnakeRef = useRef<Point[] | null>(null)
  const predictionAuthoritativeReceivedAtMsRef = useRef<number | null>(null)
  const predictionAxisRef = useRef<Point | null>(null)
  const predictionPhysicsSnakeRef = useRef<Point[] | null>(null)
  const predictionDisplaySnakeRef = useRef<Point[] | null>(null)
  const predictionSoftStartAtMsRef = useRef<number | null>(null)
  const predictionSoftUntilMsRef = useRef<number | null>(null)
  const predictionSoftDurationMsRef = useRef<number>(0)
  const predictionHardDampenUntilMsRef = useRef<number | null>(null)
  const predictionLifeSpawnFloorRef = useRef<number | null>(null)
  const predictionLastAliveRef = useRef<boolean>(false)
  const predictionNeedsReconcileCheckRef = useRef<boolean>(false)
  const predictionForceHardNextReconcileRef = useRef<boolean>(false)
  const predictionPresentationInfoRef = useRef<PredictionPresentationInfo>({
    ...EMPTY_PREDICTION_PRESENTATION_INFO,
    headLagDeg: { ...EMPTY_PREDICTION_PRESENTATION_INFO.headLagDeg },
    bodyLagDeg: { ...EMPTY_PREDICTION_PRESENTATION_INFO.bodyLagDeg },
  })
  const predictionHeadLagSamplesRef = useRef<number[]>([])
  const predictionBodyLagSamplesRef = useRef<number[]>([])
  const predictionMicroStepCountRef = useRef<number>(0)
  const predictionMicroReversalCountRef = useRef<number>(0)
  const predictionLastMidForwardRef = useRef<Point | null>(null)
  const predictionLastMicroTurnSignRef = useRef<number>(0)
  const predictionLastMicroStepDegRef = useRef<number>(0)
  const predictionDriftConsecutiveFramesRef = useRef<number>(0)
  const predictionAlphaFloorUntilMsRef = useRef<number | null>(null)

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
    [
      lagCameraHoldActiveRef,
      motionDebugInfoRef,
      netDebugEnabled,
      netDebugInfoRef,
      netLagEventIdRef,
      netLagEventsRef,
    ],
  )

  const buildNetLagReport = useCallback((): NetLagReport => {
    return {
      generatedAtIso: new Date().toISOString(),
      net: { ...netDebugInfoRef.current },
      motion: { ...motionDebugInfoRef.current },
      recentEvents: netLagEventsRef.current.slice(-80),
    }
  }, [motionDebugInfoRef, netDebugInfoRef, netLagEventsRef])

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
    [menuPhaseRef, netDebugInfoRef, tailDebugEnabled, tailGrowthEventIdRef, tailGrowthEventsRef],
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
  }, [tailDebugEnabled, tailGrowthEventsRef])

  const clearNetLagEvents = useCallback(() => {
    netLagEventsRef.current = []
    netLagEventIdRef.current = 1
  }, [netLagEventIdRef, netLagEventsRef])

  const clearTailGrowthEvents = useCallback(() => {
    tailGrowthEventsRef.current = []
    tailGrowthEventIdRef.current = 1
    lastTailRenderSampleAtMsRef.current = null
    lastTailEndSampleRef.current = null
  }, [
    lastTailEndSampleRef,
    lastTailRenderSampleAtMsRef,
    tailGrowthEventIdRef,
    tailGrowthEventsRef,
  ])

  const clearPredictionEvents = useCallback(() => {
    predictionEventsRef.current = []
    predictionEventIdRef.current = 1
  }, [])

  const clearPredictionPresentationMetrics = useCallback(() => {
    predictionHeadLagSamplesRef.current = []
    predictionBodyLagSamplesRef.current = []
    predictionMicroStepCountRef.current = 0
    predictionMicroReversalCountRef.current = 0
    predictionLastMidForwardRef.current = null
    predictionLastMicroTurnSignRef.current = 0
    predictionLastMicroStepDegRef.current = 0
    predictionDriftConsecutiveFramesRef.current = 0
    predictionAlphaFloorUntilMsRef.current = null
    predictionPresentationInfoRef.current = {
      ...EMPTY_PREDICTION_PRESENTATION_INFO,
      headLagDeg: { ...EMPTY_PREDICTION_PRESENTATION_INFO.headLagDeg },
      bodyLagDeg: { ...EMPTY_PREDICTION_PRESENTATION_INFO.bodyLagDeg },
    }
  }, [])

  const resetPredictionState = useCallback(() => {
    predictionCommandBufferRef.current.clear()
    predictionLatestInputSeqRef.current = null
    predictionLatestAckSeqRef.current = null
    predictionErrorSamplesRef.current = []
    predictionAuthoritativeSnakeRef.current = null
    predictionAuthoritativeReceivedAtMsRef.current = null
    predictionAxisRef.current = null
    predictionPhysicsSnakeRef.current = null
    predictionDisplaySnakeRef.current = null
    predictionSoftStartAtMsRef.current = null
    predictionSoftUntilMsRef.current = null
    predictionSoftDurationMsRef.current = 0
    predictionHardDampenUntilMsRef.current = null
    predictionLifeSpawnFloorRef.current = null
    predictionLastAliveRef.current = false
    predictionNeedsReconcileCheckRef.current = false
    predictionForceHardNextReconcileRef.current = false
    predictionInfoRef.current = {
      ...EMPTY_PREDICTION_INFO,
      predictionDisabledReason: 'not-ready',
    }
    clearPredictionEvents()
    clearPredictionPresentationMetrics()
  }, [clearPredictionEvents, clearPredictionPresentationMetrics])

  useEffect(() => {
    resetPredictionState()
  }, [resetPredictionState])

  const appendPredictionEvent = useCallback(
    (
      type: PredictionEvent['type'],
      message: string,
      extras?: {
        seq?: number | null
        ackSeq?: number | null
        magnitudeDeg?: number | null
        replayedInputCount?: number
      },
    ) => {
      const info = predictionInfoRef.current
      const entry: PredictionEvent = {
        id: predictionEventIdRef.current,
        atIso: new Date().toISOString(),
        tMs: performance.now(),
        type,
        seq: extras?.seq ?? null,
        ackSeq: extras?.ackSeq ?? info.latestAckSeq,
        pendingInputCount: info.pendingInputCount,
        replayedInputCount: extras?.replayedInputCount ?? info.replayedInputCountLastFrame,
        magnitudeDeg: extras?.magnitudeDeg ?? null,
        message,
      }
      predictionEventIdRef.current += 1
      const events = predictionEventsRef.current
      events.push(entry)
      if (events.length > PREDICTION_EVENT_LOG_LIMIT) {
        events.splice(0, events.length - PREDICTION_EVENT_LOG_LIMIT)
      }
    },
    [],
  )

  const pushPredictionErrorSample = useCallback((errorDeg: number) => {
    if (!Number.isFinite(errorDeg)) return
    const samples = predictionErrorSamplesRef.current
    samples.push(Math.max(0, errorDeg))
    if (samples.length > PREDICTION_ERROR_WINDOW_SIZE) {
      samples.splice(0, samples.length - PREDICTION_ERROR_WINDOW_SIZE)
    }
    const p95 = computeP95(samples)
    const max = samples.reduce((acc, value) => Math.max(acc, value), 0)
    predictionInfoRef.current = {
      ...predictionInfoRef.current,
      predictedHeadErrorDeg: {
        lastDeg: Math.max(0, errorDeg),
        p95Deg: p95,
        maxDeg: max,
      },
    }
  }, [])

  const getPredictionReport = useCallback((): PredictionReport => {
    return {
      generatedAtIso: new Date().toISOString(),
      info: {
        ...predictionInfoRef.current,
        predictedHeadErrorDeg: { ...predictionInfoRef.current.predictedHeadErrorDeg },
      },
      recentEvents: predictionEventsRef.current.slice(-120).map((event) => ({ ...event })),
    }
  }, [])

  const updatePredictionPresentationMetrics = useCallback(
    (displaySnake: Point[] | null, replaySnake: Point[] | null) => {
      const headLagDeg = angularDeltaDeg(displaySnake?.[0] ?? null, replaySnake?.[0] ?? null)
      const bodyLagDeg = computeBodyLagP95Deg(displaySnake, replaySnake)

      pushWindowSample(
        predictionHeadLagSamplesRef.current,
        headLagDeg,
        PREDICTION_PRESENTATION_WINDOW_SIZE,
      )
      pushWindowSample(
        predictionBodyLagSamplesRef.current,
        bodyLagDeg,
        PREDICTION_PRESENTATION_WINDOW_SIZE,
      )

      const headSamples = predictionHeadLagSamplesRef.current
      const bodySamples = predictionBodyLagSamplesRef.current
      const headP95 = computeP95(headSamples)
      const bodyP95 = computeP95(bodySamples)
      const headMax = headSamples.reduce((acc, value) => Math.max(acc, value), 0)
      const bodyMax = bodySamples.reduce((acc, value) => Math.max(acc, value), 0)

      const midBodySample = computeMidBodyForward(displaySnake)
      const previousMidForward = predictionLastMidForwardRef.current
      if (midBodySample && previousMidForward) {
        const stepDeg = angularDeltaDeg(previousMidForward, midBodySample.forward)
        if (
          stepDeg >= PREDICTION_MICRO_REVERSAL_MIN_DEG &&
          stepDeg <= PREDICTION_MICRO_REVERSAL_MAX_DEG
        ) {
          predictionMicroStepCountRef.current += 1
          const turnCross = crossPoint(previousMidForward, midBodySample.forward)
          const signedTurn = dotPoint(turnCross, midBodySample.normal)
          const sign = signedTurn > 1e-8 ? 1 : signedTurn < -1e-8 ? -1 : 0
          const previousSign = predictionLastMicroTurnSignRef.current
          const previousStepDeg = predictionLastMicroStepDegRef.current
          const meaningfulCurrentStep = stepDeg >= 0.55
          const meaningfulPreviousStep = previousStepDeg >= 0.55
          if (
            sign !== 0 &&
            previousSign !== 0 &&
            sign !== previousSign &&
            meaningfulCurrentStep &&
            meaningfulPreviousStep
          ) {
            predictionMicroReversalCountRef.current += 1
          }
          if (sign !== 0) {
            predictionLastMicroTurnSignRef.current = sign
          }
          predictionLastMicroStepDegRef.current = stepDeg
        }
      }
      predictionLastMidForwardRef.current = midBodySample?.forward ?? null

      const microSampleCount = predictionMicroStepCountRef.current
      const reversalCount = predictionMicroReversalCountRef.current
      const bodyMicroReversalRate = reversalCount / Math.max(1, microSampleCount)
      predictionPresentationInfoRef.current = {
        headLagDeg: {
          lastDeg: headLagDeg,
          p95Deg: headP95,
          maxDeg: headMax,
        },
        bodyLagDeg: {
          lastDeg: bodyLagDeg,
          p95Deg: bodyP95,
          maxDeg: bodyMax,
        },
        bodyMicroReversalRate,
        sampleCount: headSamples.length,
        microSampleCount,
        reversalCount,
      }
    },
    [],
  )

  const enqueuePredictedInputCommand = useCallback(
    (axis: Point | null, boost: boolean, sentAtMs: number) => {
      const nextSeq = nextInputSeq(predictionLatestInputSeqRef.current)
      predictionLatestInputSeqRef.current = nextSeq

      const normalizedAxis = axis ? normalize(axis) : null
      const result = predictionCommandBufferRef.current.enqueue({
        seq: nextSeq,
        sentAtMs,
        axis: normalizedAxis,
        boost,
      })
      if (result.overflowPruned > 0) {
        appendPredictionEvent('queue_prune', `pruned ${result.overflowPruned} overflow commands`, {
          seq: nextSeq,
        })
      }
      appendPredictionEvent('input_enqueued', `input seq=${nextSeq} boost=${boost ? 1 : 0}`, {
        seq: nextSeq,
      })

      predictionInfoRef.current = {
        ...predictionInfoRef.current,
        enabled: true,
        latestInputSeq: nextSeq,
        pendingInputCount: predictionCommandBufferRef.current.size(),
      }

      return nextSeq
    },
    [appendPredictionEvent],
  )

  const getRafPerfInfo = useCallback((): RafPerfInfo => {
    const info = rafPerfRef.current
    return {
      ...info,
      lastFrame: info.lastFrame ? { ...info.lastFrame } : null,
      slowFrames: info.slowFrames.map((frame) => ({ ...frame })),
    }
  }, [rafPerfRef])

  const clearRafPerf = useCallback(() => {
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
  }, [rafPerfRef])

  const applyNetTuningOverrides = useCallback(
    (incoming: NetTuningOverrides | null | undefined, options?: { announce?: boolean }) => {
      const normalized = normalizeNetTuningOverrides(incoming)
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
    [appendNetLagEvent, netDebugInfoRef, netTuningOverridesRef, netTuningRef, netTuningRevisionRef],
  )

  useEffect(() => {
    registerAppDebugApi({
      menuDebugInfoRef,
      netDebugInfoRef,
      netRxBpsRef,
      netRxTotalBytesRef,
      netRxWindowBytesRef,
      motionDebugInfoRef,
      netLagEventsRef,
      buildNetLagReport,
      clearNetLagEvents,
      tailGrowthEventsRef,
      buildTailGrowthReport,
      clearTailGrowthEvents,
      getNetTuningOverrides: () => ({ ...netTuningOverridesRef.current }),
      getResolvedNetTuning: () => ({ ...netTuningRef.current }),
      setNetTuningOverrides: (overrides) =>
        applyNetTuningOverrides(overrides, { announce: true }),
      resetNetTuningOverrides: () => applyNetTuningOverrides({}, { announce: true }),
      getRafPerfInfo,
      clearRafPerf,
      predictionInfoRef,
      predictionPresentationInfoRef,
      predictionEventsRef,
      getPredictionReport,
      clearPredictionEvents,
      clearPredictionPresentationMetrics,
      getLocalPlayerId: () => playerIdRef.current,
      getLocalHeadNormal: () => {
        const snake = localSnakeDisplayRef.current
        const head = snake?.[0]
        if (!head) return null
        const normalized = normalize(head)
        const mag = Math.hypot(normalized.x, normalized.y, normalized.z)
        if (!(mag > 1e-6) || !Number.isFinite(mag)) return null
        return normalized
      },
      getLocalHeadForward: () => {
        const snake = localSnakeDisplayRef.current
        if (!snake || snake.length < 2) return null
        const head = snake[0]
        const neck = snake[1]
        if (!head || !neck) return null
        const headNorm = normalize(head)
        const rawX = head.x - neck.x
        const rawY = head.y - neck.y
        const rawZ = head.z - neck.z
        const radial = rawX * headNorm.x + rawY * headNorm.y + rawZ * headNorm.z
        const tangent = normalize({
          x: rawX - headNorm.x * radial,
          y: rawY - headNorm.y * radial,
          z: rawZ - headNorm.z * radial,
        })
        const mag = Math.hypot(tangent.x, tangent.y, tangent.z)
        if (!(mag > 1e-6) || !Number.isFinite(mag)) return null
        return tangent
      },
    })
  }, [
    applyNetTuningOverrides,
    buildNetLagReport,
    buildTailGrowthReport,
    clearPredictionEvents,
    clearNetLagEvents,
    clearRafPerf,
    clearTailGrowthEvents,
    getPredictionReport,
    getRafPerfInfo,
    menuDebugInfoRef,
    motionDebugInfoRef,
    netDebugInfoRef,
    netLagEventsRef,
    netRxBpsRef,
    netRxTotalBytesRef,
    netRxWindowBytesRef,
    netTuningOverridesRef,
    netTuningRef,
    clearPredictionPresentationMetrics,
    predictionEventsRef,
    predictionInfoRef,
    predictionPresentationInfoRef,
    playerIdRef,
    localSnakeDisplayRef,
    tailGrowthEventsRef,
  ])

  const setLagSpikeState = useCallback(
    (active: boolean, cause: LagSpikeCause) => {
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
        lagSpikeArrivalGapCooldownUntilMsRef.current =
          performance.now() + ARRIVAL_GAP_REENTRY_COOLDOWN_MS
      }

      appendNetLagEvent(
        'spike_end',
        `spike ended; delay=${playoutDelayMsRef.current.toFixed(1)}ms jitter=${receiveJitterMsRef.current.toFixed(
          1,
        )}ms`,
      )
      if (netDebugEnabled) {
        console.info(
          `[net] lag spike end delay=${playoutDelayMsRef.current.toFixed(1)}ms jitter=${receiveJitterMsRef.current.toFixed(
            1,
          )}ms`,
        )
      }
    },
    [
      appendNetLagEvent,
      delayBoostMsRef,
      lagSpikeActiveRef,
      lagSpikeArrivalGapCooldownUntilMsRef,
      lagSpikeCauseRef,
      netDebugEnabled,
      netDebugInfoRef,
      netTuningRef,
      playoutDelayMsRef,
      receiveJitterMsRef,
      serverTickMsRef,
    ],
  )

  const pushSnapshot = useCallback(
    (state: GameStateSnapshot) => {
      const now = Date.now()
      const nowMs = performance.now()
      const hadSeqGap = seqGapDetectedRef.current
      const tuning = netTuningRef.current

      const latestSeq = latestSeqRef.current
      if (latestSeq !== null) {
        if (state.seq === latestSeq) {
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
          lagSpikeActiveRef.current || Math.abs(rawDelta) > outlierThreshold
            ? tickMs * 0.65
            : tickMs * 1.8
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
          const nextIntervalEwma =
            intervalEwma + (interval - intervalEwma) * tuning.netIntervalSmoothing
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
              lagImpairmentUntilMsRef.current = Math.max(
                lagImpairmentUntilMsRef.current,
                nowMs + holdMs,
              )
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

      const ackInputSeq = typeof state.ackInputSeq === 'number' ? state.ackInputSeq & 0xffff : null
      const previousAckSeq = predictionLatestAckSeqRef.current
      if (ackInputSeq !== null) {
        const shouldAdvanceAck =
          previousAckSeq === null || ackInputSeq === previousAckSeq || isInputSeqNewer(ackInputSeq, previousAckSeq)
        if (shouldAdvanceAck) {
          predictionLatestAckSeqRef.current = ackInputSeq
          if (previousAckSeq !== ackInputSeq) {
            appendPredictionEvent('ack_advanced', `ack advanced to ${ackInputSeq}`, {
              ackSeq: ackInputSeq,
            })
          }
        }
      }

      const prunedAckedCount = predictionCommandBufferRef.current.pruneAcked(
        predictionLatestAckSeqRef.current,
      )
      if (prunedAckedCount > 0) {
        appendPredictionEvent('queue_prune', `pruned ${prunedAckedCount} acked commands`, {
          ackSeq: predictionLatestAckSeqRef.current,
        })
      }

      const localId = playerIdRef.current
      const localPlayer = localId ? state.players.find((player) => player.id === localId) ?? null : null

      const pendingInputCount = predictionCommandBufferRef.current.size()
      const hasLocalSnake = !!localPlayer && localPlayer.alive && localPlayer.snake.length > 0
      const wasAlive = predictionLastAliveRef.current

      if (!hasLocalSnake) {
        predictionAuthoritativeSnakeRef.current = null
        predictionAuthoritativeReceivedAtMsRef.current = null
        predictionAxisRef.current = null
        predictionPhysicsSnakeRef.current = null
        predictionDisplaySnakeRef.current = null
        predictionSoftStartAtMsRef.current = null
        predictionSoftUntilMsRef.current = null
        predictionSoftDurationMsRef.current = 0
        predictionHardDampenUntilMsRef.current = null
        predictionLastAliveRef.current = false
        predictionNeedsReconcileCheckRef.current = false
        predictionForceHardNextReconcileRef.current = false
        if (!localPlayer || !localPlayer.alive) {
          predictionLifeSpawnFloorRef.current = null
        }
        predictionInfoRef.current = {
          ...predictionInfoRef.current,
          enabled: true,
          latestInputSeq: predictionLatestInputSeqRef.current,
          latestAckSeq: predictionLatestAckSeqRef.current,
          pendingInputCount,
          predictionDisabledReason: localPlayer && !localPlayer.alive ? 'dead' : 'not-ready',
        }
      } else {
        const authoritativeSnake = cloneSnake(localPlayer.snake)
        predictionAuthoritativeSnakeRef.current = authoritativeSnake
        const serverOffsetMs = serverOffsetRef.current
        let authoritativePerfMs = nowMs
        if (serverOffsetMs !== null && Number.isFinite(serverOffsetMs)) {
          const authoritativeWallMs = state.now - serverOffsetMs
          const wallToPerfDeltaMs = nowMs - now
          authoritativePerfMs = authoritativeWallMs + wallToPerfDeltaMs
        }
        const tickMs = Math.max(16, serverTickMsRef.current)
        const maxLookbackMs = tickMs * 6
        predictionAuthoritativeReceivedAtMsRef.current = clamp(
          authoritativePerfMs,
          nowMs - maxLookbackMs,
          nowMs,
        )
        predictionAxisRef.current = deriveLocalAxis(authoritativeSnake, predictionAxisRef.current)
        predictionNeedsReconcileCheckRef.current = true
        predictionForceHardNextReconcileRef.current = !wasAlive
        if (!wasAlive || predictionLifeSpawnFloorRef.current === null) {
          predictionLifeSpawnFloorRef.current = localPlayer.score
        }
        predictionLastAliveRef.current = true

        predictionInfoRef.current = {
          ...predictionInfoRef.current,
          enabled: true,
          latestInputSeq: predictionLatestInputSeqRef.current,
          latestAckSeq: predictionLatestAckSeqRef.current,
          pendingInputCount,
          predictionDisabledReason: 'none',
        }
      }

      if (tailDebugEnabled) {
        const boostInput = pointerRef.current.boost
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
    },
    [
      appendNetLagEvent,
      appendPredictionEvent,
      appendTailGrowthEvent,
      delayBoostMsRef,
      lagImpairmentUntilMsRef,
      lagSpikeActiveRef,
      lastSeqGapAtMsRef,
      lastSnapshotReceivedAtRef,
      lastSnapshotTimeRef,
      latestSeqRef,
      netDebugEnabled,
      netDebugInfoRef,
      netTuningOverridesRef,
      netTuningRef,
      netTuningRevisionRef,
      playerIdRef,
      pointerRef,
      receiveIntervalMsRef,
      receiveJitterDelayMsRef,
      receiveJitterMsRef,
      seqGapDetectedRef,
      serverOffsetRef,
      serverTickMsRef,
      snapshotBufferRef,
      tailDebugEnabled,
      tickIntervalRef,
    ],
  )

  const getRenderSnapshot = useCallback(() => {
    const buffer = snapshotBufferRef.current
    if (buffer.length === 0) return null
    const offset = serverOffsetRef.current
    if (offset === null) return buffer[buffer.length - 1] ?? null
    const tuning = netTuningRef.current

    const now = Date.now()
    const nowMs = performance.now()
    const tickMs = Math.max(16, serverTickMsRef.current)

    const lastDelayUpdateMs = lastDelayUpdateMsRef.current
    const dtSeconds =
      lastDelayUpdateMs !== null ? Math.max(0, Math.min(0.1, (nowMs - lastDelayUpdateMs) / 1000)) : 1 / 60
    if (lastDelayUpdateMs !== null && dtSeconds > 0 && !lagSpikeActiveRef.current) {
      delayBoostMsRef.current = Math.max(
        0,
        delayBoostMsRef.current - tuning.netDelayBoostDecayPerSec * dtSeconds,
      )
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
      jitterDelayMs,
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
  }, [
    delayBoostMsRef,
    lagImpairmentUntilMsRef,
    lagSpikeActiveRef,
    lagSpikeArrivalGapCooldownUntilMsRef,
    lagSpikeCauseRef,
    lagSpikeEnterCandidateAtMsRef,
    lagSpikeExitCandidateAtMsRef,
    lastDelayUpdateMsRef,
    lastSeqGapAtMsRef,
    lastSnapshotReceivedAtRef,
    latestSeqRef,
    netDebugInfoRef,
    netTuningOverridesRef,
    netTuningRef,
    netTuningRevisionRef,
    playoutDelayMsRef,
    receiveIntervalMsRef,
    receiveJitterDelayMsRef,
    receiveJitterMsRef,
    seqGapDetectedRef,
    serverOffsetRef,
    serverTickMsRef,
    setLagSpikeState,
    snapshotBufferRef,
  ])

  const stabilizeLocalSnapshot = useCallback(
    (
      snapshot: GameStateSnapshot | null,
      localId: string | null,
      frameDeltaSeconds: number,
    ): GameStateSnapshot | null => {
      if (!snapshot || !localId) {
        localSnakeDisplayRef.current = null
        predictionInfoRef.current = {
          ...predictionInfoRef.current,
          enabled: true,
          latestInputSeq: predictionLatestInputSeqRef.current,
          latestAckSeq: predictionLatestAckSeqRef.current,
          pendingInputCount: predictionCommandBufferRef.current.size(),
          replayedInputCountLastFrame: 0,
          predictionDisabledReason: 'not-ready',
        }
        return snapshot
      }

      const localIndex = snapshot.players.findIndex((player) => player.id === localId)
      if (localIndex < 0) {
        localSnakeDisplayRef.current = null
        predictionInfoRef.current = {
          ...predictionInfoRef.current,
          enabled: true,
          latestInputSeq: predictionLatestInputSeqRef.current,
          latestAckSeq: predictionLatestAckSeqRef.current,
          pendingInputCount: predictionCommandBufferRef.current.size(),
          replayedInputCountLastFrame: 0,
          predictionDisabledReason: 'not-ready',
        }
        return snapshot
      }

      const localPlayer = snapshot.players[localIndex]
      const arrivalGapImpaired =
        lagSpikeCauseRef.current === 'arrival-gap' &&
        (netDebugInfoRef.current.impairmentMsRemaining > 120 || netDebugInfoRef.current.jitterMs > 45)
      const hardSpikeActive =
        lagSpikeActiveRef.current &&
        (lagSpikeCauseRef.current !== 'arrival-gap' || arrivalGapImpaired)

      let disabledReason: PredictionDisabledReason = 'none'
      if (!localPlayer.alive || localPlayer.snake.length === 0) {
        disabledReason = 'dead'
      } else if (hardSpikeActive) {
        disabledReason = 'spike'
      } else if (
        !predictionAuthoritativeSnakeRef.current ||
        predictionAuthoritativeSnakeRef.current.length === 0 ||
        predictionAuthoritativeReceivedAtMsRef.current === null
      ) {
        disabledReason = 'not-ready'
      }

      if (disabledReason !== 'none') {
        const incomingSnake = localPlayer.snake.map((node) => normalize(node))
        localSnakeDisplayRef.current = incomingSnake
        predictionPhysicsSnakeRef.current = cloneSnake(incomingSnake)
        predictionDisplaySnakeRef.current = cloneSnake(incomingSnake)
        predictionAxisRef.current = deriveLocalAxis(incomingSnake, predictionAxisRef.current)
        predictionDriftConsecutiveFramesRef.current = 0
        predictionAlphaFloorUntilMsRef.current = null
        predictionLastMidForwardRef.current = null
        predictionLastMicroTurnSignRef.current = 0
        predictionLastMicroStepDegRef.current = 0
        predictionInfoRef.current = {
          ...predictionInfoRef.current,
          enabled: true,
          latestInputSeq: predictionLatestInputSeqRef.current,
          latestAckSeq: predictionLatestAckSeqRef.current,
          pendingInputCount: predictionCommandBufferRef.current.size(),
          replayedInputCountLastFrame: 0,
          predictionDisabledReason: disabledReason,
        }
        return snapshot
      }

      const pendingCommands = predictionCommandBufferRef.current.getPendingAfterAck(
        predictionLatestAckSeqRef.current,
      )
      const activePredictionInput = pendingCommands.length > 0
      const baseSnake = predictionAuthoritativeSnakeRef.current ?? localPlayer.snake
      const baseReceivedAtMs = predictionAuthoritativeReceivedAtMsRef.current ?? performance.now()
      const spawnFloor = predictionLifeSpawnFloorRef.current ?? localPlayer.score
      const boostAllowed = localPlayer.isBoosting || localPlayer.score >= spawnFloor + 1
      const nowMs = performance.now()
      const replayNowMs = predictionDebugPerturbation ? nowMs + 110 : nowMs
      const replayed = replayPredictedSnake({
        snake: baseSnake,
        baseReceivedAtMs,
        nowMs: replayNowMs,
        pendingCommands,
        fallbackAxis: predictionAxisRef.current,
        boostAllowed,
      })

      if (predictionNeedsReconcileCheckRef.current) {
        const physicsHead =
          predictionPhysicsSnakeRef.current?.[0] ??
          predictionDisplaySnakeRef.current?.[0] ??
          null
        const replayHead = replayed.snake[0] ?? null
        const errorDeg = angleBetweenDeg(physicsHead, replayHead)
        pushPredictionErrorSample(errorDeg)
        const forceHard = predictionForceHardNextReconcileRef.current
        const softUntilMs = predictionSoftUntilMsRef.current
        const hardUntilMs = predictionHardDampenUntilMsRef.current
        const correctionWindowActive =
          (hardUntilMs !== null && nowMs < hardUntilMs) ||
          (softUntilMs !== null && nowMs < softUntilMs)
        if (!correctionWindowActive || forceHard) {
          let decision = decideReconcile(errorDeg, forceHard)
          const activeSteering = activePredictionInput || pointerRef.current.active
          if (
            decision.kind === 'soft' &&
            !forceHard &&
            activeSteering &&
            decision.magnitudeDeg < 5.5
          ) {
            decision = {
              kind: 'none',
              magnitudeDeg: decision.magnitudeDeg,
              durationMs: 0,
            }
          }
          const underNetworkStress =
            lagSpikeActiveRef.current ||
            netDebugInfoRef.current.jitterMs > 35 ||
            netDebugInfoRef.current.receiveIntervalMs >
              Math.max(70, serverTickMsRef.current * 1.45)
          if (decision.kind === 'hard' && !forceHard && underNetworkStress) {
            decision = {
              kind: 'soft',
              magnitudeDeg: decision.magnitudeDeg,
              durationMs: 120,
            }
          }
          if (decision.kind === 'soft') {
            predictionSoftStartAtMsRef.current = nowMs
            predictionSoftUntilMsRef.current = nowMs + decision.durationMs
            predictionSoftDurationMsRef.current = decision.durationMs
            predictionInfoRef.current = {
              ...predictionInfoRef.current,
              correctionSoftCount: predictionInfoRef.current.correctionSoftCount + 1,
              lastCorrectionMagnitudeDeg: decision.magnitudeDeg,
            }
            appendPredictionEvent('reconcile_soft', `soft reconcile ${decision.magnitudeDeg.toFixed(2)}deg`, {
              magnitudeDeg: decision.magnitudeDeg,
            })
          } else if (decision.kind === 'hard') {
            predictionHardDampenUntilMsRef.current = nowMs + 80
            predictionSoftStartAtMsRef.current = null
            predictionSoftUntilMsRef.current = null
            predictionSoftDurationMsRef.current = 0
            predictionDisplaySnakeRef.current = cloneSnake(replayed.snake)
            predictionInfoRef.current = {
              ...predictionInfoRef.current,
              correctionHardCount: predictionInfoRef.current.correctionHardCount + 1,
              lastCorrectionMagnitudeDeg: decision.magnitudeDeg,
            }
            appendPredictionEvent('reconcile_hard', `hard reconcile ${decision.magnitudeDeg.toFixed(2)}deg`, {
              magnitudeDeg: decision.magnitudeDeg,
            })
          }
        }
        predictionNeedsReconcileCheckRef.current = false
        predictionForceHardNextReconcileRef.current = false
      }
      predictionPhysicsSnakeRef.current = cloneSnake(replayed.snake)

      const dt = clamp(frameDeltaSeconds, 0, 0.1)
      const tuning = netTuningRef.current
      const activeSteering = activePredictionInput || pointerRef.current.active
      let rate = tuning.localSnakeStabilizerRateNormal * (activeSteering ? 2.4 : 1.35)
      let alphaMin = activeSteering ? 0.48 : 0.28
      let alphaMax = activeSteering ? 0.86 : 0.68
      const hardUntilMs = predictionHardDampenUntilMsRef.current
      if (hardUntilMs !== null && nowMs < hardUntilMs) {
        rate = tuning.localSnakeStabilizerRateSpike * 1.9
        alphaMin = 0.22
        alphaMax = 0.62
      } else {
        predictionHardDampenUntilMsRef.current = null
        const softUntilMs = predictionSoftUntilMsRef.current
        if (softUntilMs !== null && nowMs < softUntilMs) {
          const remainingMs = softUntilMs - nowMs
          const durationMs = Math.max(1, predictionSoftDurationMsRef.current)
          const progress = clamp(1 - remainingMs / durationMs, 0, 1)
          const minRate = tuning.localSnakeStabilizerRateNormal * 1.1
          const maxRate = tuning.localSnakeStabilizerRateNormal * 2.1
          rate = minRate + (maxRate - minRate) * progress
          alphaMin = 0.24
          alphaMax = 0.78
        } else {
          predictionSoftStartAtMsRef.current = null
          predictionSoftUntilMsRef.current = null
          predictionSoftDurationMsRef.current = 0
        }
      }

      let alpha = clamp(1 - Math.exp(-Math.max(0, rate) * dt), alphaMin, alphaMax)

      const displayBeforeBlend = predictionDisplaySnakeRef.current
      const headLagBeforeBlend = angularDeltaDeg(displayBeforeBlend?.[0] ?? null, replayed.snake[0] ?? null)
      const bodyLagBeforeBlend = computeBodyLagP95Deg(displayBeforeBlend, replayed.snake)
      if (
        headLagBeforeBlend > PREDICTION_DRIFT_HEAD_THRESHOLD_DEG ||
        bodyLagBeforeBlend > PREDICTION_DRIFT_BODY_P95_THRESHOLD_DEG
      ) {
        predictionDriftConsecutiveFramesRef.current += 1
      } else {
        predictionDriftConsecutiveFramesRef.current = 0
      }
      if (
        predictionDriftConsecutiveFramesRef.current >= PREDICTION_DRIFT_CONSECUTIVE_FRAMES
      ) {
        predictionAlphaFloorUntilMsRef.current = nowMs + PREDICTION_DRIFT_ALPHA_FLOOR_MS
        predictionDriftConsecutiveFramesRef.current = 0
      }

      const alphaFloorUntil = predictionAlphaFloorUntilMsRef.current
      if (alphaFloorUntil !== null && nowMs < alphaFloorUntil) {
        alpha = Math.max(alpha, PREDICTION_DRIFT_ALPHA_FLOOR)
      } else if (alphaFloorUntil !== null) {
        predictionAlphaFloorUntilMsRef.current = null
      }

      const blendedSnake = blendPredictedSnake(
        predictionDisplaySnakeRef.current,
        replayed.snake,
        alpha,
        {
          baseAlpha: alpha,
          headResponseBoost: activeSteering ? 0.24 : 0.14,
          tailDamping: activeSteering ? 0.28 : 0.24,
          microDeadbandDeg: PREDICTION_MICRO_DEADBAND_DEG,
        },
      )
      updatePredictionPresentationMetrics(blendedSnake, replayed.snake)
      predictionDisplaySnakeRef.current = cloneSnake(blendedSnake)
      predictionAxisRef.current = replayed.axis
      localSnakeDisplayRef.current = cloneSnake(blendedSnake)
      predictionInfoRef.current = {
        ...predictionInfoRef.current,
        enabled: true,
        latestInputSeq: predictionLatestInputSeqRef.current,
        latestAckSeq: predictionLatestAckSeqRef.current,
        pendingInputCount: pendingCommands.length,
        replayedInputCountLastFrame: replayed.replayedCommandCount,
        predictionDisabledReason: 'none',
      }

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
    [
      appendPredictionEvent,
      lagSpikeActiveRef,
      lagSpikeCauseRef,
      localSnakeDisplayRef,
      netDebugInfoRef,
      netTuningRef,
      predictionDebugPerturbation,
      pointerRef,
      pushPredictionErrorSample,
      serverTickMsRef,
      updatePredictionPresentationMetrics,
    ],
  )

  return {
    appendNetLagEvent,
    buildNetLagReport,
    appendTailGrowthEvent,
    buildTailGrowthReport,
    clearNetLagEvents,
    clearTailGrowthEvents,
    getRafPerfInfo,
    clearRafPerf,
    applyNetTuningOverrides,
    enqueuePredictedInputCommand,
    resetPredictionState,
    pushSnapshot,
    getRenderSnapshot,
    stabilizeLocalSnapshot,
  }
}
