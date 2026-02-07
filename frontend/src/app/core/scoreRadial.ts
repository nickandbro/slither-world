export type ScoreRadialVisualState = {
  lastBoosting: boolean
  lastAlive: boolean
  capReserve: number | null
  spawnReserve: number | null
  spawnScore: number | null
  displayInterval01: number | null
  blockedFlashUntilMs: number
  blockedVisualHold: boolean
  lastIntervalPct: number
  lastDisplayScore: number
  opacity: number
  lastFrameMs: number
}

export const createInitialScoreRadialState = (): ScoreRadialVisualState => ({
  lastBoosting: false,
  lastAlive: false,
  capReserve: null,
  spawnReserve: null,
  spawnScore: null,
  displayInterval01: null,
  blockedFlashUntilMs: 0,
  blockedVisualHold: false,
  lastIntervalPct: 100,
  lastDisplayScore: 0,
  opacity: 0,
  lastFrameMs: 0,
})

export const resetScoreRadialState = (state: ScoreRadialVisualState) => {
  state.lastBoosting = false
  state.lastAlive = false
  state.capReserve = null
  state.spawnReserve = null
  state.spawnScore = null
  state.displayInterval01 = null
  state.blockedFlashUntilMs = 0
  state.blockedVisualHold = false
  state.lastIntervalPct = 100
  state.lastDisplayScore = 0
  state.opacity = 0
  state.lastFrameMs = 0
}
