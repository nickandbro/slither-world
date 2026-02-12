import type { NetTuningOverrides } from '@app/core/constants'
import type { MenuFlowDebugInfo, MenuPhase } from '@app/core/menuCamera'
import type { MutableRefObject } from 'react'

export type LagSpikeCause = 'none' | 'stale' | 'seq-gap' | 'arrival-gap'

export type NetSmoothingDebugInfo = {
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

export type MotionStabilityDebugInfo = {
  backwardCorrectionCount: number
  minHeadDot: number
  sampleCount: number
}

export type RafPerfFrame = {
  tMs: number
  totalMs: number
  snapshotMs: number
  cameraMs: number
  renderMs: number
  hudMs: number
  debugMs: number
  tailMs: number
}

export type RafPerfInfo = {
  enabled: boolean
  thresholdMs: number
  frameCount: number
  slowFrameCount: number
  maxTotalMs: number
  lastFrame: RafPerfFrame | null
  slowFrames: RafPerfFrame[]
  lastSlowLogMs: number
}

export type NetLagEvent = {
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

export type NetLagReport = {
  generatedAtIso: string
  net: NetSmoothingDebugInfo
  motion: MotionStabilityDebugInfo
  recentEvents: NetLagEvent[]
}

export type TailGrowthEvent = {
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
  tailSegLen: number | null
  tailRefLen: number | null
  tailExtRatio: number | null
  tailExtDist: number | null
  tailEndLen: number | null
  rawSnakeLen: number | null
  rawSnakeTotalLen: number | null
  rawTailExtension: number | null
  rawLenUnits: number | null
  rawTailSegLen: number | null
  rawTailRefLen: number | null
  rawTailExtRatio: number | null
  rawTailExtDist: number | null
  rawTailEndLen: number | null
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

export type TailGrowthReport = {
  generatedAtIso: string
  enabled: boolean
  count: number
  shrinkCount: number
  stretchCount: number
  recentShrinks: TailGrowthEvent[]
  recentStretches: TailGrowthEvent[]
}

export type TailEndSample = {
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

export type TailGrowthEventInput = Omit<
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

export type RegisterAppDebugApiOptions = {
  menuDebugInfoRef: MutableRefObject<MenuFlowDebugInfo>
  netDebugInfoRef: MutableRefObject<NetSmoothingDebugInfo>
  netRxBpsRef: MutableRefObject<number>
  netRxTotalBytesRef: MutableRefObject<number>
  netRxWindowBytesRef: MutableRefObject<number>
  motionDebugInfoRef: MutableRefObject<MotionStabilityDebugInfo>
  netLagEventsRef: MutableRefObject<NetLagEvent[]>
  buildNetLagReport: () => NetLagReport
  clearNetLagEvents: () => void
  tailGrowthEventsRef: MutableRefObject<TailGrowthEvent[]>
  buildTailGrowthReport: () => TailGrowthReport
  clearTailGrowthEvents: () => void
  getNetTuningOverrides: () => NetTuningOverrides
  getResolvedNetTuning: () => Record<string, number>
  setNetTuningOverrides: (overrides: NetTuningOverrides) => {
    revision: number
    overrides: NetTuningOverrides
    resolved: Record<string, number>
  }
  resetNetTuningOverrides: () => {
    revision: number
    overrides: NetTuningOverrides
    resolved: Record<string, number>
  }
  getRafPerfInfo: () => RafPerfInfo
  clearRafPerf: () => void
}

export type AppDebugApi = {
  getMenuFlowInfo?: () => MenuFlowDebugInfo
  getNetSmoothingInfo?: () => NetSmoothingDebugInfo
  getNetTrafficInfo?: () => {
    rxBps: number
    rxTotalBytes: number
    rxWindowBytes: number
  }
  getMotionStabilityInfo?: () => MotionStabilityDebugInfo
  getNetLagEvents?: () => NetLagEvent[]
  getNetLagReport?: () => NetLagReport
  clearNetLagEvents?: () => void
  getTailGrowthEvents?: () => TailGrowthEvent[]
  getTailGrowthReport?: () => TailGrowthReport
  clearTailGrowthEvents?: () => void
  getNetTuningOverrides?: () => NetTuningOverrides
  getResolvedNetTuning?: () => Record<string, number>
  setNetTuningOverrides?: (overrides: NetTuningOverrides) => {
    revision: number
    overrides: NetTuningOverrides
    resolved: Record<string, number>
  }
  resetNetTuningOverrides?: () => {
    revision: number
    overrides: NetTuningOverrides
    resolved: Record<string, number>
  }
  getRafPerfInfo?: () => RafPerfInfo
  clearRafPerf?: () => void
}
