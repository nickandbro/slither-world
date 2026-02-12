import { useCallback, useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { GameStateSnapshot, Point } from '@game/types'
import { clamp, lerpPoint, normalize } from '@game/math'
import { buildInterpolatedSnapshot, type TimedSnapshot } from '@game/snapshots'
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

export type UseNetRuntimeOptions = {
  netDebugEnabled: boolean
  tailDebugEnabled: boolean
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
  lagCameraRecoveryStartMsRef: MutableRefObject<number | null>
  pointerRef: MutableRefObject<{ boost: boolean }>
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
    lagCameraRecoveryStartMsRef,
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
    })
  }, [
    applyNetTuningOverrides,
    buildNetLagReport,
    buildTailGrowthReport,
    clearNetLagEvents,
    clearRafPerf,
    clearTailGrowthEvents,
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
    },
    [
      appendNetLagEvent,
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
          const t = i / lastIndex
          const tailBias = t * t
          const alphaNode = clamp(alpha + (1 - alpha) * tailBias, 0, 1)
          blendedSnake.push(normalize(lerpPoint(previousSnake[i]!, incomingSnake[i]!, alphaNode)))
        } else {
          blendedSnake.push(normalize(incomingSnake[i]!))
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
    [
      delayBoostMsRef,
      lagCameraHoldActiveRef,
      lagCameraRecoveryStartMsRef,
      lagSpikeActiveRef,
      lagSpikeCauseRef,
      localSnakeDisplayRef,
      netTuningRef,
      serverTickMsRef,
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
    pushSnapshot,
    getRenderSnapshot,
    stabilizeLocalSnapshot,
  }
}
