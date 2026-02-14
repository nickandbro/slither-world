import type { Point } from '../types'

export type PredictionDisabledReason = 'none' | 'spike' | 'dead' | 'not-ready'

export type PredictionCommand = {
  seq: number
  sentAtMs: number
  axis: Point | null
  boost: boolean
}

export type PredictionEventType =
  | 'input_enqueued'
  | 'ack_advanced'
  | 'reconcile_soft'
  | 'reconcile_hard'
  | 'queue_prune'

export type PredictionEvent = {
  id: number
  atIso: string
  tMs: number
  type: PredictionEventType
  seq: number | null
  ackSeq: number | null
  pendingInputCount: number
  replayedInputCount: number
  magnitudeDeg: number | null
  message: string
}

export type PredictionErrorStats = {
  lastDeg: number
  p95Deg: number
  maxDeg: number
}

export type PredictionLagStats = {
  lastDeg: number
  p95Deg: number
  maxDeg: number
}

export type PredictionPresentationInfo = {
  headLagDeg: PredictionLagStats
  bodyLagDeg: PredictionLagStats
  bodyMicroReversalRate: number
  sampleCount: number
  microSampleCount: number
  reversalCount: number
}

export type PredictionInfo = {
  enabled: boolean
  latestInputSeq: number | null
  latestAckSeq: number | null
  pendingInputCount: number
  replayedInputCountLastFrame: number
  predictedHeadErrorDeg: PredictionErrorStats
  correctionSoftCount: number
  correctionHardCount: number
  lastCorrectionMagnitudeDeg: number
  predictionDisabledReason: PredictionDisabledReason
}

export type PredictionReport = {
  generatedAtIso: string
  info: PredictionInfo
  recentEvents: PredictionEvent[]
}
