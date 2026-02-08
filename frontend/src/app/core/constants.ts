export const MAX_SNAPSHOT_BUFFER = 20
export const MAX_EXTRAPOLATION_MS = 70

export const SERVER_OFFSET_SMOOTHING = 0.12
export const NET_INTERVAL_SMOOTHING = 0.15
export const NET_JITTER_SMOOTHING = 0.12
export const NET_BASE_DELAY_TICKS = 1.85
export const NET_MIN_DELAY_TICKS = 1.8
export const NET_MAX_DELAY_TICKS = 4.6
export const NET_JITTER_DELAY_MULTIPLIER = 1.2
export const NET_JITTER_DELAY_MAX_TICKS = 0.9
export const NET_SPIKE_STALE_TICKS = 2.2
export const NET_SPIKE_INTERVAL_FACTOR = 2.1
export const NET_SPIKE_INTERVAL_MARGIN_MS = 28
export const NET_SPIKE_IMPAIRMENT_HOLD_MS = 250
export const NET_SPIKE_IMPAIRMENT_MAX_HOLD_MS = 850
export const NET_SPIKE_DELAY_BOOST_TICKS = 1.35
export const NET_DELAY_BOOST_DECAY_PER_SEC = 220
export const NET_STABLE_RECOVERY_SECS = 0.4
export const NET_SPIKE_ENTER_CONFIRM_MS = 100
export const NET_SPIKE_EXIT_CONFIRM_MS = 210
export const NET_CAMERA_RECOVERY_MS = 210
export const NET_CAMERA_SPIKE_FOLLOW_RATE = 4.8
export const MOTION_BACKWARD_DOT_THRESHOLD = 0.996
export const LOCAL_SNAKE_STABILIZER_RATE_NORMAL = 12
export const LOCAL_SNAKE_STABILIZER_RATE_SPIKE = 4.2
export const CAMERA_DISTANCE_DEFAULT = 5.2
export const CAMERA_DISTANCE_MIN = 4.2
export const CAMERA_DISTANCE_MAX = 9
export const CAMERA_ZOOM_SENSITIVITY = 0.0015
export const POINTER_MAX_RANGE_RATIO = 0.25
export const CAMERA_FOV_DEGREES = 40
export const PLANET_RADIUS = 3
export const VIEW_RADIUS_EXTRA_MARGIN = 0.08

export const BOOST_EFFECT_FADE_IN_RATE = 9
export const BOOST_EFFECT_FADE_OUT_RATE = 12
export const BOOST_EFFECT_PULSE_SPEED = 8.5
export const BOOST_EFFECT_ACTIVE_CLASS_THRESHOLD = 0.01

export const SCORE_RADIAL_FADE_IN_RATE = 10
export const SCORE_RADIAL_FADE_OUT_RATE = 8
export const SCORE_RADIAL_INTERVAL_SMOOTH_RATE = 14
export const SCORE_RADIAL_MIN_CAP_RESERVE = 1e-6
export const SCORE_RADIAL_BLOCKED_FLASH_MS = 320

export const MENU_CAMERA_DISTANCE = 7
export const MENU_CAMERA_VERTICAL_OFFSET = 2.5
export const MENU_TO_GAMEPLAY_BLEND_MS = 900
export const MENU_OVERLAY_FADE_OUT_MS = 220
export const DEATH_TO_MENU_DELAY_MS = 3000

export const REALTIME_LEADERBOARD_LIMIT = 5

export type NetTuning = {
  serverOffsetSmoothing: number
  netIntervalSmoothing: number
  netJitterSmoothing: number
  netBaseDelayTicks: number
  netMinDelayTicks: number
  netMaxDelayTicks: number
  netJitterDelayMultiplier: number
  netJitterDelayMaxTicks: number
  netSpikeStaleTicks: number
  netSpikeIntervalFactor: number
  netSpikeIntervalMarginMs: number
  netSpikeImpairmentHoldMs: number
  netSpikeImpairmentMaxHoldMs: number
  netSpikeDelayBoostTicks: number
  netDelayBoostDecayPerSec: number
  netStableRecoverySecs: number
  netSpikeEnterConfirmMs: number
  netSpikeExitConfirmMs: number
  netCameraRecoveryMs: number
  netCameraSpikeFollowRate: number
  localSnakeStabilizerRateNormal: number
  localSnakeStabilizerRateSpike: number
}

export type NetTuningOverrides = Partial<NetTuning>

export const DEFAULT_NET_TUNING: NetTuning = {
  serverOffsetSmoothing: SERVER_OFFSET_SMOOTHING,
  netIntervalSmoothing: NET_INTERVAL_SMOOTHING,
  netJitterSmoothing: NET_JITTER_SMOOTHING,
  netBaseDelayTicks: NET_BASE_DELAY_TICKS,
  netMinDelayTicks: NET_MIN_DELAY_TICKS,
  netMaxDelayTicks: NET_MAX_DELAY_TICKS,
  netJitterDelayMultiplier: NET_JITTER_DELAY_MULTIPLIER,
  netJitterDelayMaxTicks: NET_JITTER_DELAY_MAX_TICKS,
  netSpikeStaleTicks: NET_SPIKE_STALE_TICKS,
  netSpikeIntervalFactor: NET_SPIKE_INTERVAL_FACTOR,
  netSpikeIntervalMarginMs: NET_SPIKE_INTERVAL_MARGIN_MS,
  netSpikeImpairmentHoldMs: NET_SPIKE_IMPAIRMENT_HOLD_MS,
  netSpikeImpairmentMaxHoldMs: NET_SPIKE_IMPAIRMENT_MAX_HOLD_MS,
  netSpikeDelayBoostTicks: NET_SPIKE_DELAY_BOOST_TICKS,
  netDelayBoostDecayPerSec: NET_DELAY_BOOST_DECAY_PER_SEC,
  netStableRecoverySecs: NET_STABLE_RECOVERY_SECS,
  netSpikeEnterConfirmMs: NET_SPIKE_ENTER_CONFIRM_MS,
  netSpikeExitConfirmMs: NET_SPIKE_EXIT_CONFIRM_MS,
  netCameraRecoveryMs: NET_CAMERA_RECOVERY_MS,
  netCameraSpikeFollowRate: NET_CAMERA_SPIKE_FOLLOW_RATE,
  localSnakeStabilizerRateNormal: LOCAL_SNAKE_STABILIZER_RATE_NORMAL,
  localSnakeStabilizerRateSpike: LOCAL_SNAKE_STABILIZER_RATE_SPIKE,
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const withMin = (value: unknown, fallback: number, min: number) => {
  if (!isFiniteNumber(value)) return fallback
  return Math.max(min, value)
}

const withRange = (value: unknown, fallback: number, min: number, max: number) => {
  if (!isFiniteNumber(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export const resolveNetTuning = (overrides?: NetTuningOverrides | null): NetTuning => {
  const merged = {
    ...DEFAULT_NET_TUNING,
    ...(overrides ?? {}),
  }
  const netMinDelayTicks = withRange(
    merged.netMinDelayTicks,
    DEFAULT_NET_TUNING.netMinDelayTicks,
    0.5,
    20,
  )
  const netMaxDelayTicks = withRange(
    merged.netMaxDelayTicks,
    DEFAULT_NET_TUNING.netMaxDelayTicks,
    netMinDelayTicks,
    40,
  )

  return {
    serverOffsetSmoothing: withRange(
      merged.serverOffsetSmoothing,
      DEFAULT_NET_TUNING.serverOffsetSmoothing,
      0.01,
      1,
    ),
    netIntervalSmoothing: withRange(
      merged.netIntervalSmoothing,
      DEFAULT_NET_TUNING.netIntervalSmoothing,
      0.01,
      1,
    ),
    netJitterSmoothing: withRange(
      merged.netJitterSmoothing,
      DEFAULT_NET_TUNING.netJitterSmoothing,
      0.01,
      1,
    ),
    netBaseDelayTicks: withRange(
      merged.netBaseDelayTicks,
      DEFAULT_NET_TUNING.netBaseDelayTicks,
      0.5,
      30,
    ),
    netMinDelayTicks,
    netMaxDelayTicks,
    netJitterDelayMultiplier: withRange(
      merged.netJitterDelayMultiplier,
      DEFAULT_NET_TUNING.netJitterDelayMultiplier,
      0,
      20,
    ),
    netJitterDelayMaxTicks: withRange(
      merged.netJitterDelayMaxTicks,
      DEFAULT_NET_TUNING.netJitterDelayMaxTicks,
      0,
      20,
    ),
    netSpikeStaleTicks: withRange(
      merged.netSpikeStaleTicks,
      DEFAULT_NET_TUNING.netSpikeStaleTicks,
      0.5,
      20,
    ),
    netSpikeIntervalFactor: withRange(
      merged.netSpikeIntervalFactor,
      DEFAULT_NET_TUNING.netSpikeIntervalFactor,
      1,
      20,
    ),
    netSpikeIntervalMarginMs: withRange(
      merged.netSpikeIntervalMarginMs,
      DEFAULT_NET_TUNING.netSpikeIntervalMarginMs,
      0,
      2000,
    ),
    netSpikeImpairmentHoldMs: withRange(
      merged.netSpikeImpairmentHoldMs,
      DEFAULT_NET_TUNING.netSpikeImpairmentHoldMs,
      50,
      10000,
    ),
    netSpikeImpairmentMaxHoldMs: withRange(
      merged.netSpikeImpairmentMaxHoldMs,
      DEFAULT_NET_TUNING.netSpikeImpairmentMaxHoldMs,
      withMin(
        merged.netSpikeImpairmentHoldMs,
        DEFAULT_NET_TUNING.netSpikeImpairmentHoldMs,
        50,
      ),
      20000,
    ),
    netSpikeDelayBoostTicks: withRange(
      merged.netSpikeDelayBoostTicks,
      DEFAULT_NET_TUNING.netSpikeDelayBoostTicks,
      0,
      30,
    ),
    netDelayBoostDecayPerSec: withRange(
      merged.netDelayBoostDecayPerSec,
      DEFAULT_NET_TUNING.netDelayBoostDecayPerSec,
      0,
      2000,
    ),
    netStableRecoverySecs: withRange(
      merged.netStableRecoverySecs,
      DEFAULT_NET_TUNING.netStableRecoverySecs,
      0,
      10,
    ),
    netSpikeEnterConfirmMs: withRange(
      merged.netSpikeEnterConfirmMs,
      DEFAULT_NET_TUNING.netSpikeEnterConfirmMs,
      0,
      5000,
    ),
    netSpikeExitConfirmMs: withRange(
      merged.netSpikeExitConfirmMs,
      DEFAULT_NET_TUNING.netSpikeExitConfirmMs,
      0,
      5000,
    ),
    netCameraRecoveryMs: withRange(
      merged.netCameraRecoveryMs,
      DEFAULT_NET_TUNING.netCameraRecoveryMs,
      0,
      5000,
    ),
    netCameraSpikeFollowRate: withRange(
      merged.netCameraSpikeFollowRate,
      DEFAULT_NET_TUNING.netCameraSpikeFollowRate,
      0,
      40,
    ),
    localSnakeStabilizerRateNormal: withRange(
      merged.localSnakeStabilizerRateNormal,
      DEFAULT_NET_TUNING.localSnakeStabilizerRateNormal,
      0,
      60,
    ),
    localSnakeStabilizerRateSpike: withRange(
      merged.localSnakeStabilizerRateSpike,
      DEFAULT_NET_TUNING.localSnakeStabilizerRateSpike,
      0,
      60,
    ),
  }
}
